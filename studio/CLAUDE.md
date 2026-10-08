# ComfyUI node facts

- Audio is saved with `SaveAudioAdvanced`. Its format is a dynamic combo sent as `"format": "mp3"` plus `"format.quality": "320k"`. FLAC is the default.
- MiniMax-Music-3 needs the template's structured caption: Global Metadata / Vocal Details / Arrangement. Short captions sound muffled, so `enhance` has qwen write it (`MUSIC_CAPTION_SYSTEM`).
- Official settings live in the templates: `standalone-env/Lib/site-packages/comfyui_workflow_templates_json/templates/`.
- Read the speaker list etc. from the node source (`custom_nodes/ComfyUI-Qwen-TTS/nodes.py`). Never invent node inputs.
