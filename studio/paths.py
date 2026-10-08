"""Where everything lives. The repo holds code; library/ and data/ (gitignored) hold what the app makes."""
import glob
import os
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIBRARY = os.path.join(ROOT, "library")
DATA = os.path.join(ROOT, "data")
JOBS_DIR = os.path.join(DATA, "jobs")
CACHE_DIR = os.path.join(DATA, "cache")
LOG_DIR = os.path.join(DATA, "logs")
INBOX_DIR = os.path.join(DATA, "inbox")
WEB = os.path.join(ROOT, "web")

# Library folders, one per kind of media; each file has a same-named .json sidecar (how it was made).
KINDS = ("image", "video", "voice", "music", "sfx", "text", "svg", "gif", "renders", "projects")

AI_DIR = os.path.join(os.path.expanduser("~"), "AI")
LLAMA_SERVER = os.path.join(AI_DIR, "llama.cpp", "llama-server.exe")
QWEN_MODEL = os.path.join(AI_DIR, "models", "llm", "Swift-1.5-Qwen3.8-27B-IQ3_M.gguf")
QWEN_PROJ = os.path.join(AI_DIR, "models", "llm", "Qwen3.8-27B-mmproj.gguf")

COMFY_DESKTOP = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Comfy-Desktop")
COMFY_HOME = os.path.join(COMFY_DESKTOP, "ComfyUI-Installs", "ComfyUI", "ComfyUI")
COMFY_PY = os.path.join(COMFY_HOME, ".venv", "Scripts", "python.exe")
COMFY_SHARED = os.path.join(COMFY_DESKTOP, "ComfyUI-Shared")

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ensure_dirs():
    for d in (JOBS_DIR, CACHE_DIR, LOG_DIR, INBOX_DIR, *(os.path.join(LIBRARY, k) for k in KINDS)):
        os.makedirs(d, exist_ok=True)


def tool(name):
    """ffmpeg / ffprobe: PATH first, then the winget Gyan.FFmpeg package folder (PATH may be stale until re-login)."""
    found = shutil.which(name)
    if found:
        return found
    pattern = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg*", "*", "bin", name + ".exe")
    hits = sorted(glob.glob(pattern))
    if hits:
        return hits[-1]
    raise FileNotFoundError(f"{name} not found: winget install Gyan.FFmpeg")
