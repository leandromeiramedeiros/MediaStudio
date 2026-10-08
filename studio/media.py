"""ffmpeg and ffprobe: media info, posters and scrub proxies, timeline renders, GIF export.

A project (the Video editor's JSON, also written by Orchestrate) renders with one ffmpeg run:
  {"w": 1280, "h": 720, "fps": 30,
   "v1": [{"src": path, "kind": "video|image|gif", "in": s, "out": s, "dur": s (images), "zoom": bool (images: slow push-in),
           "xfade": s (crossfade into the next clip), "vol": 0..2}],
   "v2": [{"src": png/gif path, "start": s, "end": s, "x": 0..1, "y": 0..1, "scale": 0..1 of width, "opacity": 0..1}
          or {"kind": "text", "text": str, "start", "end", "x", "y", "size": px, "color": "#fff"}],
   "audio": [{"src": path, "start": s, "in": s, "out": s, "vol": 0..2, "fadein": s, "fadeout": s, "track": "music|fx"}]}
x/y are the overlay's center as a fraction of the frame. SVGs are rasterized to PNG by the app before they get here
(this ffmpeg build has no librsvg).
"""
import json
import os
import re
import subprocess
import time

from .jobs import Job, JobError, output_path, prune_jobs, write_sidecar
from .paths import CACHE_DIR, LIBRARY, NO_WINDOW, tool

VIDEO_EXT = (".mp4", ".mkv", ".mov", ".webm", ".avi", ".m4v")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
AUDIO_EXT = (".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac")
FONT = os.path.join(os.environ.get("WINDIR", "C:\\Windows"), "Fonts", "segoeuib.ttf")
NEXUS_GIF = {"limit": 8_000_000, "w": 640, "h": 360}


def kind_of(path):
    low = path.lower()
    if low.endswith(".gif"):
        return "gif"
    if low.endswith(".svg"):
        return "svg"
    if low.endswith(VIDEO_EXT):
        return "video"
    if low.endswith(IMAGE_EXT):
        return "image"
    if low.endswith(AUDIO_EXT):
        return "audio"
    return None


def _run(args, timeout=None):
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       creationflags=NO_WINDOW)
    if p.returncode:
        raise JobError(f"{os.path.basename(args[0])} failed: " + (p.stderr.strip().splitlines() or ["?"])[-1][:300])
    return p.stdout


def probe(path):
    """{dur, w, h, fps, audio} (dur 0 for still images)."""
    out = json.loads(_run([tool("ffprobe"), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path], timeout=30))
    v = next((s for s in out.get("streams", []) if s.get("codec_type") == "video"), {})
    a = any(s.get("codec_type") == "audio" for s in out.get("streams", []))
    num, _, den = (v.get("avg_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0
    dur = float(out.get("format", {}).get("duration") or v.get("duration") or 0)
    if kind_of(path) == "image":
        dur = 0
    return {"dur": round(dur, 3), "w": v.get("width"), "h": v.get("height"), "fps": round(fps, 2), "audio": a}


def poster(src, out, at=None):
    """A 480-px-wide JPEG of one frame (images: the image itself)."""
    os.makedirs(os.path.dirname(out), exist_ok=True)
    seek = [] if kind_of(src) == "image" else ["-ss", str(at if at is not None else 1.0)]
    try:
        _run([tool("ffmpeg"), "-y", "-v", "error", *seek, "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out], timeout=60)
    except JobError:  # clips shorter than the seek point
        _run([tool("ffmpeg"), "-y", "-v", "error", "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", out], timeout=60)
    return out


def proxy(src, out):
    """A small silent copy for hover scrubbing: 480 px wide, a keyframe every 5 frames so any seek is instant."""
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".part.mp4"
    _run([tool("ffmpeg"), "-y", "-v", "error", "-i", src, "-an", "-vf", "scale=480:-2,fps=30", "-c:v", "libx264", "-preset", "ultrafast",
          "-crf", "28", "-g", "5", "-pix_fmt", "yuv420p", "-movflags", "+faststart", tmp], timeout=1800)
    os.replace(tmp, out)
    return out


def _progress_run(args, job, total_s):
    """Run ffmpeg with -progress on stdout; feeds job progress; honors cancel."""
    p = subprocess.Popen(args + ["-progress", "pipe:1", "-nostats"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    err = []
    import threading
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    for line in p.stdout:
        if job.cancelled.is_set():
            p.kill()
            job.fail("cancelled", 130, status="cancelled")
        m = re.match(r"out_time_us=(\d+)", line)
        if m and total_s:
            job.update(throttle=True, status="running", progress=min(0.99, int(m[1]) / 1e6 / total_s))
    p.wait()
    if p.returncode:
        lines = [l for l in "".join(err).strip().splitlines() if "Terminating thread" not in l and "Task finished" not in l]
        job.fail("ffmpeg: " + (lines[-1][:300] if lines else f"exit {p.returncode}"))


def _even(n):
    return max(2, int(round(n / 2)) * 2)


def build(project):
    """Returns (ffmpeg args without output, total seconds)."""
    W, H, FPS = _even(project.get("w", 1280)), _even(project.get("h", 720)), int(project.get("fps", 30))
    v1 = project.get("v1") or []
    if not v1:
        raise JobError("the timeline has no clips", 2)
    args, filters, audio = [tool("ffmpeg"), "-y", "-v", "error"], [], []
    n = 0

    def add_input(*opts):
        nonlocal n
        args.extend(opts)
        n += 1
        return n - 1

    # V1: the sequence
    durs, starts, t = [], [], 0.0
    for i, c in enumerate(v1):
        k = c.get("kind") or kind_of(c["src"])
        zoom = k == "image" and c.get("zoom")
        if zoom:  # slow push-in on a still (Ken Burns): one input frame, zoompan makes the rest
            d = float(c.get("dur") or 3)
            idx = add_input("-i", c["src"])
            frames = int(d * FPS)
            filters.append(f"[{idx}:v]scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},"
                           f"zoompan=z='1+0.12*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS}[z{i}]")
            has_audio = False
        elif k == "image":
            d = float(c.get("dur") or 3)
            idx = add_input("-loop", "1", "-framerate", str(FPS), "-t", f"{d:.3f}", "-i", c["src"])
            has_audio = False
        else:
            info = probe(c["src"])
            a, b = float(c.get("in") or 0), float(c.get("out") or info["dur"] or 3)
            d = max(0.1, b - a)
            idx = add_input("-ss", f"{a:.3f}", "-t", f"{d:.3f}", "-i", c["src"])
            has_audio = info["audio"]
        xf = min(float(v1[i - 1].get("xfade") or 0), d / 2, durs[-1] / 2) if i else 0.0
        start = t - xf
        starts.append(start)
        durs.append(d)
        t = start + d
        filters.append(f"[{f'z{i}' if zoom else f'{idx}:v'}]scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color=black,"
                       f"setsar=1,fps={FPS},format=yuv420p,trim=duration={d:.3f},setpts=PTS-STARTPTS[c{i}]")
        vol = float(c.get("vol", 1))
        if has_audio and vol > 0:
            audio.append((f"{idx}:a", start, 0.0, d, vol, 0.0, 0.0))
    total = t
    cur = "c0"
    for i in range(1, len(v1)):
        xf = durs[i - 1] + starts[i - 1] - starts[i]
        out = f"s{i}"
        if xf > 0.01:
            filters.append(f"[{cur}][c{i}]xfade=transition=fade:duration={xf:.3f}:offset={starts[i]:.3f}[{out}]")
        else:
            filters.append(f"[{cur}][c{i}]concat=n=2:v=1:a=0[{out}]")
        cur = out

    # V2: overlays, in order (later ones on top)
    for j, o in enumerate(project.get("v2") or []):
        s, e = float(o.get("start") or 0), float(o.get("end") or total)
        e = min(e, total)
        if e <= s:
            continue
        en = f"enable='between(t,{s:.3f},{e:.3f})'"
        out = f"o{j}"
        if o.get("kind") == "text":
            # text goes through a file with expansion off: no filtergraph escaping of quotes, colons or %
            os.makedirs(CACHE_DIR, exist_ok=True)
            tf = os.path.join(CACHE_DIR, f"text-{os.getpid()}-{j}.txt")
            with open(tf, "w", encoding="utf-8") as f:
                f.write(str(o.get("text", "")))
            size = int(o.get("size") or H // 12)
            color = re.sub(r"[^0-9a-fA-F]", "", o.get("color") or "#ffffff")[:8] or "ffffff"
            x, y = float(o.get("x", 0.5)), float(o.get("y", 0.85))
            esc = lambda p: p.replace("\\", "/").replace(":", "\\:")  # noqa: E731
            filters.append(f"[{cur}]drawtext=fontfile='{esc(FONT)}':textfile='{esc(tf)}':expansion=none:fontsize={size}:fontcolor=0x{color}:"
                           f"borderw={max(1, size // 14)}:bordercolor=black@0.7:x=w*{x:.4f}-text_w/2:y=h*{y:.4f}-text_h/2:{en}[{out}]")
        else:
            k = o.get("kind") or kind_of(o["src"])
            if k == "gif":
                idx = add_input("-ignore_loop", "0", "-i", o["src"])
            elif k == "video":
                idx = add_input("-stream_loop", "-1", "-i", o["src"])
            else:
                idx = add_input("-loop", "1", "-framerate", str(FPS), "-i", o["src"])
            ow = _even(W * float(o.get("scale") or 0.3))
            op = float(o.get("opacity", 1))
            x, y = float(o.get("x", 0.5)), float(o.get("y", 0.5))
            filters.append(f"[{idx}:v]scale={ow}:-2,format=rgba,colorchannelmixer=aa={op:.3f},fps={FPS},"
                           f"trim=duration={e - s:.3f},setpts=PTS-STARTPTS+{s:.3f}/TB[ov{j}]")
            filters.append(f"[{cur}][ov{j}]overlay=x=W*{x:.4f}-w/2:y=H*{y:.4f}-h/2:eof_action=pass:{en}[{out}]")
        cur = out
    filters.append(f"[{cur}]format=yuv420p[vout]")

    # Audio: clip sound plus the music and fx tracks, each delayed to its start, then mixed
    for a in project.get("audio") or []:
        info = probe(a["src"])
        i0 = float(a.get("in") or 0)
        i1 = float(a.get("out") or info["dur"] or 0)
        start = float(a.get("start") or 0)
        d = max(0.05, min(i1 - i0, total - start))
        if start >= total:
            continue
        idx = add_input("-ss", f"{i0:.3f}", "-t", f"{d:.3f}", "-i", a["src"])
        audio.append((f"{idx}:a", start, 0.0, d, float(a.get("vol", 1)), float(a.get("fadein") or 0), float(a.get("fadeout") or 0)))
    if audio:
        labels = []
        for k, (src, start, _, d, vol, fi, fo) in enumerate(audio):
            chain = f"[{src}]aresample=48000,aformat=channel_layouts=stereo,atrim=duration={d:.3f},asetpts=PTS-STARTPTS,volume={vol:.3f}"
            if fi > 0:
                chain += f",afade=t=in:st=0:d={fi:.3f}"
            if fo > 0:
                chain += f",afade=t=out:st={max(0, d - fo):.3f}:d={fo:.3f}"
            ms = int(start * 1000)
            chain += f",adelay={ms}|{ms}[a{k}]"
            filters.append(chain)
            labels.append(f"[a{k}]")
        filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:normalize=0:dropout_transition=0,"
                       f"alimiter=limit=0.95,atrim=duration={total:.3f}[aout]")
    args += ["-filter_complex", ";".join(filters), "-map", "[vout]"]
    if audio:
        args += ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS), "-t", f"{total:.3f}", "-movflags", "+faststart"]
    return args, total


def render(project, name=None, job=None):
    """Render a project to library/renders/<id>.mp4 (+ sidecar with the project). Returns the job data."""
    job = job or Job("render", "ffmpeg", "ffmpeg", name or project.get("title") or "timeline")
    prune_jobs()
    try:
        args, total = build(project)
    except JobError as e:
        job.fail(str(e), e.code)
    out = output_path("renders", job.id, ".mp4")
    tmp = out + ".part.mp4"
    job.update(status="running")
    try:
        _progress_run(args + [tmp], job, total)
    finally:
        if os.path.exists(tmp) and job.data["status"] != "running":
            os.remove(tmp)
    os.replace(tmp, out)
    write_sidecar(out, {"kind": "renders", "engine": "ffmpeg", "preset": "render", "model": "ffmpeg", "prompt": project.get("title", ""),
                        "params": {"project": project}})
    job.update(status="done", progress=1.0, ended=time.time(), output=out, size=os.path.getsize(out))
    return job.data


def nexus_gif(src, out=None, start=0.0, end=None, job=None):
    """A GIF under 8 MB inside 640x360 via palettegen, stepping fps and colors down until it fits."""
    job = job or Job("gif", "ffmpeg", "ffmpeg", os.path.basename(src))
    out = out or output_path("gif", job.id, ".gif")
    info = probe(src)
    end = end or info["dur"]
    W, H = NEXUS_GIF["w"], NEXUS_GIF["h"]
    job.update(status="running")
    for i, (fps, colors) in enumerate(((15, 256), (13, 256), (12, 128), (10, 128), (10, 64), (8, 32))):
        if job.cancelled.is_set():
            job.fail("cancelled", 130, status="cancelled")
        vf = (f"fps={fps},scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];"
              f"[a]palettegen=max_colors={colors}:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle")
        _run([tool("ffmpeg"), "-y", "-v", "error", "-ss", f"{start:.3f}", "-t", f"{end - start:.3f}", "-i", src,
              "-filter_complex", vf, "-loop", "0", out], timeout=1800)
        job.update(progress=(i + 1) / 6)
        if os.path.getsize(out) <= NEXUS_GIF["limit"]:
            break
    if os.path.abspath(out).startswith(LIBRARY):  # a GIF written into a capture folder gets no sidecar there
        write_sidecar(out, {"kind": "gif", "engine": "ffmpeg", "preset": "gif", "model": "ffmpeg", "prompt": "",
                            "inputs": [src], "params": {"start": start, "end": end, "fps": fps, "colors": colors}})
    job.update(status="done", progress=1.0, ended=time.time(), output=out, size=os.path.getsize(out), fps=fps, colors=colors)
    return job.data
