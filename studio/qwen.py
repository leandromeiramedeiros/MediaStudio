"""Text and image jobs on the local Qwen3.8-27B (llama.cpp's llama-server). Text and images in, text out.

Runtime: ~/AI/llama.cpp/llama-server.exe (official CUDA 13 build) on port 8091, started on demand with
~/AI/models/llm/Qwen3.8-27B-UD-IQ4_XS.gguf and its vision projector: whole model on the GPU, 32k context shared by
2 slots, q4 KV cache, about 53 tok/s. A detached watchdog stops it after 10 idle minutes or when DD2 starts.
Deterministic: temperature 0 and a fixed seed, so the same input gives the same answer. Offline by default; with
online=True and a working connection it may also search the web and fetch pages (studio/web.py).
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from . import web
from .jobs import Job, JobError, PeakVram, dd2_running, output_path, prune_jobs, runtime_ram_gb, spawn, write_sidecar
from .paths import CACHE_DIR, INBOX_DIR, LLAMA_SERVER, NO_WINDOW, QWEN_MODEL, QWEN_PROJ, ROOT

PORT = 8091
URL = f"http://127.0.0.1:{PORT}"
# Measured on the RTX 5070 Ti (16 GB): anything that spills past VRAM (q8 KV at 32k, 48k+ context, MTP drafting,
# 3+ slots) falls to Windows' shared-memory fallback and runs at 2-18 tok/s instead of 53.
ARGS = ["-ngl", "999", "-fa", "on", "-c", "32768", "-ctk", "q4_0", "-ctv", "q4_0", "--parallel", "2", "-kvu", "--jinja"]
MAX_TOOL_ROUNDS = 4  # online jobs: searches/fetches before qwen must answer
# Faster (1) .. Better (5): (thinking, answer budget as a multiple of the preset's; None = the whole context).
# Benchmarked: thinking gives the same draft quality in 3x the time, so it starts at 4.
EFFORT = [(False, 1), (False, 2), (False, 4), (True, 4), (True, None)]
IDLE_S = 600
MAX_CTX = 32768
MODEL_KEY = "qwen"
MODEL_TAG = "Qwen3.8-27B UD-IQ4_XS (llama-server)"
DEFAULT_SEED = 42

PRESETS = {
    "describe": {
        "label": "Describe image", "max_tokens": 1000, "kind": "text",
        "system": "You describe images (often video game screenshots) for a developer. "
                  "Quote all visible text verbatim. List UI elements, menus, overlays and anything that "
                  "looks broken, misplaced or unusual. At most 15 lines. No preamble.",
    },
    "svg": {
        "label": "SVG", "max_tokens": 6000, "kind": "svg",
        "system": "You output exactly one valid standalone SVG document and nothing else: "
                  "no prose, no code fences. Include xmlns and a viewBox. Prefer simple paths and flat colors.",
    },
    "draft": {
        "label": "Draft text", "max_tokens": 2500, "kind": "text",
        "system": "You write the requested text and output only that text, ready to paste. No preamble.",
    },
    "digest": {
        "label": "Digest", "max_tokens": 1500, "kind": "text",
        "system": "You summarize logs and tool output for a senior developer who will not read the original. "
                  "Copy every error, exception, warning, file:line, type and method name verbatim. "
                  "Collapse repeated lines into one with a count. Keep chronological order. "
                  "At most 30 lines. No advice, no speculation, no preamble.",
    },
    "raw": {"label": "Raw", "max_tokens": 4000, "kind": "text", "system": ""},
}


def up():
    try:
        with urllib.request.urlopen(URL + "/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def pids():
    try:
        import psutil
    except ImportError:
        return []
    found = []
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower().startswith("llama-server") and str(PORT) in (p.info["cmdline"] or []):
                found.append(p.pid)
        except (psutil.Error, TypeError):
            pass
    return found


def stop():
    """Kill the qwen server (frees its VRAM at once)."""
    for pid in pids():
        subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True, creationflags=NO_WINDOW)


def start():
    """Start the server unless it is up; returns the seconds spent loading (0 when it was already up)."""
    if up():
        return 0.0
    from . import comfy  # one GPU: qwen needs 15.4 of 16 GB
    t0 = time.time()
    for f in (LLAMA_SERVER, QWEN_MODEL, QWEN_PROJ):
        if not os.path.isfile(f):
            raise JobError(f"missing {f}", 4)
    comfy.free_for_qwen()
    os.makedirs(CACHE_DIR, exist_ok=True)
    if not pids():
        spawn([LLAMA_SERVER, "-m", QWEN_MODEL, "--mmproj", QWEN_PROJ, "--port", str(PORT), *ARGS],
              os.path.join(CACHE_DIR, "qwen-server.log"))
        spawn([sys.executable, "-m", "studio.cli", "watch", "qwen"], cwd=ROOT)
    while time.time() - t0 < 180:
        if up():
            return round(time.time() - t0, 1)
        time.sleep(1)
    raise JobError(f"qwen server did not start in 180 s; see {os.path.join(CACHE_DIR, 'qwen-server.log')}", 4)


def watch():
    """Detached: stop the server after IDLE_S without a request, or as soon as DD2 starts."""
    last = time.time()
    while pids():
        time.sleep(15)
        if dd2_running():
            break
        try:
            with urllib.request.urlopen(URL + "/slots", timeout=5) as r:
                if any(s.get("is_processing") for s in json.loads(r.read())):
                    last = time.time()
        except Exception:
            pass
        if time.time() - last > IDLE_S:
            break
    stop()


def read_clipboard():
    """Returns ("image", path) or ("text", str). Windows PowerShell; clipboard access needs -STA."""
    os.makedirs(INBOX_DIR, exist_ok=True)
    path = os.path.join(INBOX_DIR, time.strftime("clip-%Y%m%d-%H%M%S.png"))
    script = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; "
              "$i=[Windows.Forms.Clipboard]::GetImage(); "
              f"if ($i) {{ $i.Save('{path}', [Drawing.Imaging.ImageFormat]::Png); 'IMAGE' }} "
              "else { 'TEXT'; [Windows.Forms.Clipboard]::GetText() }")
    out = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True, text=True,
                         encoding="utf-8", timeout=20, creationflags=NO_WINDOW).stdout
    kind, _, rest = out.partition("\n")
    if kind.strip() == "IMAGE":
        return "image", path
    if not rest.strip():
        raise JobError("clipboard is empty", 2)
    return "text", rest


def _stream(request, job, p, answer, on_text):
    """One streamed completion. Appends content to answer; returns (tool_calls or [], finish_reason)."""
    req = urllib.request.Request(URL + "/v1/chat/completions", data=json.dumps(request).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    calls, finish = {}, None
    with urllib.request.urlopen(req, timeout=1800) as resp:
        for line in resp:
            if job.cancelled.is_set():
                job.fail("cancelled", 130, status="cancelled")
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            data = line[5:].strip()
            if data == b"[DONE]":
                break
            chunk = json.loads(data)
            if chunk.get("error"):
                raise RuntimeError(chunk["error"])
            if chunk.get("timings"):
                job.data["_timings"] = chunk["timings"]
            for c in chunk.get("choices") or []:
                d = c.get("delta") or {}
                if d.get("content") or d.get("reasoning_content") or d.get("tool_calls"):
                    job.data["status"] = "running"
                    job.data["tokens"] += 1
                    if d.get("content"):
                        answer.append(d["content"])
                        if on_text:
                            on_text(d["content"])
                for tc in d.get("tool_calls") or []:
                    slot = calls.setdefault(tc.get("index", 0), {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    slot["id"] = tc.get("id") or slot["id"]
                    fn = tc.get("function") or {}
                    slot["function"]["name"] += fn.get("name") or ""
                    slot["function"]["arguments"] += fn.get("arguments") or ""
                finish = c.get("finish_reason") or finish
            job.update(throttle=True, progress=min(0.99, job.data["tokens"] / p["max_tokens"]))
    return [calls[i] for i in sorted(calls)], finish


def ask(system, prompt, task, seed=DEFAULT_SEED, max_tokens=1500, force=False):
    """A short text answer for another engine (a music caption): recorded as its own job, nothing saved."""
    if not force and dd2_running():
        raise JobError("DD2 is running; GPU reserved for the game (force to override)", 3)
    job = Job("caption", MODEL_KEY, MODEL_TAG, task)
    job.update(max_tokens=max_tokens)
    try:
        load_s = start()
    except JobError as e:
        job.fail(f"qwen server: {e}", e.code)
    request = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "stream": True,
               "max_tokens": max_tokens, "temperature": 0, "seed": seed, "chat_template_kwargs": {"enable_thinking": False}}
    answer = []
    try:
        _stream(request, job, {"max_tokens": max_tokens}, answer, None)
    except JobError:
        raise
    except Exception as e:
        job.fail(f"{type(e).__name__}: {e}")
    final = job.data.pop("_timings", {})
    job.update(status="done", progress=1.0, ended=time.time(), load_s=load_s, prompt_tokens=final.get("prompt_n"),
               tokens=final.get("predicted_n") or job.data["tokens"],
               tok_per_s=round(final["predicted_per_second"], 1) if final.get("predicted_per_second") else None)
    return "".join(answer).strip()


def chat_json(system, prompt, schema, task, images=(), seed=DEFAULT_SEED, max_tokens=3000, force=False, job=None, on_text=None):
    """One JSON answer constrained by a JSON schema (llama-server grammar). Returns (parsed object, job data)."""
    if not force and dd2_running():
        raise JobError("DD2 is running; GPU reserved for the game (force to override)", 3)
    content = [{"type": "text", "text": prompt}]
    for path in images:
        with open(path, "rb") as f:
            content.append({"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(f.read()).decode("ascii")}})
    messages = [{"role": "system", "content": system}, {"role": "user", "content": content}]
    job = job or Job("plan", MODEL_KEY, MODEL_TAG, task)
    job.update(input_chars=len(prompt), images=len(images), max_tokens=max_tokens)
    try:
        load_s = start()
    except JobError as e:
        job.fail(f"qwen server: {e}", e.code)
    request = {"messages": messages, "stream": True, "max_tokens": max_tokens, "temperature": 0, "seed": seed,
               "chat_template_kwargs": {"enable_thinking": False},
               "response_format": {"type": "json_schema", "json_schema": {"name": "plan", "schema": schema}}}
    answer = []
    try:
        _stream(request, job, {"max_tokens": max_tokens}, answer, on_text)
        obj = json.loads("".join(answer))
    except JobError:
        raise
    except ValueError as e:
        job.fail(f"qwen gave no valid JSON: {e}")
    except Exception as e:
        job.fail(f"{type(e).__name__}: {e}")
    final = job.data.pop("_timings", {})
    job.update(status="done", progress=1.0, ended=time.time(), load_s=load_s, prompt_tokens=final.get("prompt_n"),
               tokens=final.get("predicted_n") or job.data["tokens"],
               tok_per_s=round(final["predicted_per_second"], 1) if final.get("predicted_per_second") else None)
    return obj, job.data


def run(preset, prompt="", material="", images=(), think=False, force=False, seed=DEFAULT_SEED, online=False,
        max_tokens=None, effort=None, job=None, on_text=None):
    """One job, start to finish. Returns the job data (its "output" is the library file). Raises JobError.
    on_text(str) receives the answer as it streams (the app shows it live). online: offer web tools when connected.
    max_tokens: answer budget (default per preset); thinking tokens count against it.
    effort 1 (faster) .. 5 (better): EFFORT sets thinking and the budget; explicit think/max_tokens win."""
    if preset not in PRESETS:
        raise JobError(f"unknown preset {preset}", 2)
    p = dict(PRESETS[preset])
    if effort:
        e_think, e_mult = EFFORT[max(1, min(5, int(effort))) - 1]
        think = think or e_think
        max_tokens = max_tokens or (MAX_CTX if e_mult is None else p["max_tokens"] * e_mult)
    if max_tokens:
        p["max_tokens"] = int(max_tokens)
    elif think:
        p["max_tokens"] *= 4  # reasoning spends tokens before the answer starts
    if not force and dd2_running():
        raise JobError("DD2 is running; GPU reserved for the game (force to override)", 3)
    images = list(images)
    user = "\n\n".join(x for x in (prompt, material) if x and x.strip())
    if not user and not images:
        raise JobError("no prompt, material or image given", 2)
    # logs measured at ~2.6 chars per token; 2 leaves margin. ~1500 tokens per image. The 32k is shared by both slots.
    used = len(user) // 2 + len(p["system"]) // 2 + 1500 * len(images) + 512
    if used + 256 > MAX_CTX:
        raise JobError(f"input needs ~{used} tokens (max {MAX_CTX}); shorten it first", 2)
    p["max_tokens"] = min(p["max_tokens"], MAX_CTX - used)  # never ask for more than the context leaves

    content = [{"type": "text", "text": user}] if user else []
    for path in images:
        low = path.lower()
        mime = "image/jpeg" if low.endswith((".jpg", ".jpeg")) else "image/webp" if low.endswith(".webp") else "image/png"
        with open(path, "rb") as f:
            content.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(f.read()).decode("ascii")}})
    messages = [{"role": "system", "content": p["system"]}] if p["system"] else []
    messages.append({"role": "user", "content": content})

    job = job or Job(preset, MODEL_KEY, MODEL_TAG, prompt or (os.path.basename(images[0]) if images else "material"))
    job.update(input_chars=len(user), images=len(images), max_tokens=p["max_tokens"])
    prune_jobs()
    try:
        load_s = start()
    except JobError as e:
        job.fail(f"qwen server: {e}", e.code)

    # online: web search and page fetch as tools, only when asked for and the internet answers
    tools = web.TOOLS if online and web.online() else None
    answer, final, finish, sources = [], {}, None, []
    vram = PeakVram(enabled=False)  # nvidia-smi every 3 s flashed a console window; peak VRAM only for ComfyUI jobs
    try:
        for _round in range(MAX_TOOL_ROUNDS + 1):
            request = {"messages": messages, "stream": True, "max_tokens": p["max_tokens"], "temperature": 0, "seed": seed,
                       "chat_template_kwargs": {"enable_thinking": think}}
            if tools and _round < MAX_TOOL_ROUNDS:
                request["tools"] = tools
            calls, finish = _stream(request, job, p, answer, on_text)
            final = job.data.pop("_timings", final)
            if not calls:
                break
            messages.append({"role": "assistant", "content": None, "tool_calls": calls})
            for c in calls:
                try:
                    args = json.loads(c["function"]["arguments"] or "{}")
                except ValueError:
                    args = {}
                if on_text:
                    on_text(f"\n[{c['function']['name']}: {args.get('query') or args.get('url') or ''}]\n")
                sources.append({"tool": c["function"]["name"], **args})
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": web.call(c["function"]["name"], args)})
    except JobError:
        raise
    except urllib.error.HTTPError as e:
        job.fail(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:400]}")
    except (urllib.error.URLError, ConnectionError) as e:
        job.fail(f"qwen server unreachable: {e}", 4)
    except Exception as e:
        job.fail(f"{type(e).__name__}: {e}")

    text = "".join(answer).strip()
    if preset == "svg" and text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    kind = p["kind"]
    out = output_path(kind, job.id, ".svg" if kind == "svg" else ".txt")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text + "\n")
    write_sidecar(out, {"kind": kind, "engine": "qwen", "preset": preset, "model": MODEL_TAG, "prompt": prompt,
                        "material": material, "inputs": images, "sources": sources,
                        "params": {"seed": seed, "think": think, "temperature": 0, "online": bool(tools), "max_tokens": p["max_tokens"]}})
    job.update(status="done", progress=1.0, tokens=final.get("predicted_n") or job.data["tokens"], ended=time.time(),
               prompt_tokens=final.get("prompt_n"),
               tok_per_s=round(final["predicted_per_second"], 1) if final.get("predicted_per_second") else None,
               load_s=load_s, truncated=finish == "length", peak_vram_gb=vram.peak, ram_gb=runtime_ram_gb("qwen"),
               output=out)
    job.data["text"] = text
    return job.data
