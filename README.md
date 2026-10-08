# Media Studio

A local media workbench that works offline:

- **Review**: open a capture folder and scrub every clip on hover. Keys: Space play, 1/2/4 speed, N/P next/previous clip, I/O mark a take named from your shot list. **Make all** writes Nexus GIFs (640×360, under 8 MB) into the folder. Your progress is saved in the folder.
- **Shots**: screenshots to JPEG at a target size and resolution.
- **Generate**: qwen (Qwen3.8-27B: describe images, SVG, drafts, digest, raw; web search when online). ComfyUI covers image (Krea 2), video (LTX-2.3), voice (Qwen3-TTS), music (MiniMax-Music-3) and sound effects (Stable Audio 3). Every model has a Faster ↔ Better slider.
- **Orchestrate**: describe a scene. Qwen plans the shots, the models make them, ffmpeg cuts a draft.
- **Video** and **Image**: tiny editors. Video has trims, crossfades, overlays, text, music and sfx, rendered by ffmpeg. Image has crop, adjust, text and image layers.
- **System**: CPU/RAM/GPU/VRAM/disk, runtimes, every job.

## Setup

Windows, Python 3.13 with `pip install psutil`, `winget install Gyan.FFmpeg`, and Chrome or Edge.
The local AI also needs:
- llama.cpp in `~/AI/llama.cpp`;
- Qwen3.8-27B GGUF and mmproj in `~/AI/models/llm`;
- ComfyUI Desktop, with models in `~/AI/models`.

Measured setup and numbers are in [bench/BENCHMARKS.md](bench/BENCHMARKS.md).

Start by double-clicking `MediaStudio.vbs` (or its desktop shortcut). For development, run `python server.py` and open http://127.0.0.1:8095.
