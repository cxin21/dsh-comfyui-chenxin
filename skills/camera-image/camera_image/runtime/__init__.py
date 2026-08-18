"""camera-image runtime: Anima fixed-asset UI -> API workflow customization.

Modules:
  assets        — bundled UI asset + manifest integrity check
  camera_map    — semantic direction/elevation/distance -> node 583 floats
  config        — all RunConfig dataclasses (one per asset slot)
  contracts     — post-strip API graph structural validation
  graph         — patch_ui: the single graph transformation function
  lora          — LoRA inventory resolution + node 26/66 patch
  presets       — preset table (camera + image_size shortcut)
  request       — parse_request: JSON -> typed RunConfig
"""
