"""Orchestrate: one request in, a draft scene out. Qwen plans, ComfyUI makes the media, ffmpeg assembles it.

1. Plan: qwen turns the request (plus optional reference images) into a shot list, constrained by PLAN_SCHEMA.
2. Media, batched by runtime (one GPU swap): per shot a still (Krea 2), animated by LTX-2.3 when "animate" is on
   and the shot has motion; voice lines (Qwen3-TTS), sound effects (Stable Audio 3), one music bed (MiniMax-Music-3).
3. Assemble: an editor project (library/projects/<id>.json: crossfades, captions, voice, sfx, music) rendered to MP4.
Seeds derive from one base seed, so the same request and seed rebuild the same draft. The project opens in the
Video editor for fixes.
"""
import json
import os
import time

from . import comfy, media, qwen
from .jobs import Job, JobError, output_path, prune_jobs, write_sidecar

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "style": {"type": "string"},
        "shots": {"type": "array", "minItems": 1, "maxItems": 8, "items": {
            "type": "object",
            "properties": {
                "image": {"type": "string"},
                "motion": {"type": "string"},
                "seconds": {"type": "integer", "minimum": 2, "maximum": 8},
                "caption": {"type": "string"},
                "voice": {"type": "string"},
                "sfx": {"type": "string"},
            },
            "required": ["image", "motion", "seconds", "caption", "voice", "sfx"],
        }},
        "music": {"type": "string"},
        "speaker_style": {"type": "string"},
    },
    "required": ["title", "style", "shots", "music", "speaker_style"],
}

SYSTEM = """You are the director of Media Studio, a local tool that drafts short video scenes.
Turn the user's request into a shot list. Your tools, used for you after you answer:
- image: a text-to-image model (Krea 2) makes one still per shot from "image" (+ the shared "style").
  Describe concrete visible things: subject, setting, framing, lighting. No text in images.
- motion: an image-to-video model (LTX-2.3) animates that still for "seconds"; describe the movement and camera
  in one sentence. Empty string = keep the still (a slow zoom is added).
- voice: a text-to-speech model speaks the line during the shot (empty = silent). Keep lines short.
- sfx: a sound-effect model makes a short effect for the shot ("sword clash", "rain"); empty = none.
- caption: on-screen text for the shot (empty = none).
- music: one background track for the whole scene, described as genre, mood, instruments; empty = none.
- speaker_style: how the narrator sounds ("calm, deep male voice").
Rules: 2 to 6 shots unless asked otherwise; seconds 2-8 each; match the user's language for voice and captions.
Answer only with the JSON object."""


def _step(job, steps, text, frac=None):
    steps.append({"at": round(time.time() - job.data["started"], 1), "text": text})
    job.update(steps=steps, progress=frac if frac is not None else job.data["progress"])


def run(request, images=(), seed=42, animate=False, aspect="16:9", music=True, effort=2, force=False, job=None):
    """Returns the orchestration job data; its "output" is the rendered MP4, "project" the editor project file."""
    if not request.strip():
        raise JobError("describe the scene first", 2)
    job = job or Job("orchestrate", "director", "qwen + comfyui + ffmpeg", request)
    prune_jobs()
    steps = []
    job.update(status="running", seed=seed)
    W, H = {"16:9": (1280, 720), "9:16": (720, 1280), "1:1": (1024, 1024)}.get(aspect, (1280, 720))
    gen = {"16:9": "1344x768", "9:16": "768x1344", "1:1": "1024x1024"}.get(aspect, "1344x768")
    vid = {"16:9": "768x512", "9:16": "512x768", "1:1": "640x640"}.get(aspect, "768x512")

    def child(fn, *a, **k):
        if job.cancelled.is_set():
            job.fail("cancelled", 130, status="cancelled")
        try:
            return fn(*a, **k)
        except JobError as e:
            job.fail(f"{e}", e.code)

    # 1. plan
    _step(job, steps, "Qwen is writing the shot list", 0.02)
    plan, pj = child(qwen.chat_json, SYSTEM, request, PLAN_SCHEMA, "plan: " + request, images=list(images), seed=seed, force=force)
    shots = plan["shots"][:8]
    _step(job, steps, f"Plan: \"{plan['title']}\", {len(shots)} shots", 0.08)
    job.update(plan=plan)
    music_caption = None
    if music and plan["music"].strip():  # while qwen is loaded: the structured caption MiniMax needs
        _step(job, steps, "Qwen is writing the music caption", 0.09)
        music_caption = child(qwen.ask, comfy.MUSIC_CAPTION_SYSTEM, plan["music"] + "\n\nNo lyrics: instrumental.", "music caption",
                              seed=seed, force=force)
    qwen.stop()  # one GPU: hand it to ComfyUI now instead of on the first media job

    # 2. media, ComfyUI only from here on
    total_jobs = len(shots) * (2 if animate else 1) + sum(1 for s in shots if s["voice"]) + sum(1 for s in shots if s["sfx"]) + (1 if music and plan["music"] else 0)
    done = [0]

    def media_job(preset, prompt, params, k):
        _step(job, steps, f"{comfy.PRESETS[preset]['label']} {k}: {prompt[:70]}", 0.1 + 0.75 * done[0] / max(1, total_jobs))
        r = child(comfy.run, preset, prompt, params, seed=seed + k, force=force, effort=effort)
        done[0] += 1
        return r["output"]

    style = plan["style"].strip()
    for i, s in enumerate(shots):
        s["still"] = media_job("image", f"{s['image']}. {style}" if style else s["image"], {"size": gen}, 100 + i)
    if animate:
        for i, s in enumerate(shots):
            if s["motion"].strip():
                s["clip"] = media_job("video", s["motion"], {"image": s["still"], "size": vid, "seconds": s["seconds"]}, 200 + i)
    for i, s in enumerate(shots):
        if s["voice"].strip():
            s["voice_file"] = media_job("voice", s["voice"], {"instruct": plan["speaker_style"]}, 300 + i)
        if s["sfx"].strip():
            s["sfx_file"] = media_job("sfx", s["sfx"], {"seconds": min(8, s["seconds"])}, 400 + i)
    total = sum(s["seconds"] for s in shots) - 0.4 * (len(shots) - 1)
    music_file = None
    if music and plan["music"].strip():
        music_file = media_job("music", music_caption or plan["music"], {"seconds": int(total) + 2, "enhance": False}, 500)

    # 3. assemble
    _step(job, steps, "Assembling the timeline", 0.87)
    v1, v2, audio, t = [], [], [], 0.0
    for i, s in enumerate(shots):
        d = float(s["seconds"])
        if s.get("clip"):
            v1.append({"src": s["clip"], "kind": "video", "in": 0, "out": d, "xfade": 0.4, "vol": 0.6})
        else:
            v1.append({"src": s["still"], "kind": "image", "dur": d, "zoom": True, "xfade": 0.4})
        if s["caption"].strip():
            v2.append({"kind": "text", "text": s["caption"], "start": t + 0.2, "end": t + d - 0.3, "x": 0.5, "y": 0.86, "size": H // 16})
        if s.get("voice_file"):
            audio.append({"src": s["voice_file"], "start": t + 0.3, "vol": 1.0, "track": "fx"})
        if s.get("sfx_file"):
            audio.append({"src": s["sfx_file"], "start": t, "vol": 0.7, "track": "fx"})
        t += d - 0.4
    if music_file:
        audio.append({"src": music_file, "start": 0, "vol": 0.35, "fadein": 1.0, "fadeout": 2.0, "track": "music"})
    project = {"title": plan["title"], "w": W, "h": H, "fps": 30, "v1": v1, "v2": v2, "audio": audio,
               "orchestrate": {"request": request, "seed": seed, "animate": animate, "aspect": aspect, "effort": effort, "plan": plan}}
    ppath = output_path("projects", job.id, ".json")
    with open(ppath, "w", encoding="utf-8") as f:
        json.dump(project, f, indent=1)
    rj = Job("render", "ffmpeg", "ffmpeg", plan["title"])
    rj.cancelled = job.cancelled
    r = child(media.render, project, job=rj)
    out = r["output"]
    write_sidecar(out, {"kind": "renders", "engine": "orchestrate", "preset": "orchestrate", "model": "qwen + comfyui + ffmpeg",
                        "prompt": request, "inputs": list(images), "project": ppath,
                        "params": {"seed": seed, "animate": animate, "aspect": aspect, "music": music, "effort": effort}})
    _step(job, steps, f"Done: {os.path.basename(out)}", 1.0)
    job.update(status="done", progress=1.0, ended=time.time(), output=out, project=ppath)
    return job.data
