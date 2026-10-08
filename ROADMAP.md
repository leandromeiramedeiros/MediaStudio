# Media Studio roadmap (for Claude)

Planned additions, saved 2026-10-08 so the user can ask "install X from ROADMAP.md" later. Model picks come from
knowledge up to mid-2026: **check for newer versions and the exact ComfyUI file names before downloading**, and ask the
user before each big download, as `INSTALL.md` says.

## Same style for every item

- Each feature is a `studio/comfy.py` `PRESETS` entry: label, model, tag, kind, ext, params, an `effort` ladder for 1 to 5, and
  `fields`. The Generate tab, the CLI (`python -m studio.cli comfy <preset>`), Orchestrate and Regenerate in the Library all
  pick it up from there.
- Runs on the comfy runtime, so the Runner keeps it off qwen's GPU time. Always seeded; the seed goes in the sidecar.
- Add the model rows plus a **check** command to `INSTALL.md` 3b/3c, and add node facts (real input names from the node
  source) to `studio/CLAUDE.md`. Never invent node inputs.
- Add the measured speed and VRAM use on the 16 GB card to `bench/BENCHMARKS.md`.
- Everything stays local and offline. No content filter in the app: uncensored means the models, not added code.

Suggested order: 1 voice clone (small, reuses the existing node pack), 2 edit + upscale, 3 Wan.

## 1. Voice clone (`clone` preset, or a mode of `voice`)

- First try **Qwen3-TTS-12Hz-1.7B-Base** (and 0.6B-Base for effort 1-2). It clones from about 3 s of reference audio plus
  its transcript. The `ComfyUI-Qwen-TTS` pack may already have a clone node: read `nodes.py` for its name and inputs.
  This costs about 4 GB of models and no new runtime.
- If quality or emotion falls short: **IndexTTS2** (zero-shot clone, emotion and duration control), **Chatterbox**
  (5 s clone, an "exaggeration" knob), **VibeVoice 1.5B** (long multi-speaker dialog). **Seed-VC** converts an existing
  recording, singing included, into the cloned voice: a separate `convert` preset.
- Voices library: `library/voices/<name>.flac` plus `.json` (transcript, language, source). Record in-app with the mic
  (MediaRecorder) or upload, with trimming in the editor. The Speaker select lists clones next to the built-in speakers.
- Optional: whisper.cpp `large-v3-turbo` to transcribe the reference automatically (qwen cannot hear audio).
- Clone only voices the user owns or has consent for.

## 2. Uncensored edit loop (`edit` + `upscale` presets)

- Editor model: **Qwen-Image-Edit 2511** (or 2509) GGUF Q4_K_M/Q5_K_M through ComfyUI-GGUF (about 12 GB), its Qwen2.5-VL-7B
  fp8 text encoder (about 9 GB), and `qwen_image_vae` (already installed). Lightning 4/8-step LoRA for effort 1-3.
- Uncensoring: the base model has no filter, only weak NSFW priors. Add community uncensored/NSFW LoRAs (a LoRA field
  in `fields`, files in `~/AI/models/loras/`) and, if it helps, an abliterated Qwen2.5-VL encoder. Verify current options.
- Mask fallback for local fixes: inpaint with **Chroma** (uncensored Flux-schnell retrain) using a brush mask drawn in the
  Image tab, or an auto mask from **SAM 2**.
- Upscale: **SeedVR2** (3B fp8 for effort 1-3, 7B for 4-5), images now and video later.
- Loop UX: Library item, then Edit, then edit the result again, and so on. The sidecar gets `parent` (the input file) so the
  chain can be traced and stepped back. Up to 3 input images (Edit 2509+ takes several). An Upscale button on any image.
- Effort: steps through the ladder, e.g. `[4, 4, 8, 20, 40]`, with the Lightning LoRA on at the low rungs.

## 3. Wan video (`wan` preset; LTX stays)

- **Wan 2.2 TI2V-5B** (fp8/fp16, fits natively, 720p) for effort 1-2. **Wan 2.2 14B I2V/T2V** GGUF Q4 high-noise plus low-noise
  pair with the lightx2v 4-step LoRA for effort 3-5. Encoder `umt5_xxl_fp8`, VAE `wan2.2_vae` (5B) / `wan_2.1_vae` (14B).
- Text-to-video and image-to-video in one preset (`needs_image` optional). Seconds and size fields like `video`.
- Wan has no audio (LTX-2 does): Orchestrate or the editor adds voice, sfx and music. Later: **Wan 2.2 S2V** or **InfiniteTalk**
  to lip-sync a portrait to a cloned voice, which combines items 1 and 3.
- Many Wan LoRAs exist (motion, style, NSFW): reuse the LoRA field from item 2.
- Disk: about 10 GB (5B), plus about 20 GB (14B pair) and about 7 GB (encoder).
