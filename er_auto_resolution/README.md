# ER Auto Resolution

ComfyUI custom node: connect a Load Image, pick the **model you are going to work with** (SD 1.5, SDXL, FLUX.1, FLUX.2/Klein, SD 3.5, Qwen-Image, HiDream) and the **aspect ratio** (1:1, 4:3, 16:9, 9:16, 21:9...), and the image is resized to the optimal resolution for that model — no manual math, no typing values.

## How it works

- Each model has a pixel budget (SD 1.5 ≈ 0.26MP, SDXL/SD3.5/FLUX.1 ≈ 1MP, FLUX.2/Klein 2–4MP, Qwen-Image ≈ 1.76MP) and a dimension multiple (64 or 16). The node computes the largest resolution for your ratio inside that budget, rounded correctly — e.g. SDXL 16:9 → 1344×768 (the official bucket).
- **aspect_ratio = auto** picks the listed ratio closest to your input image.
- **mode**: `crop` (fill and center-crop, default), `pad` (fit with black bars), `stretch` (distort).
- The green label inside the node shows the target resolution **live** as you change model/ratio.
- Outputs: the resized `image`, plus `width` and `height` (INT) to feed an Empty Latent or anything else.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
