# ER Combine

Layer compositing in one node: stack up to 4 layers over a **base** image,
each with its own blend mode and opacity, with a live preview.

- A new `layer_N` input appears as you connect the previous one (up to 4).
  Layers composite in order: 1 first, then 2 on top of that result, and so on.
- **Modes:** normal, add, screen, multiply, overlay, soft light, difference,
  lighten, darken — the live preview uses the exact same operations as the
  final render, so what you see is what you export.
- **Alpha aware:** RGBA layers (like the `*_layer_alpha` outputs of ER Lens
  Flare / Glow / Camera Dirt / Regrain) composite with their own per-pixel
  alpha. RGB light layers over pure black work best with `add` or `screen`;
  the grain layer (mid-gray) with `overlay`.
- Layers of a different size are scaled to the base automatically. On batches,
  a single-frame layer is reused across all frames.
- **A|B** in the viewer toggles composite / base with one click.

Typical use: `images` from your generation into `base`, `flare_layer` /
`dirt_layer` / `glow_layer` into the layer inputs, pick `add`, done.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
