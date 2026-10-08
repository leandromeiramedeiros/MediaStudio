# Media Studio install guide (for Claude)

Agent-facing runbook: take a fresh Windows box to a working Media Studio with every mode. Each step has a **check**;
do not move on until it passes. Paths, names and versions are the ones the code expects (`studio/paths.py`,
`studio/qwen.py`, `studio/comfy.py`). Reference box: Ryzen 7 5700X, 32 GB RAM, RTX 5070 Ti 16 GB, Windows 11.

Ask the user before each big download (the sizes are listed) and before installing anything system-wide.

## 0. Modes and what each needs

| Mode | Tabs | Needs |
|---|---|---|
| Core (offline, no GPU) | Review, Shots, Video, Image, Library, System | Python 3.13 + psutil, ffmpeg, Chrome or Edge |
| qwen | Generate (text, SVG, describe), Agent | + llama.cpp CUDA 13, Qwen3.8-27B GGUF + mmproj (14.5 GB), NVIDIA GPU with 16 GB |
| ComfyUI | Generate (image, video, voice, music, sfx) | + ComfyUI Desktop, 2 custom nodes, about 61 GB of models |
| Orchestrate | Orchestrate | qwen + ComfyUI (all presets) |
| Online | qwen web search / fetch | any internet connection; nothing to install (`studio/web.py`) |

Install in this order. Each tier works without the later ones; a missing runtime only fails its own jobs (exit 4).

Disk: about 80 GB for models, plus the library. Driver: a recent NVIDIA driver that supports CUDA 13 (reference: 617.14).

## 1. Core

```powershell
winget install Python.Python.3.13
winget install Gyan.FFmpeg
python -m pip install psutil
```

- Chrome or Edge must be in `Program Files` (`server.py` looks there for the `--app` window).
- ffmpeg: `paths.tool()` checks PATH first, then `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg*`, so a stale PATH before re-login is fine.
- The Gyan full build has libx264 and nvenc but no librsvg. The app rasterizes SVGs itself, so do nothing about it.

**Check:**

```powershell
python --version                                   # 3.13.x
python -c "import psutil, server; print('ok')"     # from the repo root
python -c "from studio.paths import tool; print(tool('ffmpeg'), tool('ffprobe'))"
python server.py                                   # then open http://127.0.0.1:8095/#system
```

`library/` and `data/` are created on first start (`paths.ensure_dirs`). Both are gitignored.

## 2. qwen (llama.cpp)

1. Download the official llama.cpp Windows release: the **CUDA 13** zip plus the matching **cudart** zip (reference: build b11457).
   Unzip both into `~/AI/llama.cpp/` so `llama-server.exe` and `cudart64_13.dll` sit side by side.
2. Download into `~/AI/models/llm/`, with these exact file names (rename if needed):
   - `Qwen3.8-27B-UD-IQ4_XS.gguf` (13.3 GB, unsloth GGUF of Qwen3.8-27B)
   - `Qwen3.8-27B-mmproj.gguf` (0.9 GB, the vision projector from the same repo)

Do not hand-start it for the app. `qwen.start()` launches it on port 8091 with
`-ngl 999 -fa on -c 32768 -ctk q4_0 -ctv q4_0 --parallel 2 -kvu --jinja --mmproj ...`, plus a detached idle watchdog.

**Check:**

```powershell
~/AI/llama.cpp/llama-server.exe --version          # build line, no DLL error
python -m studio.cli qwen raw "Say OK"             # cold start 11-16 s, then about 53 tok/s on stderr
python -m studio.cli stop qwen
```

Under 40 tok/s means VRAM spilled into Windows shared memory. Close other GPU apps; never raise `-c`, slots or KV precision (see `bench/BENCHMARKS.md`).

## 3. ComfyUI

### 3a. Install

1. Install **ComfyUI Desktop** with default paths. The code expects:
   - `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\` (`main.py`, `.venv\Scripts\python.exe`)
   - `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\` (input and output)
2. Run it once so it writes `%APPDATA%\Comfy Desktop\instance-model-paths\*.yaml`, then close it from the tray:
   `taskkill /F /IM "Comfy Desktop.exe" /T`.
3. Write `<ComfyUI>\extra_model_paths.yaml` so the models live outside the install:

```yaml
# Shared model folder, kept outside the install so reinstalls keep the models.
shared:
    base_path: C:/Users/<user>/AI/models/
    checkpoints: checkpoints/
    diffusion_models: |
        diffusion_models/
        unet/
    text_encoders: |
        text_encoders/
        clip/
    vae: vae/
    loras: loras/
    TTS: TTS/
    qwen-tts: TTS/
```

### 3b. Custom nodes

Clone into `<ComfyUI>\custom_nodes\`:

- `https://github.com/city96/ComfyUI-GGUF` (`UnetLoaderGGUF` for LTX)
- `https://github.com/flybirdxx/ComfyUI-Qwen-TTS` (`FB_Qwen3TTSCustomVoice`)

Install their requirements into the ComfyUI venv **only with a constraints file**. Otherwise pip replaces torch:

```powershell
"torch==2.12.1+cu130`ntorchvision==0.27.1`ntorchaudio==2.11.0" | Out-File -Encoding ascii $env:TEMP\pin.txt
& "$env:LOCALAPPDATA\Comfy-Desktop\ComfyUI-Installs\ComfyUI\ComfyUI\.venv\Scripts\python.exe" -m pip install -r <node>\requirements.txt -c $env:TEMP\pin.txt
```

Afterwards run `python -m studio.cli stop comfy`; the next job restarts ComfyUI with the new nodes.

### 3c. Models (`~/AI/models/`)

| Preset | Folder | File | Size | Source |
|---|---|---|---|---|
| image | diffusion_models | `krea2_turbo_fp8_scaled.safetensors` | 12.2 GB | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors) |
| image | text_encoders | `qwen3vl_4b_fp8_scaled.safetensors` | 4.9 GB | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors) |
| image | vae | `qwen_image_vae.safetensors` | 242 MB | [Comfy-Org/Krea-2](https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors) |
| video | diffusion_models | `ltx-2.3-22b-distilled-1.1-Q4_K_M.gguf` | 13.5 GB | LTX-2.3 distilled 1.1 GGUF quant (unverified repo) |
| video | text_encoders | `gemma_3_12B_it_fp8_scaled.safetensors` | 12.6 GB | Comfy-Org/ltx-2 split_files (unverified) |
| video | text_encoders | `ltx-2.3_text_projection_bf16.safetensors` | 2.2 GB | Comfy-Org/ltx-2.3 (unverified) |
| video | vae | `ltx-2.3-22b-distilled_video_vae.safetensors` | 1.4 GB | Comfy-Org/ltx-2.3 (unverified) |
| video | vae | `ltx-2.3-22b-distilled_audio_vae.safetensors` | 348 MB | Comfy-Org/ltx-2.3 (unverified) |
| music | diffusion_models | `minimax_music3_dit_fp16.safetensors` | 4.6 GB | [Comfy-Org/MiniMax-Music-3](https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/diffusion_models/minimax_music3_dit_fp16.safetensors) |
| music | text_encoders | `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | 8.6 GB | [Comfy-Org/MiniMax-Music-3](https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors) |
| music | vae | `minimax_music3_dav.safetensors` | 207 MB | [Comfy-Org/MiniMax-Music-3](https://huggingface.co/Comfy-Org/MiniMax-Music-3/resolve/main/vae/minimax_music3_dav.safetensors) |
| sfx | checkpoints | `stable_audio_3_small_sfx.safetensors` | 2.2 GB | Comfy-Org/stable-audio-3 (unverified) |
| sfx | text_encoders | `t5gemma_b_b_ul2.safetensors` | 1.1 GB | [Comfy-Org/stable-audio-3](https://huggingface.co/Comfy-Org/stable-audio-3/resolve/main/text_encoders/t5gemma_b_b_ul2.safetensors) |
| voice | TTS | `Qwen3-TTS-12Hz-1.7B-CustomVoice/` (whole HF repo folder) | about 4 GB | HF `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` |

- Linked rows were taken from ComfyUI's own workflow templates. For "unverified" rows, find the source in
  `<ComfyUI>\.venv\Lib\site-packages\comfyui_workflow_templates_json\templates\` (grep the file name), or ask the user.
  Never substitute a different quant or file name: `comfy.py` loads these exact names.
- Voice effort 1-2 uses the 0.6B TTS model. The node loads it on demand; if it does not, put `Qwen3-TTS-12Hz-0.6B-CustomVoice/` beside the 1.7B folder.

**Check** (each command starts ComfyUI headless on 8188 and stops qwen):

```powershell
python -m studio.cli comfy image --size 768x432 "a red cube on a desk"     # about 26 s cold
python -m studio.cli comfy sfx --seconds 3 "door slam"
python -m studio.cli comfy voice --speaker Ryan "Testing one two"
python -m studio.cli comfy music --seconds 15 "lofi beat"
python -m studio.cli comfy video --image <png from the image check> --seconds 2 "slow push in"
python -m studio.cli stop comfy
```

On a failure, read `data/cache/comfy-server.log`. "value not in list" means a file name or folder is wrong.
Node input errors: read the node source. Never guess inputs (see `studio/CLAUDE.md`).

## 4. Orchestrate

Needs nothing extra. **Check:** `python -m studio.cli orchestrate --no-music "two-shot teaser of a lighthouse at dusk"`.
It should print an MP4 path and a `library/projects/*.json`.

## 5. Launch

- Desktop shortcut target: `wscript.exe "<repo>\MediaStudio.vbs"`, icon `web\icon.svg` (convert it to `.ico` if needed).
  It runs `pythonw server.py --open`, which opens a Chrome/Edge `--app` window. With a server already running, it only opens a window.
- The server binds `127.0.0.1:8095` only. It exits after 15 min with no window and no job.

**Final check:** open `#system`. It should show the GPU, both runtimes (stopped is fine) and an empty job list.
Then run one job per mode from the UI.

## Gotchas

- `DD2.exe` running: jobs are refused (exit 3) unless forced. That is intended.
- Only one GPU runtime at a time: qwen needs 15.4 of 16 GB, so each runtime stops the other. Expect a swap of about 15 s.
- A Desktop-app ComfyUI on 8188 is used as is and never stopped. If VRAM stays tight, close it from the tray.
- Processes started from scripts must be detached (`studio/jobs.py spawn`), or the caller's job object kills them.
- Set `PYTHONUTF8=1` for ComfyUI (`comfy.start` already does). Without it, an emoji in a node log crashes startup.
- Never pass several files to one `ffmpeg -i`: the second path becomes an output and is overwritten.
