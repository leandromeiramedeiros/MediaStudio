"""Media Studio server: the web app, a JSON API over the engines, live updates over SSE. Local only (127.0.0.1).

  python server.py [--open] [--port 8095]

--open opens the app window (Chrome --app) and, when a server already runs, only that. The server exits after
15 minutes with no window open and no job running. Started without a console by MediaStudio.vbs.
"""
import ctypes
import hashlib
import json
import mimetypes
import os
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from studio import agent, comfy, media, orchestrate, qwen, resources
from studio.jobs import Job, JobError, write_sidecar
from studio.paths import CACHE_DIR, DATA, KINDS, LIBRARY, NO_WINDOW, ROOT, WEB, ensure_dirs

PORT = 8095
IDLE_EXIT_S = 900
SETTINGS = os.path.join(DATA, "settings.json")
THUMBS = os.path.join(CACHE_DIR, "thumbs")
PROXIES = os.path.join(CACHE_DIR, "proxies")
UPLOADS = os.path.join(CACHE_DIR, "uploads")
FOLDER_STATE = ".mediastudio.json"
MEDIA_KINDS = ("video", "image", "gif", "audio", "svg")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff2", ".woff2")


# ---------- live updates ----------

class Hub:
    """SSE clients, each with its own queue. The resource sampler runs only while someone listens."""

    def __init__(self):
        self.clients, self.lock = set(), threading.Lock()
        self.last_client = time.time()
        self.history = []  # [at, cpu, gpu, vram, ram] for the sparklines, 5 minutes
        self.snap = None

    def add(self):
        q = queue.Queue(maxsize=500)
        with self.lock:
            self.clients.add(q)
        if self.snap:
            q.put(("snapshot", self.snap))
        return q

    def drop(self, q):
        with self.lock:
            self.clients.discard(q)
            self.last_client = time.time()

    def send(self, kind, data):
        with self.lock:
            for q in list(self.clients):
                try:
                    q.put_nowait((kind, data))
                except queue.Full:
                    pass

    def sampler(self):
        while True:
            if not self.clients:
                time.sleep(1)
                continue
            try:
                s = resources.snapshot()
                g = s.get("gpu") or {}
                self.history.append([s["at"], s["cpu"]["pct"], g.get("util") or 0, g.get("vramUsed") or 0, s["ram"]["used"]])
                self.history = [h for h in self.history if h[0] > s["at"] - 300_000]
                s["history"] = self.history
                s["running"] = RUNNER.active()
                self.snap = s
                self.send("snapshot", s)
                busy = any(j["status"] in ("loading", "running") for j in s["jobs"]) or s["comfy"]["running"] or s["qwen"]["busy"]
            except Exception:
                traceback.print_exc()
                busy = False
            time.sleep(0.6 if busy else 4.5)  # the snapshot itself takes ~0.4 s


HUB = Hub()


# ---------- jobs ----------

class Runner:
    """Runs jobs on threads. One GPU: jobs of one runtime may overlap (qwen has 2 slots, ComfyUI queues),
    jobs of different runtimes wait; ffmpeg jobs need no GPU and never wait."""

    def __init__(self):
        self.jobs = {}
        self.cond = threading.Condition()
        self.runtime, self.count = None, 0

    def active(self):
        return [j for j, job in self.jobs.items() if job.data["status"] in ("loading", "running", "queued")]

    def _acquire(self, rt, job):
        if rt is None:
            return
        with self.cond:
            while self.runtime not in (None, rt):
                job.update(status="queued")
                self.cond.wait(1)
                if job.cancelled.is_set():
                    job.fail("cancelled", 130, status="cancelled")
            self.runtime, self.count = rt, self.count + 1

    def _release(self, rt):
        if rt is None:
            return
        with self.cond:
            self.count -= 1
            if not self.count:
                self.runtime = None
            self.cond.notify_all()

    def start(self, job, rt, fn):
        self.jobs[job.id] = job
        job.update(status="queued")

        def go():
            try:
                self._acquire(rt, job)
                try:
                    fn(job)
                finally:
                    self._release(rt)
            except JobError as e:
                if job.data["status"] not in ("error", "cancelled"):
                    job.update(status="error", error=str(e), ended=time.time())
            except Exception as e:
                traceback.print_exc()
                job.update(status="error", error=f"{type(e).__name__}: {e}", ended=time.time())
            HUB.send("job", job.data)

        threading.Thread(target=go, daemon=True).start()
        HUB.send("job", job.data)
        return job.id

    def cancel(self, jid):
        job = self.jobs.get(jid)
        if job:
            job.cancel()
        return bool(job)


RUNNER = Runner()


# ---------- settings, folders, thumbnails ----------

def load_settings():
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_settings(s):
    with open(SETTINGS, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)


def remember_folder(d):
    s = load_settings()
    s["recent"] = [d] + [x for x in s.get("recent", []) if x.lower() != d.lower()][:11]
    save_settings(s)


def cache_key(path):
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path).lower()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:20]


def thumb_for(path):
    out = os.path.join(THUMBS, cache_key(path) + ".jpg")
    if not os.path.exists(out):
        media.poster(path, out)
    return out


class ProxyQueue:
    """Scrub proxies made one at a time in the background (ffmpeg is CPU heavy); newest request first."""

    def __init__(self):
        self.q, self.pending, self.lock = [], set(), threading.Lock()
        threading.Thread(target=self.loop, daemon=True).start()

    def path(self, src):
        return os.path.join(PROXIES, cache_key(src) + ".mp4")

    def want(self, src):
        p = self.path(src)
        if os.path.exists(p):
            return p
        with self.lock:
            if src not in self.pending:
                self.pending.add(src)
                self.q.append(src)
        return None

    def loop(self):
        while True:
            with self.lock:
                src = self.q.pop() if self.q else None
            if not src:
                time.sleep(0.5)
                continue
            try:
                media.proxy(src, self.path(src))
                HUB.send("proxy", {"src": src})
            except Exception as e:
                HUB.send("proxy", {"src": src, "error": str(e)})
            with self.lock:
                self.pending.discard(src)


PROXY = ProxyQueue()
_probe_cache = {}


def probe_cached(path):
    k = cache_key(path)
    if k not in _probe_cache:
        try:
            _probe_cache[k] = media.probe(path)
        except Exception:
            _probe_cache[k] = {"dur": 0, "w": None, "h": None, "fps": 0, "audio": False}
    return _probe_cache[k]


def safe_name(name):
    name = re.sub(r'[<>:"|?*\x00-\x1f]', "_", name).strip().strip(".")
    parts = [p for p in re.split(r"[\\/]+", name) if p not in ("", ".", "..")]
    if not parts:
        raise JobError("bad file name", 2)
    return os.path.join(*parts)


def library_items(kind=None):
    items = []
    for k in KINDS:
        if kind and k != kind:
            continue
        d = os.path.join(LIBRARY, k)
        if not os.path.isdir(d):
            continue
        for e in os.scandir(d):
            if not e.is_file() or e.name.endswith((".part.mp4", ".tmp")):
                continue
            stem, ext = os.path.splitext(e.name)
            meta = {}
            if k == "projects":
                if ext != ".json":
                    continue
                try:
                    with open(e.path, encoding="utf-8") as f:
                        pj = json.load(f)
                    meta = {"prompt": pj.get("title", ""), "kind": "projects"}
                except (OSError, ValueError):
                    pass
            else:
                if ext == ".json":
                    continue
                try:
                    with open(os.path.join(d, stem + ".json"), encoding="utf-8") as f:
                        meta = json.load(f)
                except (OSError, ValueError):
                    pass
            st = e.stat()
            items.append({"path": e.path, "name": e.name, "kind": k, "media": media.kind_of(e.path) or ("project" if k == "projects" else "text"),
                          "size": st.st_size, "mtime": st.st_mtime, "meta": meta})
    items.sort(key=lambda x: -x["mtime"])
    return items


class _FileOp(ctypes.Structure):
    _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
                ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL), ("hNameMappings", ctypes.c_void_p),
                ("lpszProgressTitle", wintypes.LPCWSTR)]


def recycle(path):
    """Send to the Recycle Bin (never a hard delete). SHFileOperationW: in-process, no PowerShell start-up."""
    path = os.path.abspath(path)
    if not os.path.exists(path):
        return
    # FO_DELETE, FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI; pFrom is double-NUL terminated
    op = _FileOp(None, 3, path + "\0", None, 0x40 | 0x10 | 0x04 | 0x400, False, None, None)
    rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if rc or op.fAnyOperationsAborted:
        raise JobError(f"could not recycle {os.path.basename(path)} (code {rc})", 2)


def open_window(url):
    chrome = [os.path.join(os.environ.get(v, ""), "Google", "Chrome", "Application", "chrome.exe")
              for v in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA")]
    edge = [os.path.join(os.environ.get(v, ""), "Microsoft", "Edge", "Application", "msedge.exe") for v in ("PROGRAMFILES(X86)", "PROGRAMFILES")]
    for exe in chrome + edge:
        if os.path.isfile(exe):
            subprocess.Popen([exe, f"--app={url}", "--window-size=1600,1000"], creationflags=NO_WINDOW)
            return
    os.startfile(url)


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MediaStudio"

    def log_message(self, fmt, *args):
        pass

    # guards: DNS rebinding (Host) and cross-site POSTs (custom header forces a CORS preflight nobody answers)
    def _host_ok(self):
        host = (self.headers.get("Host") or "").split(":")[0]
        return host in ("127.0.0.1", "localhost")

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _err(self, msg, code=400):
        self._json({"error": msg}, code)

    def _body(self):
        if getattr(self, "_raw", None) is None:
            n = int(self.headers.get("Content-Length") or 0)
            self._raw = self.rfile.read(n) if n else b""
        return self._raw

    def _file(self, path, ctype=None, cache=False):
        if not os.path.isfile(path):
            return self._err("not found", 404)
        size = os.path.getsize(path)
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "")
        if m and size:
            if m[1]:
                start = int(m[1])
                end = int(m[2]) if m[2] else size - 1
            else:
                start = max(0, size - int(m[2]))
            end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1 if size else 0))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-cache")
        self.end_headers()
        if self.command == "HEAD" or not size:
            return
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            try:
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
            except (ConnectionError, OSError):
                pass

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._host_ok():
            return self._err("forbidden", 403)
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            if u.path == "/":
                return self._file(os.path.join(WEB, "index.html"))
            if u.path.startswith("/web/"):
                p = os.path.normpath(os.path.join(WEB, urllib.parse.unquote(u.path[5:])))
                if not p.startswith(WEB):
                    return self._err("forbidden", 403)
                return self._file(p, cache=p.endswith(".woff2"))
            route = GET_ROUTES.get(u.path)
            if not route:
                return self._err("not found", 404)
            return route(self, q)
        except JobError as e:
            return self._err(str(e), 400)
        except (ConnectionError, BrokenPipeError):
            pass
        except Exception as e:
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)

    def do_POST(self):
        # read the body up front: a handler that ignores it would leave it in the keep-alive socket,
        # where it prefixes the next request line ('{}GET ...' -> 501)
        self._raw = None
        self._body()
        if not self._host_ok() or self.headers.get("X-Studio") != "1":
            return self._err("forbidden", 403)
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        try:
            route = POST_ROUTES.get(u.path)
            if not route:
                return self._err("not found", 404)
            return route(self, q)
        except JobError as e:
            return self._err(str(e), 400)
        except Exception as e:
            traceback.print_exc()
            return self._err(f"{type(e).__name__}: {e}", 500)


def body_json(h):
    raw = h._body()
    return json.loads(raw) if raw else {}


# GET routes
def g_ping(h, q):
    h._json({"ok": True, "app": "MediaStudio"})


def g_events(h, q):
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream")
    h.send_header("Cache-Control", "no-store")
    h.send_header("Connection", "keep-alive")
    h.end_headers()
    cq = HUB.add()
    try:
        h.wfile.write(b": hi\n\n")
        h.wfile.flush()
        while True:
            try:
                kind, data = cq.get(timeout=15)
                h.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode("utf-8"))
            except queue.Empty:
                h.wfile.write(b": ping\n\n")
            h.wfile.flush()
    except (ConnectionError, OSError):
        pass
    finally:
        HUB.drop(cq)
        h.close_connection = True


def g_file(h, q):
    return h._file(q["path"])


def g_thumb(h, q):
    return h._file(thumb_for(q["path"]), "image/jpeg", cache=True)


def g_proxy(h, q):
    p = PROXY.want(q["path"])
    if not p:
        return h._json({"pending": True}, 202)
    return h._file(p, "video/mp4", cache=True)


def g_presets(h, q):
    h._json({"qwen": {k: {"label": v["label"], "kind": v["kind"], "maxTokens": v["max_tokens"]} for k, v in qwen.PRESETS.items()},
             "maxCtx": qwen.MAX_CTX,
             "comfy": {k: {"label": v["label"], "kind": v["kind"], "params": v["params"], "needsImage": v.get("needs_image", False),
                           "fields": v["fields"], "effort": v.get("effort", {}), "note": v.get("note"), "tag": v["tag"]}
                       for k, v in comfy.PRESETS.items()},
             "qwenEffort": qwen.EFFORT,
             "kinds": KINDS})


def g_speakers(h, q):
    h._json({"speakers": comfy.speakers()})


def g_online(h, q):
    from studio import web
    h._json({"online": web.online()})


def g_jobs(h, q):
    h._json({"jobs": resources.jobs(int(q.get("limit", 80)))})


def g_job(h, q):
    job = RUNNER.jobs.get(q["id"])
    if job:
        return h._json(job.data)
    p = os.path.join(DATA, "jobs", q["id"] + ".json")
    return h._file(p, "application/json")


def g_library(h, q):
    h._json({"items": library_items(q.get("kind"))})


def g_probe(h, q):
    k = media.kind_of(q["path"])
    info = probe_cached(q["path"]) if k in ("video", "gif", "audio") else {}
    h._json({"kind": k, **info})


def g_project(h, q):
    with open(q["path"], encoding="utf-8") as f:
        h._json({"path": q["path"], "project": json.load(f)})


def g_text(h, q):
    with open(q["path"], encoding="utf-8", errors="replace") as f:
        h._json({"text": f.read()})


def g_drives(h, q):
    import string
    drives = [f"{d}:\\" for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]
    home = os.path.expanduser("~")
    places = [p for p in (os.path.join(home, "Videos"), os.path.join(home, "Pictures"), os.path.join(home, "Desktop"),
                          os.path.join(home, "Downloads"), LIBRARY) if os.path.isdir(p)]
    h._json({"drives": drives, "places": places, "recent": [r for r in load_settings().get("recent", []) if os.path.isdir(r)]})


def g_dir(h, q):
    d = q["dir"]
    if not os.path.isdir(d):
        raise JobError("not a folder", 2)
    dirs, files = [], []
    for e in os.scandir(d):
        try:
            if e.name.startswith((".", "$")):
                continue
            if e.is_dir():
                dirs.append(e.name)
            elif media.kind_of(e.name) in MEDIA_KINDS:
                files.append(e.name)
        except OSError:
            pass
    h._json({"dir": os.path.abspath(d), "parent": os.path.dirname(os.path.abspath(d)), "dirs": sorted(dirs, key=str.lower),
             "media": len(files)})


def g_folder(h, q):
    """A capture folder: its videos and images (newest first) with probe info, and its saved review state."""
    d = os.path.abspath(q["dir"])
    if not os.path.isdir(d):
        raise JobError("not a folder", 2)
    remember_folder(d)
    items = []
    for e in os.scandir(d):
        k = media.kind_of(e.name)
        if not e.is_file() or k not in ("video", "image", "gif"):
            continue
        st = e.stat()
        info = probe_cached(e.path) if k in ("video", "gif") else {}
        items.append({"name": e.name, "path": e.path, "kind": k, "size": st.st_size, "mtime": st.st_mtime, **info,
                      "proxy": os.path.exists(PROXY.path(e.path)) if k == "video" else None})
    items.sort(key=lambda x: x["mtime"])
    state = {}
    try:
        with open(os.path.join(d, FOLDER_STATE), encoding="utf-8") as f:
            state = json.load(f)
    except (OSError, ValueError):
        pass
    h._json({"dir": d, "items": items, "state": state})


GET_ROUTES = {"/api/ping": g_ping, "/api/events": g_events, "/api/file": g_file, "/api/thumb": g_thumb, "/api/proxy": g_proxy,
              "/api/presets": g_presets, "/api/speakers": g_speakers, "/api/online": g_online, "/api/jobs": g_jobs,
              "/api/job": g_job, "/api/library": g_library, "/api/text": g_text, "/api/probe": g_probe, "/api/project": g_project, "/api/drives": g_drives, "/api/dir": g_dir,
              "/api/folder": g_folder}


# POST routes
def p_qwen(h, q):
    b = body_json(h)
    p = qwen.PRESETS.get(b.get("preset"))
    if not p:
        raise JobError("unknown preset", 2)
    job = Job(b["preset"], qwen.MODEL_KEY, qwen.MODEL_TAG, b.get("prompt") or "image")

    def fn(job):
        qwen.run(b["preset"], b.get("prompt", ""), b.get("material", ""), b.get("images") or [], think=bool(b.get("think")),
                 force=bool(b.get("force")), seed=int(b.get("seed") or qwen.DEFAULT_SEED), online=bool(b.get("online")),
                 max_tokens=int(b["max_tokens"]) if b.get("max_tokens") else None, effort=int(b.get("effort") or 3), job=job,
                 on_text=lambda t: HUB.send("text", {"id": job.id, "t": t}))
    h._json({"id": RUNNER.start(job, "qwen", fn)})


def p_comfy(h, q):
    b = body_json(h)
    p = comfy.PRESETS.get(b.get("preset"))
    if not p:
        raise JobError("unknown preset", 2)
    seed = int(b["seed"]) if b.get("seed") not in (None, "") else comfy.new_seed()
    job = Job(b["preset"], p["model"], "comfyui", b.get("prompt", ""))
    job.update(seed=seed)
    h._json({"id": RUNNER.start(job, "comfy", lambda job: comfy.run(b["preset"], b.get("prompt", ""), b.get("params") or {},
                                                                    seed=seed, force=bool(b.get("force")), effort=int(b.get("effort") or 3),
                                                                    job=job)), "seed": seed})


def p_orchestrate(h, q):
    b = body_json(h)
    job = Job("orchestrate", "director", "qwen + comfyui + ffmpeg", b.get("request", ""))

    def fn(job):
        orchestrate.run(b.get("request", ""), b.get("images") or [], seed=int(b.get("seed") or 42), animate=bool(b.get("animate")),
                        aspect=b.get("aspect") or "16:9", music=b.get("music", True), effort=int(b.get("effort") or 2),
                        force=bool(b.get("force")), job=job)
    h._json({"id": RUNNER.start(job, "director", fn)})


def p_render(h, q):
    b = body_json(h)
    project = b["project"]
    job = Job("render", "ffmpeg", "ffmpeg", project.get("title") or "timeline")

    def fn(job):
        media.render(project, job=job)
        if b.get("gif"):
            media.nexus_gif(job.data["output"])
    h._json({"id": RUNNER.start(job, None, fn)})


def p_gif(h, q):
    b = body_json(h)
    job = Job("gif", "ffmpeg", "ffmpeg", os.path.basename(b["src"]))
    out = None
    if b.get("dir") and b.get("name"):  # straight into a capture folder (Review) instead of the library
        out = os.path.join(os.path.abspath(b["dir"]), safe_name(b["name"]))
    h._json({"id": RUNNER.start(job, None, lambda job: media.nexus_gif(b["src"], out=out, start=float(b.get("start") or 0),
                                                                       end=float(b["end"]) if b.get("end") else None, job=job))})


def p_cancel(h, q):
    h._json({"ok": RUNNER.cancel(body_json(h).get("id"))})


def p_runtime(h, q):
    b = body_json(h)
    mod = qwen if b.get("name") == "qwen" else comfy
    if b.get("action") == "stop":
        mod.stop()
        return h._json({"ok": True})
    job = Job("start", "qwen" if mod is qwen else "comfy", "runtime", f"start {b.get('name')}")
    h._json({"id": RUNNER.start(job, "qwen" if mod is qwen else "comfy",
                                lambda job: job.update(status="done", load_s=mod.start(), progress=1.0, ended=time.time()))})


def p_folder_state(h, q):
    d = os.path.abspath(q["dir"])
    raw = h._body()
    json.loads(raw)  # must be JSON
    tmp = os.path.join(d, FOLDER_STATE + ".tmp")
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, os.path.join(d, FOLDER_STATE))
    h._json({"ok": True})


def p_folder_write(h, q):
    """Write a file the app made (GIF, JPEG) into a folder: no download dialog."""
    d = os.path.abspath(q["dir"])
    out = os.path.join(d, safe_name(q["name"]))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(h._body())
    h._json({"path": out, "size": os.path.getsize(out)})


def p_library_save(h, q):
    """Save bytes the app made (editor export, imported file, rasterized SVG) into the library with a sidecar."""
    kind = q.get("kind", "image")
    if kind not in KINDS:
        raise JobError("unknown kind", 2)
    name = safe_name(os.path.basename(q.get("name") or "file.bin"))
    stem, ext = os.path.splitext(name)
    out = os.path.join(LIBRARY, kind, f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}{ext}")
    with open(out, "wb") as f:
        f.write(h._body())
    if kind != "projects":
        write_sidecar(out, {"kind": kind, "engine": q.get("source", "import"), "preset": q.get("source", "import"), "model": "",
                            "prompt": q.get("note", ""), "params": {}})
    h._json({"path": out})


def p_project_save(h, q):
    b = body_json(h)
    path = b.get("path")
    if not path or not os.path.abspath(path).startswith(os.path.join(LIBRARY, "projects")):
        path = os.path.join(LIBRARY, "projects", time.strftime("%Y%m%d-%H%M%S") + "-" + re.sub(r"\W+", "-", b["project"].get("title") or "project")[:40] + ".json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(b["project"], f, indent=1)
    h._json({"path": path})


def p_upload(h, q):
    """Temporary file for a render (an SVG the app rasterized to PNG)."""
    raw = h._body()
    ext = re.sub(r"[^a-z0-9]", "", q.get("ext", "png").lower())[:5] or "bin"
    os.makedirs(UPLOADS, exist_ok=True)
    out = os.path.join(UPLOADS, hashlib.sha1(raw).hexdigest()[:20] + "." + ext)
    with open(out, "wb") as f:
        f.write(raw)
    h._json({"path": out})


def p_reveal(h, q):
    p = body_json(h)["path"]
    subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
    h._json({"ok": True})


def p_open(h, q):
    os.startfile(os.path.normpath(body_json(h)["path"]))
    h._json({"ok": True})


def p_delete(h, q):
    p = os.path.abspath(body_json(h)["path"])
    if not p.startswith(LIBRARY + os.sep):
        raise JobError("only library files can be deleted here", 2)
    side = os.path.splitext(p)[0] + ".json"
    recycle(p)
    if os.path.exists(side) and side != p:
        recycle(side)
    h._json({"ok": True})


def p_settings(h, q):
    s = load_settings()
    s.update(body_json(h))
    save_settings(s)
    h._json(s)


def g_agent_sessions(h, q):
    h._json({"sessions": agent.sessions()})


def g_agent_session(h, q):
    h._json(agent.load(q["id"]))


def p_agent_new(h, q):
    h._json(agent.new_session())


def p_agent_send(h, q):
    b = body_json(h)
    sid = b["sid"]
    job = Job("agent", "qwen", qwen.MODEL_TAG, b.get("text", ""), sid=sid)

    def fn(job):
        agent.turn(sid, b.get("text", ""), b.get("images") or [], b.get("files") or [], think=bool(b.get("think")),
                   online=bool(b.get("online")), effort=int(b.get("effort") or 3), force=bool(b.get("force")), job=job,
                   send=lambda ev: HUB.send("agent", ev))
    h._json({"id": RUNNER.start(job, "director", fn)})


def p_agent_file(h, q):
    b = body_json(h)
    f = agent.decide_file(b["sid"], b["pid"], b["action"], b.get("folder"))
    HUB.send("agent", {"sid": b["sid"], "type": "file_decision", "pid": b["pid"], "status": f["status"], "path": f.get("path")})
    h._json(f)


def p_agent_delete(h, q):
    recycle(agent.path_of(body_json(h)["sid"]))
    h._json({"ok": True})


GET_ROUTES.update({"/api/agent/sessions": g_agent_sessions, "/api/agent/session": g_agent_session})

POST_ROUTES = {"/api/agent/new": p_agent_new, "/api/agent/send": p_agent_send, "/api/agent/file": p_agent_file,
               "/api/agent/delete": p_agent_delete,"/api/qwen": p_qwen, "/api/comfy": p_comfy, "/api/orchestrate": p_orchestrate, "/api/render": p_render,
               "/api/gif": p_gif, "/api/cancel": p_cancel, "/api/runtime": p_runtime, "/api/folder/state": p_folder_state,
               "/api/folder/write": p_folder_write, "/api/library/save": p_library_save, "/api/project/save": p_project_save,
               "/api/upload": p_upload, "/api/reveal": p_reveal, "/api/open": p_open, "/api/delete": p_delete,
               "/api/settings": p_settings}


def already_running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1) as r:
            return json.loads(r.read()).get("app") == "MediaStudio"
    except Exception:
        return False


def idle_exit():
    while True:
        time.sleep(30)
        if not HUB.clients and not RUNNER.active() and time.time() - HUB.last_client > IDLE_EXIT_S:
            os._exit(0)


def main():
    port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PORT
    url = f"http://127.0.0.1:{port}/"
    if already_running(port):
        if "--open" in sys.argv:
            open_window(url)
        return
    ensure_dirs()
    for d in (THUMBS, PROXIES, UPLOADS):
        os.makedirs(d, exist_ok=True)
    if sys.stdout is None or "pythonw" in sys.executable.lower():  # no console: log to a file
        log = open(os.path.join(DATA, "logs", "server.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stderr = log
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=HUB.sampler, daemon=True).start()
    threading.Thread(target=idle_exit, daemon=True).start()
    print(f"Media Studio on {url} (root {ROOT})", flush=True)
    if "--open" in sys.argv:
        open_window(url)
    srv.serve_forever()


if __name__ == "__main__":
    main()
