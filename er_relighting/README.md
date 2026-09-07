# ER Relighting

ComfyUI custom node: **screen-space relighting** of a photo with a real-time **GPU preview** (WebGL). Add up to 4 point lights, drag them over the image, tune color / intensity / radius / height — and see the result instantly. The same math is applied in full quality when you run the workflow.

## How it works

- The node computes **normals from the depth map**: the depth is pre-smoothed (`normal_smooth`, triple box blur) before taking central-difference gradients, and gradients are clamped — this removes the banding/noise artifacts typical of raw depth-to-normal conversion. Each pixel is shaded with Lambertian point lights and distance attenuation.
- Connect a **depth map** to the optional `depth` input (e.g. **Depth Anything**) for best results — white = near (enable `invert_depth` if yours is reversed).
- For the highest quality, connect a real **normal map** to the optional `normals` input (e.g. from NormalCrafter, OpenGL convention): it replaces the depth-derived normals entirely.
- With no depth connected, a luminance-based pseudo-depth is derived from the image so the node still works out of the box.

## Lights

- **＋ Light** adds a point light (max 4). **Drag the marker** on the image to move it.
- Select a light via its chip (L1–L4) to edit: **color**, **Int** (intensity), **Rad** (attenuation radius), **Z** (height above the image). **✕** deletes it.
- `ambient` controls how much of the original lighting remains — set it to **0** to black out the image and see only your lights; `normal_strength` scales the relief of the derived normals.
- **View** button cycles **Result / Lights / Depth / Normals** — the Lights view shows the pure light contribution on a neutral background, ideal for tuning falloff and radius.

## Usage

1. Connect the image (and ideally a depth map) and run once — or, with a LoadImage source, the preview loads automatically.
2. Add lights and grade in real time; hold **👁 Original** to compare; **Reset** clears everything.
3. Run the workflow to render all frames at full resolution through the `images` output.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
