# ER Grade

ComfyUI custom node: classic **grade** with **black/white match pickers** and a real-time preview. Sample the blackpoint and whitepoint of your image, sample the target black/white of a **reference image**, and the node remaps your image to match — plus manual `multiply`, `offset` and `gamma` controls.

## The math

Per channel: `A = multiply · (gain − lift) / (whitepoint − blackpoint)`, `B = offset + lift − A · blackpoint`, `out = (A · v + B)^(1/gamma)` — where blackpoint/whitepoint are measured on your image and lift/gain are the target values (usually picked from the reference).

## Usage

1. Connect your image to `images` (and optionally a reference to `reference`) and run once — with a LoadImage source the preview loads automatically.
2. Pick with the four buttons (the swatch under each button shows the sampled color; 3×3 pixel average):
   - **⚫ In black** — click the darkest area of *your* image (blackpoint).
   - **⚪ In white** — click the brightest area of *your* image (whitepoint).
   - **⚫ Ref black** — click the darkest area of the *reference* (the view switches to it automatically).
   - **⚪ Ref white** — click the brightest area of the *reference*.
3. The viewer has three tabs — **Result** (the new graded image), **Input** (your original, untouched) and **Ref** (the reference). When you arm a picker, the viewer jumps to the right tab automatically (Input for the In pickers, Ref for the Ref pickers) and returns to Result after picking — you always sample on intact pixels.
4. The Result regrades live. Fine-tune with `multiply`, `offset`, `gamma`. **Reset** restores everything.
5. Run the workflow: the exact same grade is applied to all frames at full resolution.

The picked points are saved with the workflow.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
