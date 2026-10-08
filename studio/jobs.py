"""Job records, output sidecars and the process helpers both runtimes share.

Every job (qwen or ComfyUI, from the app or the CLI) is one data/jobs/<id>.json, rewritten while it runs; the System
tab reads the newest of them. Every output file gets a same-named .json sidecar holding what rebuilds it exactly.
"""
import json
import os
import subprocess
import threading
import time

from .paths import JOBS_DIR, LIBRARY, NO_WINDOW

KEEP_JOBS = 300
# CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW: a hidden console its children inherit (DETACHED_PROCESS made their consoles pop up)
DETACHED = 0x00000200 | 0x08000000


class JobError(Exception):
    """A job failed for a reason the user can act on; code mirrors the old CLI exit codes (3 = DD2 running, 4 = runtime)."""

    def __init__(self, msg, code=1):
        super().__init__(msg)
        self.code = code


class Job:
    """One job record. cancel() is honored by the runtimes between tokens / queue polls."""

    def __init__(self, preset, model, model_tag, task, **extra):
        started = time.time()
        self.cancelled = threading.Event()
        self.data = {
            "id": time.strftime("%Y%m%d-%H%M%S", time.localtime(started)) + f"-{os.getpid()}-{threading.get_ident() % 10000}",
            "preset": preset, "model": model, "model_tag": model_tag, "status": "loading", "task": (task or "")[:120],
            "tokens": 0, "max_tokens": None, "progress": 0.0, "tok_per_s": None, "prompt_tokens": None,
            "started": started, "ended": None, "error": None, "pid": os.getpid(), "load_s": None,
            "output": None, "peak_vram_gb": None, "ram_gb": None, "truncated": False,
        }
        self.data.update(extra)
        self._last = 0.0

    @property
    def id(self):
        return self.data["id"]

    def cancel(self):
        self.cancelled.set()

    def update(self, throttle=False, **kv):
        self.data.update(kv)
        now = time.time()
        if throttle and now - self._last < 1.0:
            return
        self._last = now
        write_job(self.data)

    def fail(self, msg, code=1, status="error"):
        self.update(status=status, error=msg if status == "error" else None, ended=time.time())
        raise JobError(msg, code)


def write_job(job):
    os.makedirs(JOBS_DIR, exist_ok=True)
    path = os.path.join(JOBS_DIR, job["id"] + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(job, f, indent=1)
    os.replace(tmp, path)


def prune_jobs():
    os.makedirs(JOBS_DIR, exist_ok=True)
    files = sorted(f for f in os.listdir(JOBS_DIR) if f.endswith(".json"))
    for f in files[:-KEEP_JOBS]:
        try:
            os.remove(os.path.join(JOBS_DIR, f))
        except OSError:
            pass


def output_path(kind, job_id, ext):
    os.makedirs(os.path.join(LIBRARY, kind), exist_ok=True)
    return os.path.join(LIBRARY, kind, job_id + ext)


def write_sidecar(path, meta):
    """meta: kind, preset, model, prompt, params (seed, size...), inputs; enough to run the same job again."""
    meta = dict(meta, file=os.path.basename(path), created=meta.get("created") or time.time())
    with open(os.path.splitext(path)[0] + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)


def dd2_running():
    try:
        import psutil
        return any((p.info["name"] or "").lower() == "dd2.exe" for p in psutil.process_iter(["name"]))
    except Exception:
        return False


def spawn(args, log_path=None, env=None, cwd=None):
    """Start a process that outlives this one: no window, own process group, out of the caller's job object."""
    out = open(log_path, "w", encoding="utf-8") if log_path else subprocess.DEVNULL
    for flags in (DETACHED | 0x01000000, DETACHED):  # + CREATE_BREAKAWAY_FROM_JOB, when the caller's job allows it
        try:
            return subprocess.Popen(args, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, cwd=cwd,
                                    creationflags=flags, close_fds=True)
        except OSError:
            continue
    raise OSError("could not start " + args[0])


def kill_tree(pid):
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)


def gpu_used_gb():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"], capture_output=True,
                             text=True, timeout=3, creationflags=NO_WINDOW).stdout
        return round(float(out.split()[0]) / 1024, 1)
    except Exception:
        return None


def runtime_ram_gb(runtime):
    """RSS of the runtime doing a job's work: 'qwen' (llama-server) or 'comfy' (ComfyUI's python)."""
    try:
        import psutil
    except ImportError:
        return None
    total = 0
    for p in psutil.process_iter(["name", "cmdline", "memory_info"]):
        try:
            name = (p.info["name"] or "").lower()
            cmd = " ".join(p.info["cmdline"] or [])
            if (runtime == "qwen" and name.startswith("llama-server")) or \
               (runtime == "comfy" and name.startswith("python") and "ComfyUI" in cmd and "main.py" in cmd):
                total += p.info["memory_info"].rss
        except (psutil.Error, TypeError, AttributeError):
            pass
    return round(total / 1024 ** 3, 1) if total else None


class PeakVram:
    """Highest GPU memory in use seen while a job runs, sampled at most every 3 s."""

    def __init__(self, enabled=True):
        self.peak, self.at, self.enabled = None, 0.0, enabled

    def sample(self):
        if not self.enabled or time.time() - self.at < 3:
            return
        self.at = time.time()
        v = gpu_used_gb()
        if v is not None and (self.peak is None or v > self.peak):
            self.peak = v
