"""Media jobs on the local ComfyUI: image, video, voice, music, sfx. Prompt in, library file out.

Runtime: when nothing answers on port 8188, starts ComfyUI headless (the Desktop install's python and main.py, no
window, no app) and a detached watchdog that stops it after 10 idle minutes or when DD2 starts. A ComfyUI the Desktop
app runs is used as is and never stopped. Models live in ~/AI/models (extra_model_paths.yaml).
Deterministic: every job has a seed (recorded in its sidecar); the same seed and inputs give the same file.
"""
import glob
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from .jobs import Job, JobError, PeakVram, dd2_running, kill_tree, output_path, prune_jobs, runtime_ram_gb, spawn, write_sidecar
from .paths import CACHE_DIR, COMFY_HOME, COMFY_PY, COMFY_SHARED, ROOT

URL = "http://127.0.0.1:8188"
IDLE_S = 600

# Each preset: its parameters (defaults; the app builds its form from "fields") and an effort ladder, Faster (1) to
# Better (5), that sets the quality parameters; 3 is the default. Explicit parameters override the ladder.
AUDIO_FORMATS = ["flac", "mp3 320k", "mp3 V0", "opus 192k"]
PRESETS = {
    "image": {"label": "Image", "model": "krea2", "tag": "Krea 2 Turbo", "kind": "image", "ext": ".png",
              "params": {"size": "1344x768", "steps": 8},
              "effort": {"steps": [4, 6, 8, 12, 16]},
              "fields": [{"key": "size", "label": "Size", "type": "select", "options": ["1344x768", "768x1344", "1024x1024", "1536x640", "1920x1088", "768x432"]},
                         {"key": "steps", "label": "Steps", "type": "int", "min": 2, "max": 40, "advanced": True}]},
    "video": {"label": "Video", "model": "ltx2.3", "tag": "LTX-2.3 distilled", "kind": "video", "ext": ".mp4",
              "params": {"size": "768x512", "seconds": 5}, "needs_image": True,
              "effort": {"size": ["512x320", "640x416", "768x512", "896x576", "1024x640"]},
              "fields": [{"key": "seconds", "label": "Seconds", "type": "int", "min": 1, "max": 10},
                         {"key": "size", "label": "Size", "type": "text", "advanced": True}],
              "note": "Better = higher resolution; above 768x512 it nears the 16 GB VRAM limit."},
    "voice": {"label": "Voice", "model": "qwen-tts", "tag": "Qwen3-TTS CustomVoice", "kind": "voice", "ext": ".flac",
              "params": {"speaker": "Ryan", "instruct": "", "language": "Auto", "model_choice": "1.7B", "temperature": 0.9,
                         "top_p": 1.0, "format": "flac"},
              "effort": {"model_choice": ["0.6B", "0.6B", "1.7B", "1.7B", "1.7B"], "temperature": [0.9, 0.9, 0.9, 0.8, 0.7]},
              "fields": [{"key": "speaker", "label": "Speaker", "type": "select", "options": ["Aiden", "Dylan", "Eric", "Ono_anna", "Ryan", "Serena", "Sohee", "Uncle_fu", "Vivian"]},
                         {"key": "instruct", "label": "Style", "type": "text", "placeholder": "calm, deep, slow"},
                         {"key": "language", "label": "Language", "type": "text", "advanced": True},
                         {"key": "model_choice", "label": "Model", "type": "select", "options": ["0.6B", "1.7B"], "advanced": True},
                         {"key": "temperature", "label": "Temperature", "type": "float", "min": 0.1, "max": 2, "step": 0.05, "advanced": True},
                         {"key": "top_p", "label": "Top p", "type": "float", "min": 0, "max": 1, "step": 0.05, "advanced": True},
                         {"key": "format", "label": "Format", "type": "select", "options": AUDIO_FORMATS, "advanced": True}]},
    "music": {"label": "Music", "model": "music3", "tag": "MiniMax-Music-3", "kind": "music", "ext": ".flac",
              "params": {"seconds": 60, "lyrics": "", "steps": 30, "cfg": 1.7, "top_k": 50, "enhance": True, "format": "flac"},
              "effort": {"steps": [16, 22, 30, 40, 50]},
              "fields": [{"key": "seconds", "label": "Seconds", "type": "int", "min": 5, "max": 300},
                         {"key": "enhance", "label": "Qwen writes the full caption (genre, BPM, key, vocals, arrangement)", "type": "bool"},
                         {"key": "lyrics", "label": "Lyrics ([Verse], [Chorus], [Instrumental]...; empty = instrumental)", "type": "textarea"},
                         {"key": "steps", "label": "Steps", "type": "int", "min": 8, "max": 80, "advanced": True},
                         {"key": "cfg", "label": "CFG", "type": "float", "min": 1, "max": 4, "step": 0.1, "advanced": True},
                         {"key": "top_k", "label": "Top k", "type": "int", "min": 1, "max": 500, "advanced": True},
                         {"key": "format", "label": "Format", "type": "select", "options": AUDIO_FORMATS, "advanced": True}],
              "note": "MiniMax wants a structured caption; short ideas sound flat and muffled, so qwen expands them first."},
    "sfx": {"label": "Sound effect", "model": "sa3-sfx", "tag": "Stable Audio 3 small-sfx", "kind": "sfx", "ext": ".flac",
            "params": {"seconds": 5, "steps": 8, "cfg": 1.0, "format": "flac"},
            "effort": {"steps": [4, 6, 8, 12, 16]},
            "fields": [{"key": "seconds", "label": "Seconds", "type": "float", "min": 0.5, "max": 30, "step": 0.5},
                       {"key": "steps", "label": "Steps", "type": "int", "min": 2, "max": 50, "advanced": True},
                       {"key": "cfg", "label": "CFG", "type": "float", "min": 1, "max": 7, "step": 0.1, "advanced": True},
                       {"key": "format", "label": "Format", "type": "select", "options": AUDIO_FORMATS, "advanced": True}]},
}

MUSIC_CAPTION_SYSTEM = """You write captions for MiniMax-Music-3, a text-to-music model. Expand the user's idea into exactly
three paragraphs, each starting with its label:
Global Metadata: genre and subgenre, BPM, key and scale, mood and how it develops, listening context, production and mix
(name a clean, wide, high-fidelity modern mix unless the user asks for lo-fi).
Vocal Details: the voice, delivery and harmonies, or "Instrumental, no vocals." when there are no lyrics.
Arrangement: drums, bass, harmonic and lead instruments, then the song sections in order (intro, verses, chorus, bridge,
outro) and what changes in each.
Output only the three paragraphs."""


def effort_params(preset, effort, params):
    """Defaults, then the effort ladder, then explicit params."""
    p = PRESETS[preset]
    o = dict(p["params"])
    lvl = max(1, min(5, int(effort or 3))) - 1
    for k, ladder in p.get("effort", {}).items():
        o[k] = ladder[lvl]
    o.update({k: v for k, v in (params or {}).items() if v not in (None, "")})
    return o


def save_audio(node, prefix, fmt):
    """SaveAudioAdvanced: lossless FLAC by default; its format is a dynamic combo ("format", "format.quality")."""
    kind, _, quality = (fmt or "flac").partition(" ")
    inputs = {"audio": [node, 0], "filename_prefix": prefix, "format": kind}
    if quality:
        inputs["format.quality"] = quality
    return {"class_type": "SaveAudioAdvanced", "inputs": inputs}


def speakers():
    """The voice node's speaker list, read from ComfyUI when it runs (never hardcoded); [] when it is down."""
    if not up():
        return []
    try:
        info = api("/object_info/FB_Qwen3TTSCustomVoice", timeout=5)
        choice = info["FB_Qwen3TTSCustomVoice"]["input"]["required"]["speaker"][0]
        return choice if isinstance(choice, list) else []
    except Exception:
        return []


def api(path, body=None, raw=False, timeout=60):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(URL + path, data=data, headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = r.read()
    return out if raw else json.loads(out)


def up():
    try:
        api("/system_stats", timeout=2)
        return True
    except Exception:
        return False


def headless_pids():
    """ComfyUI processes this app started (main.py with --disable-auto-launch); the Desktop app's never match."""
    try:
        import psutil
    except ImportError:
        return []
    found = []
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            cmd = p.info["cmdline"] or []
            if (p.info["name"] or "").lower().startswith("python") and "--disable-auto-launch" in cmd and any(c.endswith("main.py") for c in cmd):
                found.append(p.pid)
        except (psutil.Error, TypeError):
            pass
    return found


def stop():
    """Kill the headless ComfyUI (its whole process tree); the Desktop app's is left alone."""
    for pid in headless_pids():
        kill_tree(pid)


def free_for_qwen():
    """One GPU: an idle ComfyUI must not hold VRAM while qwen runs (qwen fills 15.8 of 16 GB). The headless one is
    stopped (even freed, its CUDA context keeps ~1 GB); the Desktop app's is asked to /free."""
    try:
        q = api("/queue", timeout=2)
        if q.get("queue_running") or q.get("queue_pending"):
            return
        if headless_pids():
            stop()
            return
        api("/free", {"unload_models": True, "free_memory": True}, raw=True, timeout=10)
    except Exception:
        pass


def start():
    """Start ComfyUI headless unless one answers; returns the seconds spent starting (0 when it was up)."""
    if up():
        return 0.0
    from . import qwen  # one GPU: the qwen server holds about 15 GB while it runs
    t0 = time.time()
    qwen.stop()
    if not os.path.isfile(COMFY_PY):
        raise JobError(f"missing {COMFY_PY} (ComfyUI Desktop install)", 4)
    os.makedirs(CACHE_DIR, exist_ok=True)
    if not headless_pids():
        # the Desktop app's flags: its model-path file maps its own model folders; ComfyUI also reads extra_model_paths.yaml
        args = [COMFY_PY, "-s", os.path.join(COMFY_HOME, "main.py"), "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch",
                "--input-directory", os.path.join(COMFY_SHARED, "input"), "--output-directory", os.path.join(COMFY_SHARED, "output")]
        desktop_paths = sorted(glob.glob(os.path.join(os.environ.get("APPDATA", ""), "Comfy Desktop", "instance-model-paths", "*.yaml")))
        if desktop_paths:
            args += ["--extra-model-paths-config", desktop_paths[-1]]
        # a redirected stdout is cp1252: a custom node logging an emoji then crashed startup (UnicodeEncodeError)
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        spawn(args, os.path.join(CACHE_DIR, "comfy-server.log"), env=env, cwd=COMFY_HOME)
        spawn([sys.executable, "-m", "studio.cli", "watch", "comfy"], cwd=ROOT)
    while time.time() - t0 < 300:
        if up():
            return round(time.time() - t0, 1)
        time.sleep(2)
    raise JobError(f"ComfyUI did not start in 300 s; see {os.path.join(CACHE_DIR, 'comfy-server.log')}", 4)


def watch():
    """Detached: stop the headless ComfyUI after IDLE_S with an empty queue, or as soon as DD2 starts."""
    last = time.time()
    while headless_pids():
        time.sleep(15)
        if dd2_running():
            break
        try:
            q = api("/queue")
            if q.get("queue_running") or q.get("queue_pending"):
                last = time.time()
        except Exception:
            pass
        if time.time() - last > IDLE_S:
            break
    stop()


def upload_image(path):
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        payload = f.read()
    name = os.path.basename(path)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + payload + \
           f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(URL + "/upload/image", data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["name"]


def size(text, default):
    w, h = str(text or default).lower().split("x")
    return int(w) // 32 * 32, int(h) // 32 * 32


def graph(preset, prompt, seed, o):
    if preset == "image":
        w, h = size(o.get("size"), "1344x768")
        return {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "krea2_turbo_fp8_scaled.safetensors", "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2", "device": "default"}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
            "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
            "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0],
                                                       "seed": seed, "steps": int(o["steps"]), "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
            "7": {"class_type": "VAELoader", "inputs": {"vae_name": "qwen_image_vae.safetensors"}},
            "8": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["7", 0]}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": "mediastudio/image"}},
        }
    if preset == "video":
        if not o.get("image"):
            raise JobError("video needs an image (the first frame)", 2)
        w, h = size(o.get("size"), "768x512")
        fps = 24
        frames = int(o.get("seconds") or 5) * fps // 8 * 8 + 1
        return {
            "1": {"class_type": "UnetLoaderGGUF", "inputs": {"unet_name": "ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf"}},
            "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "gemma_3_12B_it_fp8_scaled.safetensors",
                                                             "clip_name2": "ltx-2.3_text_projection_bf16.safetensors", "type": "ltxv", "device": "default"}},
            "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ltx-2.3-22b-distilled_video_vae.safetensors"}},
            "4": {"class_type": "VAELoader", "inputs": {"vae_name": "ltx-2.3-22b-distilled_audio_vae.safetensors"}},
            "5": {"class_type": "LoadImage", "inputs": {"image": upload_image(o["image"])}},
            "6": {"class_type": "ImageScale", "inputs": {"image": ["5", 0], "upscale_method": "lanczos", "width": w, "height": h, "crop": "center"}},
            "7": {"class_type": "LTXVPreprocess", "inputs": {"image": ["6", 0], "img_compression": 18}},
            "8": {"class_type": "EmptyLTXVLatentVideo", "inputs": {"width": w, "height": h, "length": frames, "batch_size": 1}},
            "9": {"class_type": "LTXVImgToVideoInplace", "inputs": {"vae": ["3", 0], "image": ["7", 0], "latent": ["8", 0], "strength": 1.0, "bypass": False}},
            "10": {"class_type": "LTXVEmptyLatentAudio", "inputs": {"audio_vae": ["4", 0], "frames_number": frames, "frame_rate": fps, "batch_size": 1}},
            "11": {"class_type": "LTXVConcatAVLatent", "inputs": {"video_latent": ["9", 0], "audio_latent": ["10", 0]}},
            "12": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
            "13": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": "pc game, console game, video game, cartoon, childish, ugly"}},
            "14": {"class_type": "LTXVConditioning", "inputs": {"positive": ["12", 0], "negative": ["13", 0], "frame_rate": float(fps)}},
            "15": {"class_type": "CFGGuider", "inputs": {"model": ["1", 0], "positive": ["14", 0], "negative": ["14", 1], "cfg": 1.0}},
            "16": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "17": {"class_type": "ManualSigmas", "inputs": {"sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"}},
            "18": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
            "19": {"class_type": "SamplerCustomAdvanced", "inputs": {"noise": ["18", 0], "guider": ["15", 0], "sampler": ["16", 0],
                                                                     "sigmas": ["17", 0], "latent_image": ["11", 0]}},
            "20": {"class_type": "LTXVSeparateAVLatent", "inputs": {"av_latent": ["19", 0]}},
            "21": {"class_type": "VAEDecodeTiled", "inputs": {"samples": ["20", 0], "vae": ["3", 0], "tile_size": 768, "overlap": 64,
                                                              "temporal_size": 4096, "temporal_overlap": 4}},
            "22": {"class_type": "LTXVAudioVAEDecode", "inputs": {"samples": ["20", 1], "audio_vae": ["4", 0]}},
            "23": {"class_type": "CreateVideo", "inputs": {"images": ["21", 0], "audio": ["22", 0], "fps": float(fps)}},
            "24": {"class_type": "SaveVideo", "inputs": {"video": ["23", 0], "filename_prefix": "mediastudio/video", "format": "auto", "codec": "auto"}},
        }
    if preset == "voice":
        return {
            "1": {"class_type": "FB_Qwen3TTSCustomVoice", "inputs": {"text": prompt, "speaker": o.get("speaker") or "Ryan", "model_choice": o["model_choice"],
                                                                     "device": "auto", "precision": "bf16", "language": o.get("language") or "Auto", "seed": seed,
                                                                     "instruct": o.get("instruct") or "", "max_new_tokens": 2048,
                                                                     "top_p": float(o["top_p"]), "temperature": float(o["temperature"])}},
            "2": save_audio("1", "mediastudio/voice", o.get("format")),
        }
    if preset == "music":
        return {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_music3_dit_fp16.safetensors", "weight_dtype": "default"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "minimax_music3_text_encoder_pruned_int8_convrot.safetensors", "type": "minimax", "device": "default"}},
            "3": {"class_type": "MiniMaxMusic3TextEncode", "inputs": {"clip": ["2", 0], "caption": prompt, "lyrics": o.get("lyrics") or "",
                                                                      "seed": seed, "max_duration": float(o.get("seconds") or 60),
                                                                      "cfg_scale": float(o["cfg"]), "top_k": int(o["top_k"])}},
            "4": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["3", 0]}},
            "5": {"class_type": "EmptyMiniMaxMusic3LatentAudio", "inputs": {"seconds": ["3", 1], "batch_size": 1}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0],
                                                       "seed": seed, "steps": int(o["steps"]), "cfg": float(o["cfg"]), "sampler_name": "euler",
                                                       "scheduler": "simple", "denoise": 1.0}},
            "7": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_music3_dav.safetensors"}},
            "8": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["7", 0]}},
            "9": save_audio("8", "mediastudio/music", o.get("format")),
        }
    if preset == "sfx":
        return {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "stable_audio_3_small_sfx.safetensors"}},
            "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": "t5gemma_b_b_ul2.safetensors", "type": "stable_audio", "device": "default"}},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
            "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": float(o.get("seconds") or 5), "batch_size": 1}},
            "6": {"class_type": "KSampler", "inputs": {"model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0],
                                                       "seed": seed, "steps": int(o["steps"]), "cfg": float(o["cfg"]), "sampler_name": "lcm",
                                                       "scheduler": "simple", "denoise": 1.0}},
            "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
            "8": save_audio("7", "mediastudio/sfx", o.get("format")),
        }
    raise JobError(f"unknown preset {preset}", 2)


def new_seed():
    return random.randint(1, 2 ** 31)


def run(preset, prompt, params=None, seed=None, force=False, effort=3, job=None):
    """One job, start to finish. Returns the job data (its "output" is the library file). Raises JobError.
    effort 1 (faster) .. 5 (better) sets the quality parameters; explicit params win."""
    if preset not in PRESETS:
        raise JobError(f"unknown preset {preset}", 2)
    p = PRESETS[preset]
    o = effort_params(preset, effort, params)
    seed = int(seed) if seed not in (None, "") else new_seed()
    if not prompt:
        raise JobError("no prompt given", 2)
    if not force and dd2_running():
        raise JobError("DD2 is running; GPU reserved for the game (force to override)", 3)
    job = job or Job(preset, p["model"], "comfyui", prompt)
    job.update(input_chars=len(prompt), images=1 if o.get("image") else 0, seed=seed, effort=effort)
    prune_jobs()
    idea = prompt
    if preset == "music" and o.get("enhance") and o["enhance"] not in ("false", "0") and "Global Metadata" not in prompt:
        from . import qwen  # MiniMax wants the structured caption its template uses; qwen writes it, then leaves the GPU
        job.update(status="loading", task="caption: " + prompt[:100])
        ask = prompt + ("\n\nLyrics follow, so describe the vocals:\n" + o["lyrics"] if o.get("lyrics") else "\n\nNo lyrics: instrumental.")
        try:
            prompt = qwen.ask(MUSIC_CAPTION_SYSTEM, ask, "music caption", seed=seed % 100000, force=force)
        except JobError as e:
            job.fail(f"caption: {e}", e.code)
        qwen.stop()
        job.update(task=idea[:120])
    try:
        job.update(load_s=start() or None)
    except JobError as e:
        job.fail(str(e), e.code)

    try:
        r = api("/prompt", {"prompt": graph(preset, prompt, seed, o), "client_id": job.id})
    except urllib.error.HTTPError as e:
        job.fail(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:400]}")
    except JobError as e:
        job.fail(str(e), e.code)
    pid = r["prompt_id"]
    job.update(status="running")
    vram = PeakVram()
    try:
        while True:
            time.sleep(1)
            if job.cancelled.is_set():
                api("/interrupt", {}, raw=True)
                job.fail("cancelled", 130, status="cancelled")
            vram.sample()
            h = api(f"/history/{pid}").get(pid)
            if h and h.get("status", {}).get("completed"):
                break
            if h and h.get("status", {}).get("status_str") == "error":
                msgs = [m[1].get("exception_message", "") for m in h["status"].get("messages", []) if m[0] == "execution_error"]
                raise RuntimeError("; ".join(msgs)[:400] or "execution error")
            job.update(throttle=True, progress=min(0.95, job.data["progress"] + 0.005))
    except JobError:
        raise
    except Exception as e:
        job.fail(f"{type(e).__name__}: {e}")

    files = [f for node in h["outputs"].values() for key in ("images", "audio", "video", "gifs") for f in node.get(key, [])]
    if not files:
        job.fail("no output file")
    f = files[0]
    out = output_path(p["kind"], job.id, os.path.splitext(f["filename"])[1] or p["ext"])
    q = urllib.parse.urlencode({"filename": f["filename"], "subfolder": f.get("subfolder", ""), "type": f.get("type", "output")})
    with open(out, "wb") as fh:
        fh.write(api(f"/view?{q}", raw=True, timeout=300))
    write_sidecar(out, {"kind": p["kind"], "engine": "comfy", "preset": preset, "model": p["tag"], "prompt": idea,
                        "caption": prompt if prompt != idea else None, "inputs": [o["image"]] if o.get("image") else [],
                        "params": dict(o, seed=seed, effort=effort)})
    job.update(status="done", progress=1.0, ended=time.time(), output=out, peak_vram_gb=vram.peak, ram_gb=runtime_ram_gb("comfy"))
    return job.data
