"""Agent: a conversation with qwen that can use Media Studio's tools.

Each user message runs one turn: qwen thinks (streamed as reasoning), answers, and calls tools until it is done.
Generation tools run ComfyUI, which takes the GPU from qwen; qwen reloads (~15 s) to continue. write_file never
writes: it proposes a file the user accepts or rejects in the app. Sessions live in data/agent/<id>.json.
"""
import base64
import json
import os
import time
import urllib.request

from . import comfy, qwen, web
from .jobs import Job, JobError, write_sidecar
from .paths import DATA, LIBRARY

AGENT_DIR = os.path.join(DATA, "agent")
MAX_ROUNDS = 12
HISTORY_CHARS = 60000  # about 24k tokens of history; older turns drop out first

SYSTEM = """You are the Media Studio agent, running locally on the user's PC. Be direct and concise.
You can use tools: make images, video clips, voice lines, music and sound effects; look at images; search the media
library; read text files from it; write files; draft whole scenes with orchestrate_scene; and, when online, search the
web and read pages.
Rules:
- Use tools when they help; say briefly what you are doing. Prefer one good attempt over many.
- Media tools are slow (images ~10 s, voice ~35 s, music ~60 s, video ~70 s, scenes several minutes): do not repeat
  them needlessly.
- To give the user a file (text, code, SVG, JSON, notes), call write_file. The user must accept it; never claim a file
  was saved until they did.
- Paths you return or receive are local Windows paths; quote them exactly.
- Generated media lands in the library automatically; mention what you made."""


def tools(online):
    def fn(name, desc, props, req):
        return {"type": "function", "function": {"name": name, "description": desc,
                                                 "parameters": {"type": "object", "properties": props, "required": req}}}
    s = {"type": "string"}
    n = {"type": "number"}
    out = [
        fn("generate_image", "Make an image with Krea 2. Returns its path.",
           {"prompt": s, "size": {"type": "string", "enum": ["1344x768", "768x1344", "1024x1024", "1536x640"]}}, ["prompt"]),
        fn("generate_video", "Animate an image into a short clip with sound (LTX-2.3). Returns its path.",
           {"image_path": s, "motion": {"type": "string", "description": "movement and camera in one sentence"}, "seconds": n}, ["image_path", "motion"]),
        fn("generate_voice", "Speak a line with Qwen3-TTS. Returns the audio path.",
           {"text": s, "speaker": {"type": "string", "enum": ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"]},
            "style": {"type": "string", "description": "delivery, e.g. calm, deep, excited"}}, ["text"]),
        fn("generate_music", "Make a music track with MiniMax-Music-3. Returns the audio path.",
           {"idea": {"type": "string", "description": "genre, mood, instruments"}, "seconds": n, "lyrics": {"type": "string", "description": "with [Verse]/[Chorus] tags; omit for instrumental"}}, ["idea"]),
        fn("generate_sfx", "Make a short sound effect with Stable Audio 3. Returns the audio path.", {"description": s, "seconds": n}, ["description"]),
        fn("orchestrate_scene", "Plan and make a whole short video scene (shots, voice, sfx, music, cut). Takes minutes. Returns the video path.",
           {"request": s, "animate": {"type": "boolean", "description": "animate shots with video (much slower)"}}, ["request"]),
        fn("look_at_image", "See an image file (a library path or one the user gave).", {"path": s}, ["path"]),
        fn("list_library", "List recent library items: path, kind and prompt.",
           {"kind": {"type": "string", "enum": ["image", "video", "voice", "music", "sfx", "text", "svg", "gif", "renders", "projects"]},
            "query": s, "limit": n}, []),
        fn("read_file", "Read a text file from the library (first 20000 characters).", {"path": s}, ["path"]),
        fn("write_file", "Propose a file to the user (they accept or reject it). Use a sensible file name with extension.",
           {"name": s, "content": s}, ["name", "content"]),
    ]
    if online:
        out += web.TOOLS
    return out


# ---------- sessions ----------

def path_of(sid):
    return os.path.join(AGENT_DIR, sid + ".json")


def load(sid):
    with open(path_of(sid), encoding="utf-8") as f:
        return json.load(f)


def save(s):
    os.makedirs(AGENT_DIR, exist_ok=True)
    tmp = path_of(s["id"]) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1)
    os.replace(tmp, path_of(s["id"]))


def new_session():
    sid = time.strftime("%Y%m%d-%H%M%S")
    s = {"id": sid, "title": "New chat", "created": time.time(), "messages": [], "log": [], "files": {}, "notes": []}
    save(s)
    return s


def sessions():
    os.makedirs(AGENT_DIR, exist_ok=True)
    out = []
    for f in sorted(os.listdir(AGENT_DIR), reverse=True):
        if f.endswith(".json"):
            try:
                s = load(f[:-5])
                out.append({"id": s["id"], "title": s["title"], "created": s["created"], "turns": sum(1 for m in s["messages"] if m["role"] == "user")})
            except (OSError, ValueError, KeyError):
                pass
    return out


# ---------- one turn ----------

def _img_part(path):
    low = path.lower()
    mime = "image/jpeg" if low.endswith((".jpg", ".jpeg")) else "image/webp" if low.endswith(".webp") else "image/png"
    with open(path, "rb") as f:
        return {"type": "image_url", "image_url": {"url": f"data:{mime};base64," + base64.b64encode(f.read()).decode("ascii")}}


def _wire(messages):
    """Session messages -> request messages: image paths become image parts; history trimmed from the oldest turn."""
    out, size = [], 0
    for m in reversed(messages):
        size += len(json.dumps(m.get("content") or "")) + len(json.dumps(m.get("tool_calls") or ""))
        if size > HISTORY_CHARS and m["role"] == "user" and out:
            break
        w = {k: v for k, v in m.items() if k in ("role", "content", "tool_calls", "tool_call_id")}
        if m.get("images"):
            w["content"] = [{"type": "text", "text": m.get("content") or ""}] + [_img_part(p) for p in m["images"] if os.path.isfile(p)]
        out.append(w)
    out.reverse()
    while out and out[0]["role"] == "tool":  # never start on an orphan tool result
        out.pop(0)
    return [{"role": "system", "content": SYSTEM}] + out


def _stream(request, job, emit):
    req = urllib.request.Request(qwen.URL + "/v1/chat/completions", data=json.dumps(request).encode("utf-8"),
                                 headers={"Content-Type": "application/json"})
    text, calls, timings = [], {}, {}
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
            timings = chunk.get("timings") or timings
            for c in chunk.get("choices") or []:
                d = c.get("delta") or {}
                if d.get("reasoning_content"):
                    emit("reasoning", t=d["reasoning_content"])
                if d.get("content"):
                    text.append(d["content"])
                    emit("text", t=d["content"])
                for tc in d.get("tool_calls") or []:
                    slot = calls.setdefault(tc.get("index", 0), {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    slot["id"] = tc.get("id") or slot["id"]
                    fn = tc.get("function") or {}
                    slot["function"]["name"] += fn.get("name") or ""
                    slot["function"]["arguments"] += fn.get("arguments") or ""
                if d:
                    job.data["tokens"] += 1
                    job.update(throttle=True, status="running")
    return "".join(text), [calls[i] for i in sorted(calls)], timings


def _media(preset, prompt, params, effort, force):
    j = comfy.run(preset, prompt, params, effort=effort, force=force)
    return j["output"], f"{preset} saved: {j['output']} (seed {j['seed']})"


def _call(s, name, args, effort, force, emit, pending_images):
    """Run one tool. Returns (result text for qwen, files made)."""
    if name in ("web_search", "fetch_url"):
        return web.call(name, args), []
    if name == "generate_image":
        p, msg = _media("image", args["prompt"], {"size": args.get("size")}, effort, force)
        return msg, [p]
    if name == "generate_video":
        p, msg = _media("video", args["motion"], {"image": args["image_path"], "seconds": args.get("seconds")}, effort, force)
        return msg, [p]
    if name == "generate_voice":
        p, msg = _media("voice", args["text"], {"speaker": args.get("speaker"), "instruct": args.get("style")}, effort, force)
        return msg, [p]
    if name == "generate_music":
        p, msg = _media("music", args["idea"], {"seconds": args.get("seconds"), "lyrics": args.get("lyrics")}, effort, force)
        return msg, [p]
    if name == "generate_sfx":
        p, msg = _media("sfx", args["description"], {"seconds": args.get("seconds")}, effort, force)
        return msg, [p]
    if name == "orchestrate_scene":
        from . import orchestrate
        j = orchestrate.run(args["request"], animate=bool(args.get("animate")), effort=effort, force=force)
        return f"scene rendered: {j['output']} (project {j['project']}, {len(j['plan']['shots'])} shots)", [j["output"]]
    if name == "look_at_image":
        p = args["path"]
        if not os.path.isfile(p):
            return f"no such file: {p}", []
        pending_images.append(p)
        return f"The image {os.path.basename(p)} is attached to the next message.", []
    if name == "list_library":
        from .media import kind_of
        rows = []
        for k in ([args["kind"]] if args.get("kind") else os.listdir(LIBRARY)):
            d = os.path.join(LIBRARY, k)
            if not os.path.isdir(d):
                continue
            for e in os.scandir(d):
                if e.name.endswith(".json") and k != "projects":
                    continue
                meta = {}
                try:
                    with open(os.path.splitext(e.path)[0] + ".json", encoding="utf-8") as f:
                        meta = json.load(f) if k != "projects" else {"prompt": json.load(f).get("title", "")}
                except (OSError, ValueError):
                    pass
                q = (args.get("query") or "").lower()
                if q and q not in (e.name + " " + str(meta.get("prompt", ""))).lower():
                    continue
                rows.append((e.stat().st_mtime, f"{k}\t{e.path}\t{str(meta.get('prompt', ''))[:100]}"))
        rows.sort(reverse=True)
        return "\n".join(r for _, r in rows[:int(args.get("limit") or 20)]) or "nothing found", []
    if name == "read_file":
        p = os.path.abspath(args["path"])
        allowed = p.startswith(LIBRARY) or any(p in (m.get("files") or []) for m in s["messages"])
        if not allowed:
            return "read_file only reads library files or files the user attached", []
        with open(p, encoding="utf-8", errors="replace") as f:
            return f.read()[:20000], []
    if name == "write_file":
        pid = f"f{len(s['files']) + 1}"
        s["files"][pid] = {"name": os.path.basename(args.get("name") or "file.txt"), "content": args.get("content") or "", "status": "proposed"}
        emit("file", pid=pid, name=s["files"][pid]["name"], size=len(s["files"][pid]["content"]), preview=s["files"][pid]["content"][:4000])
        return f"Proposed {s['files'][pid]['name']} to the user; they will accept or reject it.", []
    return f"unknown tool {name}", []


def turn(sid, text, images=(), files=(), think=False, online=False, effort=3, force=False, job=None, send=None):
    """Run one user turn. send(event) pushes UI events; every event is also kept in the session log."""
    s = load(sid)
    job = job or Job("agent", "qwen", qwen.MODEL_TAG, text)

    def emit(kind, **data):
        ev = {"sid": sid, "type": kind, "at": time.time(), **data}
        if kind not in ("reasoning", "text"):
            s["log"].append(ev)
        elif s["log"] and s["log"][-1]["type"] == kind and s["log"][-1].get("turn") == len(s["messages"]):
            s["log"][-1]["t"] += data.get("t", "")
        else:
            s["log"].append(dict(ev, turn=len(s["messages"])))
        if send:
            send(ev)

    if not force and qwen.dd2_running():
        raise JobError("DD2 is running; GPU reserved for the game (force to override)", 3)
    notes = "".join(f"[{n}]\n" for n in s.pop("notes", []))
    s["notes"] = []
    attached = "".join(f"\n[attached file: {p}]" for p in files)
    user = {"role": "user", "content": notes + text + attached, "images": list(images), "files": list(files)}
    s["messages"].append(user)
    if s["title"] == "New chat":
        s["title"] = text[:60] or "Chat"
    emit("user", t=text, images=list(images), files=list(files))
    save(s)
    e_think, e_mult = qwen.EFFORT[max(1, min(5, int(effort))) - 1]
    think = think or e_think
    budget = 16000 if e_mult is None else 2000 * e_mult
    toolset = tools(online and web.online())
    job.update(status="loading")
    try:
        for rnd in range(MAX_ROUNDS):
            try:
                load_s = qwen.start()
            except JobError as e:
                job.fail(f"qwen server: {e}", e.code)
            if load_s:
                emit("status", t=f"qwen loaded in {load_s:.0f} s")
            req = {"messages": _wire(s["messages"]), "stream": True, "max_tokens": budget, "temperature": 0, "seed": qwen.DEFAULT_SEED,
                   "chat_template_kwargs": {"enable_thinking": think}}
            if rnd < MAX_ROUNDS - 1:
                req["tools"] = toolset
            answer, calls, timings = _stream(req, job, emit)
            msg = {"role": "assistant", "content": answer or None}
            if calls:
                msg["tool_calls"] = calls
            s["messages"].append(msg)
            if timings:
                emit("stats", t=f"{timings.get('prompt_n')} in · {timings.get('predicted_n')} out · {round(timings.get('predicted_per_second') or 0, 1)} t/s")
            save(s)
            if not calls:
                break
            pending = []
            for c in calls:
                name = c["function"]["name"]
                try:
                    args = json.loads(c["function"]["arguments"] or "{}")
                except ValueError:
                    args = {}
                emit("tool", name=name, args=args)
                t0 = time.time()
                try:
                    result, made = _call(s, name, args, effort, force, emit, pending)
                except JobError as e:
                    result, made = f"{name} failed: {e}", []
                except Exception as e:
                    result, made = f"{name} failed: {type(e).__name__}: {e}", []
                emit("result", name=name, t=result[:1500], files=made, secs=round(time.time() - t0, 1))
                s["messages"].append({"role": "tool", "tool_call_id": c["id"], "content": result})
                save(s)
            if pending:
                s["messages"].append({"role": "user", "content": "(images you asked to see)", "images": pending})
    finally:
        save(s)
    emit("done")
    save(s)
    job.update(status="done", progress=1.0, ended=time.time())
    return job.data


def decide_file(sid, pid, action, folder=None):
    """The user's answer to a write_file proposal: 'library', 'folder' (needs folder) or 'reject'."""
    s = load(sid)
    f = s["files"][pid]
    out = None
    if action == "library":
        ext = os.path.splitext(f["name"])[1].lower()
        kind = "svg" if ext == ".svg" else "text"
        out = os.path.join(LIBRARY, kind, f"{time.strftime('%Y%m%d-%H%M%S')}-{f['name']}")
    elif action == "folder" and folder:
        out = os.path.join(os.path.abspath(folder), f["name"])
    if out:
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(f["content"])
        if out.startswith(LIBRARY):
            write_sidecar(out, {"kind": os.path.basename(os.path.dirname(out)), "engine": "agent", "preset": "write_file",
                                "model": qwen.MODEL_TAG, "prompt": f"agent chat {sid}", "params": {}})
        f.update(status="accepted", path=out)
        s["notes"].append(f"The user accepted {f['name']}: saved to {out}")
    else:
        f.update(status="rejected")
        s["notes"].append(f"The user rejected {f['name']}")
    s["log"].append({"sid": sid, "type": "file_decision", "pid": pid, "status": f["status"], "path": out, "at": time.time()})
    save(s)
    return f
