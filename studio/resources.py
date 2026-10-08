"""One snapshot of system resources and the local AI runtimes, for the System tab (server.py streams it over SSE).

Reads: CPU/RAM/disk (psutil), GPU (nvidia-smi, Windows GPU counters per process), the qwen llama-server (/slots),
ComfyUI (/queue), the processes of both, CLI jobs and DD2, and the newest job files in data/jobs/. Read only.
Needs: pip install psutil.
"""
import ctypes
import glob
import json
import os
import re
import subprocess
import time
import urllib.request

import psutil

from .paths import AI_DIR, CACHE_DIR, COMFY_DESKTOP, DATA, JOBS_DIR, LIBRARY, ROOT

COMFY = "http://127.0.0.1:8188"
GB = 1024 ** 3
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def get_json(url):
    try:
        with urllib.request.urlopen(url, timeout=0.8) as r:
            return json.loads(r.read())
    except Exception:
        return None


def gpu():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit",
             "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3, creationflags=NO_WINDOW).stdout
        name, util, used, total, temp, power, limit = [x.strip() for x in out.splitlines()[0].split(",")]
        num = lambda v: float(v) if v.replace(".", "", 1).isdigit() else None  # noqa: E731
        return {"name": name, "util": num(util), "vramUsed": round(num(used) / 1024, 1), "vramTotal": round(num(total) / 1024, 1),
                "temp": num(temp), "power": num(power), "powerLimit": num(limit)}
    except Exception:
        return None


class _PdhValue(ctypes.Structure):
    _fields_ = [("status", ctypes.c_ulong), ("value", ctypes.c_double)]


class _PdhItem(ctypes.Structure):
    _fields_ = [("name", ctypes.c_wchar_p), ("value", _PdhValue)]


class GpuSampler:
    """Per-process dedicated VRAM and GPU engine use from the Windows GPU counters (what Task Manager shows).
    start() takes the first engine sample, read() the second, so the time between them is the measured window."""

    def __init__(self):
        self.ok = False
        try:
            self.pdh = ctypes.windll.pdh
            self.q, self.mem, self.eng = ctypes.c_void_p(), ctypes.c_void_p(), ctypes.c_void_p()
            if self.pdh.PdhOpenQueryW(None, None, ctypes.byref(self.q)):
                return
            self.pdh.PdhAddEnglishCounterW(self.q, "\\GPU Process Memory(*)\\Dedicated Usage", None, ctypes.byref(self.mem))
            self.pdh.PdhAddEnglishCounterW(self.q, "\\GPU Engine(*)\\Utilization Percentage", None, ctypes.byref(self.eng))
            self.pdh.PdhCollectQueryData(self.q)
            self.ok = True
        except (AttributeError, OSError):
            pass

    def _array(self, counter, fmt):
        size, count = ctypes.c_ulong(0), ctypes.c_ulong(0)
        self.pdh.PdhGetFormattedCounterArrayW(counter, fmt, ctypes.byref(size), ctypes.byref(count), None)
        if not size.value:
            return []
        buf = (ctypes.c_byte * size.value)()
        if self.pdh.PdhGetFormattedCounterArrayW(counter, fmt, ctypes.byref(size), ctypes.byref(count), buf):
            return []
        items = ctypes.cast(buf, ctypes.POINTER(_PdhItem))
        return [(items[i].name, items[i].value.value) for i in range(count.value)]

    def read(self):
        """{pid: (vram bytes, GPU % of its busiest engine type)}"""
        if not self.ok:
            return {}
        try:
            self.pdh.PdhCollectQueryData(self.q)
            vram, engines = {}, {}
            for name, v in self._array(self.mem, 0x200):  # PDH_FMT_DOUBLE
                if (m := re.match(r"pid_(\d+)_", name or "")):
                    vram[int(m[1])] = vram.get(int(m[1]), 0) + v
            for name, v in self._array(self.eng, 0x200 | 0x8000):  # + PDH_FMT_NOCAP100
                if (m := re.match(r"pid_(\d+)_.*engtype_(.+)$", name or "")):
                    per = engines.setdefault(int(m[1]), {})
                    per[m[2]] = per.get(m[2], 0) + v
            return {pid: (vram.get(pid, 0), max(engines.get(pid, {}).values(), default=0)) for pid in vram.keys() | engines.keys()}
        finally:
            self.pdh.PdhCloseQuery(self.q)


def holder_name(name, cmdline):
    """A process name as the System tab shows it: ComfyUI and Media Studio named, .exe dropped."""
    name = (name or "?").removesuffix(".exe")
    cmd = " ".join(cmdline or []).replace("\\", "/")
    if name.lower().startswith("python") and "ComfyUI" in cmd:
        return "ComfyUI"
    if name.lower().startswith("python") and ("server.py" in cmd or "studio." in cmd) and "MediaStudio" in cmd:
        return "Media Studio"
    if name.lower() == "ffmpeg":
        return "ffmpeg"
    return name


def is_agent(name):
    return name in ("ComfyUI", "Comfy Desktop", "Media Studio", "ffmpeg") or name.lower().startswith("llama-server")


def gpu_holders(sample, n=8):
    """What uses the GPU: dedicated VRAM and engine %, summed per process name."""
    by_name = {}
    for pid, (vram, util) in sample.items():
        try:
            p = psutil.Process(pid)
            name = p.name()
        except psutil.Error:
            continue
        try:
            cmdline = p.cmdline()
        except psutil.Error:  # system processes (dwm) deny their command line
            cmdline = []
        name = holder_name(name, cmdline)
        row = by_name.setdefault(name, {"name": name, "vramGB": 0.0, "util": 0.0, "count": 0})
        row["vramGB"] += vram / GB
        row["util"] += util
        row["count"] += 1
    rows = [r for r in by_name.values() if r["vramGB"] >= 0.05 or r["util"] >= 0.5]
    rows.sort(key=lambda r: -r["vramGB"])
    for r in rows:
        r["vramGB"], r["util"], r["isAgent"] = round(r["vramGB"], 2), round(min(100.0, r["util"]), 1), is_agent(r["name"])
    return rows[:n] + sorted(rows[n:], key=lambda r: -r["util"])[:3] if len(rows) > n else rows


def kind_of(p):
    name = (p.info["name"] or "").lower()
    cmd = " ".join(p.info["cmdline"] or []).replace("\\", "/")
    if name == "dd2.exe":
        return "dd2", "DD2"
    if name.startswith("llama-server"):
        return "qwen", "Qwen server"
    if name.startswith("python") and "ComfyUI" in cmd and "main.py" in cmd:
        return "comfy", "ComfyUI"
    if name.startswith("ffmpeg"):
        return "ffmpeg", "ffmpeg"
    args = p.info["cmdline"] or []
    if name.startswith("python") and "studio.cli" in args and "watch" not in args:
        return "job", "cli " + " ".join(args[args.index("studio.cli") + 1:][:2])
    return None, None


def processes():
    found = []
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            kind, label = kind_of(p)
        except (psutil.Error, TypeError):
            continue
        if kind:
            try:
                p.cpu_percent(None)
                found.append((p, kind, label))
            except psutil.Error:
                pass
    time.sleep(0.4)
    cores = psutil.cpu_count() or 1
    rows = []
    for p, kind, label in found:
        try:
            rows.append({"pid": p.pid, "kind": kind, "label": label, "cpu": round(p.cpu_percent(None) / cores, 1),
                         "ramGB": round(p.memory_info().rss / GB, 1)})
        except psutil.Error:
            pass
    return rows


def top_ram(n=8):
    """Biggest RAM users, summed per process name; agent runtimes flagged."""
    by_name = {}
    for p in psutil.process_iter(["name", "memory_info", "cmdline"]):
        try:
            name = holder_name(p.info["name"], p.info["cmdline"])
            row = by_name.setdefault(name, {"name": name, "gb": 0.0, "count": 0})
            row["gb"] += (p.info["memory_info"].rss if p.info["memory_info"] else 0) / GB
            row["count"] += 1
        except (psutil.Error, TypeError, AttributeError):
            continue
    rows = sorted(by_name.values(), key=lambda r: -r["gb"])[:n]
    for r in rows:
        r["gb"] = round(r["gb"], 1)
        r["isAgent"] = is_agent(r["name"])
    return rows


def dir_size(path):
    total, stack = 0, [path]
    while stack:
        try:
            with os.scandir(stack.pop()) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        else:
                            total += e.stat(follow_symlinks=False).st_size
                    except OSError:
                        pass
        except OSError:
            pass
    return total


DISK_CACHE = os.path.join(CACHE_DIR, "disk.json")
DISK_CACHE_VERSION = 4  # bump when the row shape changes, so an old cache is recomputed


def disk_breakdown():
    """Space used by what this setup created, recomputed at most every 10 minutes (cached in data/cache)."""
    try:
        with open(DISK_CACHE, encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("version") == DISK_CACHE_VERSION and time.time() - cached["at"] < 600:
            return cached["rows"]
    except (OSError, ValueError, KeyError):
        pass
    home = os.path.expanduser("~")
    app_skip = {"library", "data"}
    app = sum(dir_size(os.path.join(ROOT, d)) if os.path.isdir(os.path.join(ROOT, d)) else os.path.getsize(os.path.join(ROOT, d))
              for d in os.listdir(ROOT) if d not in app_skip)
    rows = [
        ("Library", "agents", dir_size(LIBRARY)),
        ("Jobs, cache, logs", "agents", dir_size(DATA)),
        ("Media Studio (code, .git)", "repo", app),
        ("ComfyUI models", "models", dir_size(os.path.join(AI_DIR, "models")) - dir_size(os.path.join(AI_DIR, "models", "llm"))),
        ("Qwen model", "models", dir_size(os.path.join(AI_DIR, "models", "llm"))),
        ("ComfyUI install", "setup", dir_size(COMFY_DESKTOP)),
        ("llama.cpp", "setup", dir_size(os.path.join(AI_DIR, "llama.cpp"))),
        ("HF download cache", "setup", dir_size(os.path.join(home, ".cache", "huggingface"))),
    ]
    rows = [{"label": l, "group": g, "mb": round(b / 1024 ** 2)} for l, g, b in rows]
    os.makedirs(os.path.dirname(DISK_CACHE), exist_ok=True)
    with open(DISK_CACHE, "w", encoding="utf-8") as f:
        json.dump({"version": DISK_CACHE_VERSION, "at": time.time(), "rows": rows}, f)
    return rows


QWEN = "http://127.0.0.1:8091"


def qwen(holders):
    """The qwen llama-server: loaded model, busy slots."""
    slots = get_json(QWEN + "/slots")
    if slots is None:
        return {"up": False, "models": [], "busy": 0}
    vram = sum(h["vramGB"] for h in holders if h["name"].startswith("llama-server"))
    ctx = sum(s.get("n_ctx") or 0 for s in slots[:1]) or None
    return {"up": True, "busy": sum(1 for s in slots if s.get("is_processing")),
            "models": [{"name": "qwen", "sizeGB": 14.1, "vramGB": round(vram, 1), "gpuPct": 100, "ctx": ctx, "until": None}]}


def comfy():
    q = get_json(COMFY + "/queue")
    if q is None:
        return {"up": False, "running": 0, "pending": 0}
    return {"up": True, "running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", []))}


def jobs(limit=80):
    rows = []
    for path in sorted(glob.glob(os.path.join(JOBS_DIR, "*.json")), reverse=True)[:limit]:
        try:
            with open(path, encoding="utf-8") as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        status = j.get("status")
        if status in ("loading", "running") and not psutil.pid_exists(j.get("pid") or 0):
            status = "lost"
        end = j.get("ended") or time.time()
        rows.append({"id": j.get("id"), "preset": j.get("preset"), "model": j.get("model"), "status": status,
                     "task": j.get("task"), "tokens": j.get("tokens") or 0, "maxTokens": j.get("max_tokens"),
                     "progress": j.get("progress") or 0, "tokPerS": j.get("tok_per_s"),
                     "elapsedS": round(end - (j.get("started") or end)), "error": (j.get("error") or "")[:160] or None,
                     "pid": j.get("pid"), "started": j.get("started"), "inTokens": j.get("prompt_tokens"),
                     "loadS": j.get("load_s"), "peakVramGB": j.get("peak_vram_gb"), "ramGB": j.get("ram_gb"),
                     "output": j.get("output"), "truncated": bool(j.get("truncated")), "seed": j.get("seed")})
    order = {"loading": 0, "running": 0}
    rows.sort(key=lambda r: order.get(r["status"], 1))
    return rows


def snapshot():
    psutil.cpu_percent(None)
    psutil.cpu_percent(None, percpu=True)
    sampler = GpuSampler()
    procs = processes()  # sleeps 0.4 s: the CPU and GPU engine readings below cover that window
    holders = gpu_holders(sampler.read())
    vm = psutil.virtual_memory()
    disk = psutil.disk_usage(os.path.splitdrive(ROOT)[0] + "\\")
    freq = psutil.cpu_freq()
    g = gpu()
    if g:
        g["procs"] = holders
    return {
        "at": int(time.time() * 1000),
        "cpu": {"pct": psutil.cpu_percent(None), "threads": psutil.cpu_count(), "cores": psutil.cpu_count(logical=False),
                "mhz": round(freq.current) if freq else None, "maxMhz": round(freq.max) if freq else None,
                "perThread": psutil.cpu_percent(None, percpu=True)},
        "ram": {"used": round((vm.total - vm.available) / GB, 1), "total": round(vm.total / GB, 1), "top": top_ram()},
        "disk": {"free": round(disk.free / GB), "total": round(disk.total / GB), "rows": disk_breakdown()},
        "gpu": g,
        "dd2": any(p["kind"] == "dd2" for p in procs),
        "qwen": qwen(holders),
        "comfy": comfy(),
        "procs": [p for p in procs if p["kind"] != "dd2"],
        "jobs": jobs(),
    }


if __name__ == "__main__":
    print(json.dumps(snapshot()))
