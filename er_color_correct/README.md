# ER Color Correct

ComfyUI custom node: color correct with a **real-time preview**. Tweak the parameters and see the result instantly inside the node — no need to re-run the workflow. When you do run it, the exact same correction is applied to the full-quality image.

## Parameters (applied in this order)

1. **hue** — hue rotation in degrees (-180 to 180).
2. **temperature** — color temperature in **Kelvin** (1500–15000). 6500K = neutral daylight, lower = warmer (orange), higher = cooler (blue). Luma-compensated so exposure stays stable.
3. **saturation** — Rec.709 luma-based saturation (0 = grayscale, 1 = neutral).
4. **contrast** — pivot at 0.18.
5. **gamma** — applied as `v^(1/gamma)`.
6. **gain** — master multiplier.
7. **offset** — additive lift.
8. **Color wheels** — three labelled wheels (**Shadows / Midtones / Highlights**): drag the dot from the center towards a color to tint that tonal range (luma-weighted and luma-preserving). Double click a wheel to reset it.

## Usage

1. Connect an image to `images` — if the source is a LoadImage or was already executed, the preview **loads automatically without running**. Otherwise run once.
2. Drag the parameter widgets or the color wheels: the preview updates live (processed in the browser with the same math as the Python node).
3. **Reset** restores everything; hold **👁 Original** to compare with the unprocessed image.
4. Run the workflow to get the corrected image at full quality through the `images` output.

The live preview is capped at 768px for snappy feedback; the output is always processed at full resolution.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
