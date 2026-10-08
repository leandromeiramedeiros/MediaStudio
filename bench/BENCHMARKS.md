# Local agents: setup, measurements, pitfalls

Measured 2026-10-06/07 on Ryzen 7 5700X, 32 GB RAM, RTX 5070 Ti 16 GB (Windows 11). Rules for when to delegate live in
CLAUDE.md (Local agents); this file holds the numbers behind them. Raw runs: `local/suite/` (gitignored).

## Setup

- Text and vision: Qwen3.8-27B UD-IQ4_XS (unsloth GGUF, 13.3 GB) + its vision projector (0.9 GB) in `~/AI/models/llm/`, served by the official llama.cpp release (CUDA 13 build + cudart zip, b11457) in `~/AI/llama.cpp/`. `Local.py` starts `llama-server` on port 8091 and a detached watchdog (`Local.py --watch`) that stops it after 10 idle minutes or when DD2 starts.
- Server flags: `-ngl 999 -fa on -c 32768 -ctk q4_0 -ctv q4_0 --parallel 2 -kvu --mmproj ...` (32k context shared by 2 slots; one request may use all of it while the other slot is idle).
- Media: ComfyUI from the Desktop install (`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI`, its `.venv` python), started headless by `Comfy.py` (`main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch`, the Desktop app's model-path file and input/output folders) with its own idle watchdog. The Desktop app is not needed; a ComfyUI it runs is used as is and never stopped.
- Removed: Ollama (2x slower here, see below) and Muse Glimmer-30B (8 tok/s, reasoning always on, worse drafts).

## Speed (qwen)

| Setup | Generation | Note |
|---|---|---|
| Ollama 0.40, ctx 8k / 16k | 28 / 25 tok/s | keeps 8-9% of the model on the CPU |
| llama-server, 16k q8 KV, no vision | 53 tok/s | 15.5 GB VRAM |
| llama-server, 32k q4 KV, vision (chosen) | 53 tok/s | 15.4-15.8 GB VRAM |
| llama-server, 48k q4 KV, vision | 51 tok/s | too close to the VRAM edge |
| 32k q8 KV, 64k q4 KV, MTP drafting (n 2 or 3), 4 slots | 2-18 tok/s | spills past VRAM into Windows' shared-memory fallback |

- Prompt reading: about 1,850 tok/s (an 8k-token log is read in 4.5 s).
- Parallel: 2 slots give 91-93 tok/s together (48 each); a third request waits for a slot. Short answers report low tok/s (startup overhead), not a slowdown.
- Cold start: 11-16 s to load; swap back after ComfyUI 16 s. Answers to short prompts take 1-2 s warm.
- MTP (Qwen3.8's multi-token prediction heads, in this GGUF) gave +60% on a 24 GB card in published tests, but on 16 GB its draft context pushes the model past VRAM: slower here.

## Quality (qwen, script-scored)

- SVG: 6/6 valid documents with viewBox (5 icons, 1 banner with its title text), 7-15 s each.
- Image text: quoted banner and logo titles exactly in 3/3 images; a clipboard screenshot was described correctly in 3 s.
- Drafts: BBCode feature list from mod notes balanced and correct (5 s); `--think` gave the same quality in 3x the time.
- Arithmetic: 3/3.
- Digest of logs: unreliable for errors. A 61-error Log.sh output kept 29; the 300-line game log (52 distinct errors) kept 22 in one run and 9 in another (output truncated at 1,500 tokens); `--think` kept 0; an "every distinct error" prompt kept 5. Errors always come from scripts.
- Lua and mod code: not delegated (an earlier benchmark showed invented game type names).

## Speed (ComfyUI, warm unless noted)

| Job | Time |
|---|---|
| Krea 2 image 1344x768 | 15 s cold, 10 s warm |
| Krea 2 image 768x432 | 4 s |
| Krea 2 image 1024x1024 | 10 s |
| ComfyUI headless start + first image | 26 s |
| Stable Audio 3 sfx, 3-5 s | 4 s |
| Qwen3-TTS voice line | 29-42 s |
| MiniMax-Music-3, 30 s track | about 30-40 s |
| LTX-2.3 video, 5 s with audio, 768x512 | about 70 s |

Jobs queued at once run one after another in ComfyUI (4 media jobs: 141 s wall for 306 s of summed waiting).

## Pitfalls

- One GPU: qwen needs 15.4 GB of 16. Anything else on the GPU (an idle ComfyUI keeps about 1 GB even after `/free`) pushes qwen into the shared-memory fallback (18 tok/s or worse), so the scripts stop the other server instead of freeing it.
- Ollama's bundled llama-server runs on the CPU unless its `cuda_v13` folder is on PATH with `GGML_BACKEND_PATH` set (moot now that Ollama is gone).
- llama-server's `prompt_n` counts only uncached prompt tokens: a repeated prefix shows small "in" numbers.
- Reading stdin when it is not a terminal hangs in a background shell (stdin never closes): `Local.py` reads stdin only with `--file -`.
- A test suite writing a job's input and its `--out` answer to the same file overwrites the input: keep them apart.
- Processes started by a script must be detached (`DETACHED_PROCESS`, `CREATE_NEW_PROCESS_GROUP`, `CREATE_BREAKAWAY_FROM_JOB`) or the calling shell's job object kills them.
- ComfyUI Desktop hides in the tray: closing it takes `taskkill /F /IM "Comfy Desktop.exe" /T`.
