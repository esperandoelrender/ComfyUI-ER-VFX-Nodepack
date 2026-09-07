# ER Regrain

GPU film grain (regrain) node for ComfyUI with a **real-time preview** (WebGL): move the sliders and see the grain live, no re-run needed. The final render runs on your NVIDIA GPU (CUDA) via PyTorch, with CPU fallback.

- **amount** — grain strength.
- **grain_size** — grain cell size in pixels.
- **color_amount** — 0 = monochrome grain, 1 = full RGB grain.
- **response** — luminance response: 0 = uniform, 1 = strongest in the midtones (film-like).
- **seed** — grain pattern seed.

On frame batches (video) the grain is **animated per frame**, like real film stock.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
