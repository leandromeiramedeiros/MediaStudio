# Media Studio

Local media app by leandromedeiros: capture review and Nexus GIFs, screenshot JPEGs, local AI generation (qwen and
ComfyUI), Orchestrate (qwen directs a whole scene), and a tiny video and image editor on ffmpeg. Offline by default.
Online is optional: qwen can search the web when a connection exists. Python stdlib server + vanilla JS, no build step.
When reporting to me, be extremely concise and sacrifice grammar for sake of concision.

## Layout

- `server.py`: HTTP API, SSE `/api/events` (snapshot, job, text, proxy), static `web/`. Binds 127.0.0.1:8095 only.
  POSTs need the `X-Studio: 1` header, and the Host header must be local.
  The Runner never lets jobs of different GPU runtimes overlap (qwen vs comfy vs director). ffmpeg jobs never wait.
- `web/`:
  - `app.js`: shell, API helpers, pickers, effort slider, job tray.
  - `tabs/<id>.js`: one module per tab; each has `mount(el, arg)`, and optionally `show(arg)`, `hide()`, `onKey(e)`.
  - `gif/`: the Nexus GIF encoder from the old GIF Cutter.
  - `fonts/`: bundled, nothing loads from a CDN.
- `library/<kind>/` (gitignored): every output, each with a `.json` sidecar (engine, preset, model, prompt, params incl. seed and effort).
  Projects are the JSON files in `library/projects/`.
- `data/` (gitignored): `jobs/`, `cache/` (thumbs, proxies, uploads, server logs of qwen and ComfyUI, disk.json), `logs/server.log`, `settings.json`.
- `bench/`: `LocalBench.py`, `BENCHMARKS.md` (measured speeds, quality, pitfalls) and `fixtures/`.

## Run

- Fresh machine or a broken runtime: follow `INSTALL.md` (setup steps with checks, model files and sources).

- `MediaStudio.vbs` (desktop shortcut): pythonw `server.py --open`, which opens a Chrome `--app` window. The server exits after 15 min with no window and no job.
- Dev: `python server.py`, then preview `http://127.0.0.1:8095/#<tab>`.
  After editing JS, use `location.reload()`: a hash-only navigation keeps the old modules.
- CLI: `python -m studio.cli qwen|comfy|orchestrate|render|gif|stop|resources ...` (see `studio/cli.py`).
- Check Python with `python -c "import server"`. Check JS modules by importing each `/web/tabs/*.js` in the page. No node here.

## Runtimes (one 16 GB GPU)

- qwen: `~/AI/llama.cpp/llama-server.exe` with Qwen3.8-27B UD-IQ4_XS + mmproj (`~/AI/models/llm/`), port 8091, `--jinja` (tool calls).
  It runs 32k context shared by 2 slots at about 53 tok/s and needs 15.4 GB.
- ComfyUI: headless from the Desktop install's `.venv` on port 8188. Models in `~/AI/models`.
  A ComfyUI that the Desktop app runs is used as is and never stopped.
- Each runtime stops the other before it starts. Detached watchdogs (`python -m studio.cli watch qwen|comfy`) stop a runtime after 10 idle min or when DD2 starts.
- Jobs are refused while `DD2.exe` runs unless forced.
- Determinism: qwen runs at temperature 0 with a seed (default 42). ComfyUI jobs always have a seed, recorded in the sidecar.
  Regenerate in the Library reuses it.
- Effort (Faster 1 to Better 5, default 3) maps to real parameters:
  - qwen `EFFORT`: thinking and token budget;
  - comfy `PRESETS[*].effort`: steps, resolution, TTS model size.
  - Explicit params override the ladder.
- ComfyUI node facts: `studio/CLAUDE.md`. Never invent node inputs.
- ffmpeg: winget `Gyan.FFmpeg` full build: libx264, nvenc, no librsvg, so the app rasterizes SVGs to PNG before a render.
  `drawtext` gets its text through `textfile=` with `expansion=none`, so no filtergraph escaping is needed.

## Pitfalls

- Processes started by a script must be detached (`studio/jobs.py spawn`), or the caller's job object kills them.
- A redirected ComfyUI stdout is cp1252: set `PYTHONUTF8=1`, or an emoji in a custom node's log crashes startup.
- ComfyUI Desktop hides in the tray; to close it: `taskkill /F /IM "Comfy Desktop.exe" /T`. After installing custom nodes: `python -m studio.cli stop comfy`; the next job restarts it.
- pip into the ComfyUI venv only with a constraints file pinning torch 2.12.1+cu130, torchvision 0.27.1 and torchaudio 2.11.0, or torch gets replaced.
- Never pass a glob of several files to `ffmpeg -i`: the second path becomes an output and is overwritten.
- llama-server's `prompt_n` counts only uncached prompt tokens.

## Git

Work on `main`. Push only when asked. Remote: private `leandromeiramedeiros/MediaStudio`.
