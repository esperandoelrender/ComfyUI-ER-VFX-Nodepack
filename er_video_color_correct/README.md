# ER Video Color Correct

ComfyUI custom node: color correct for **video** with a real-time **GPU preview**. The video plays inside the node with the correction applied live by a WebGL shader — tweak the parameters and the playing video updates instantly, no re-run needed. When you run the workflow, the exact same correction is applied to every frame at full quality.

## Parameters (applied in this order)

1. **hue** — hue rotation in degrees (-180 to 180).
2. **temperature** — color temperature in **Kelvin** (1500–15000). 6500K = neutral daylight, lower = warmer (orange), higher = cooler (blue). Luma-compensated.
3. **saturation** — Rec.709 luma-based saturation.
4. **contrast** — pivot at 0.18.
5. **gamma** — applied as `v^(1/gamma)`.
6. **gain** — master multiplier.
7. **offset** — additive lift.
8. **Color wheels** — three labelled wheels (**Shadows / Midtones / Highlights**): drag the dot towards a color to tint that tonal range. Double click a wheel to reset it.

Plus **fps** for the preview playback framerate.

## Playback controls

- **⏸ / ▶** pause/play, **timeline** to scrub frame by frame (the correction stays live while paused or scrubbing).
- **Reset** restores everything; hold **👁 Original** to compare with the unprocessed video.

## Usage

1. Connect a video (`IMAGE` frame batch) — if the source is a Load Video node or was already executed, the preview **loads automatically without running**. Otherwise run once: the node encodes a downscaled MP4 proxy (max 512px) for smooth playback.
2. Grade in real time on the playing video.
3. Run the workflow to apply the correction to all frames at full resolution through the `images` output.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.

Requires the `av` (PyAV) package, bundled with recent ComfyUI versions. If missing: `pip install av`.
