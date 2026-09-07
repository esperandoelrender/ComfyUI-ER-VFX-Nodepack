# ER Glow

Advanced GPU glow / bloom node for ComfyUI with a **real-time preview** (WebGL): move the sliders and see the glow live, no re-run needed. The final render runs on your NVIDIA GPU (CUDA) via PyTorch, with CPU fallback, and works on single images and frame batches (video).

Instead of a single blur, the glow is built as a **multi-octave optical pyramid** (like the optical glow gizmos used in compositing): several blur scales are stacked, so you get a bright tight core plus a long soft tail, and you control how the energy is distributed between them.

The controls are grouped in collapsible panels (same UI as ER Lens FX / ER Regrain). Every slider has a numeric field, double click resets it, and each panel header has a **⟲** to reset that group.

## Highlights — what goes into the glow

- **Threshold** — level above which pixels start to glow.
- **Knee** — soft knee around the threshold: 0 = hard cut, higher = smooth roll-in (no banding on gradients).
- **Boost** — gain applied to the extracted highlights before blurring.
- **Extract** — how brightness is measured: `Rec709 luma`, `Max RGB`, `Average` or `Per channel` (per channel keeps the highlight color and is the most saturated look).

## Shape — the glow itself

- **Size %** — extent of the widest octave, as a % of image width (resolution independent).
- **Octaves** — number of blur scales stacked. Each one is half the size of the previous. More octaves = smoother, more "optical" falloff.
- **Falloff** — how the energy is distributed between octaves. Below 1 the small scales dominate (tight, punchy core); at 1 all scales weigh the same (hazy, atmospheric); above 1 the wide tail dominates (big soft bloom).
- **Anamorphic** — horizontal / vertical stretch of the glow (1 = circular). Area preserving, so brightness does not change.

## Color — grading the glow before compositing

- **Gain** — glow brightness.
- **Gamma** — shapes the falloff curve: below 1 crushes the tail, above 1 lifts it.
- **Saturation** — saturation of the glow (0 = white glow, >1 to push the source hues).
- **Tint hue / Tint amount** — tint the glow (amount 0 = untinted).
- **Dispersion** — chromatic dispersion: the wider octaves get progressively hue-shifted, which gives that coloured optical tail around the core.

## Composite

- **Blend** — `Add` (linear light, physically the closest to real glow), `Screen` (protects the highlights, never clips) or `Max`.
- **Mix** — glow opacity.
- **View** — `Result`, `Glow only` (glow over black) or `Highlights` (what the threshold is actually extracting — the fastest way to dial Threshold / Knee). The active view is labelled on the preview.

## Notes

- Connect an image (or run once) and the preview loads automatically.
- The preview mirrors the same math as the GPU render (same soft knee, same pyramid, same blend), at preview resolution.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
