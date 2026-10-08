"""Online extras for qwen: web search and page fetch, offered as tools only when the internet answers.
Everything else in the app works without them."""
import html
import re
import socket
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
_online = {"at": 0.0, "ok": False}

TOOLS = [
    {"type": "function", "function": {
        "name": "web_search", "description": "Search the web. Returns titles, URLs and snippets of the top results.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    {"type": "function", "function": {
        "name": "fetch_url", "description": "Fetch a web page and return its readable text (first 12000 characters).",
        "parameters": {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]}}},
]


def online():
    """True when the internet answers; cached 30 s."""
    if time.time() - _online["at"] < 30:
        return _online["ok"]
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=1.5).close()
        ok = True
    except OSError:
        ok = False
    _online.update(at=time.time(), ok=ok)
    return ok


def _get(url, data=None):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", "replace")


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "nav", "footer", "header", "form"}

    def __init__(self):
        super().__init__()
        self.out, self.depth = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.depth += 1
        elif tag in ("p", "br", "li", "h1", "h2", "h3", "h4", "tr", "div"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if not self.depth:
            self.out.append(data)


def search(query, n=8):
    page = _get("https://html.duckduckgo.com/html/", urllib.parse.urlencode({"q": query}).encode())
    rows = []
    for m in re.finditer(r'class="result__a" href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', page, re.S):
        href = html.unescape(m[1])
        q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        href = q.get("uddg", [href])[0]
        strip = lambda s: html.unescape(re.sub(r"<[^>]+>", "", s)).strip()  # noqa: E731
        rows.append(f"{strip(m[2])}\n{href}\n{strip(m[3])}")
        if len(rows) >= n:
            break
    return "\n\n".join(rows) or "no results"


def fetch(url, limit=12000):
    if not url.startswith(("http://", "https://")):
        return "only http(s) URLs"
    p = _Text()
    p.feed(_get(url))
    text = re.sub(r"[ \t]+", " ", "".join(p.out))
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    return text[:limit]


def call(name, args):
    try:
        if name == "web_search":
            return search(args.get("query", ""))
        if name == "fetch_url":
            return fetch(args.get("url", ""))
        return f"unknown tool {name}"
    except Exception as e:
        return f"{name} failed: {type(e).__name__}: {e}"
