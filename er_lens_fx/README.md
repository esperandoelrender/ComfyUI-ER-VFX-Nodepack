# ER Lens FX

Three GPU-powered lens nodes for ComfyUI, all with a **real-time preview** (WebGL) that updates live as you move the sliders — no need to re-run the workflow to see what you are doing. The final render runs on your NVIDIA GPU (CUDA) via PyTorch, with CPU fallback.

## ER Lens Effects

- **Lens presets** — modern prime, vintage prime, vintage anamorphic, fisheye, smartphone, dreamy diffusion, old film. Presets fill the values as a starting point; everything stays editable.
- **distortion / fine (k2)** — photographic Brown-Conrady barrel (+) / pincushion (−) distortion, corners pinned.
- **chromatic aberration** — radial RGB fringing towards the edges.
- **vignette** — amount, softness and a movable center.
- **sharpen** — unsharp mask.
- **glow / threshold / size** — soft bloom on the highlights (size as % of image width, resolution-independent).
- **corner softness / diffusion / halation** — optical corner blur, Pro-Mist-style bloom lift and reddish highlight bleed.
- Per-value ⟲, per-group ⟲ and Reset all; numeric fields next to every slider; A|B one-click before/after.

## ER Lens Flare

Procedural lens flare, screen-blended over the image. Up to 4 independent flares, each with a collapsible panel:

- **Look presets** per flare — anamorphic blue, vintage prime, 70s zoom ghosts, golden sun, clean modern, sci-fi streak, night sodium, car headlight. Classic cinema flare looks tied to lens families and eras; presets fill the values as a starting point and everything stays editable (position untouched).

- **Drag the round marker** on the preview to place the light source; **drag the small diamond** orbiting it to aim the **ghost trail** — the angle where the ghost reflections fall across the image (0 = the natural light-to-center axis). The streak and rays always stay straight, like on a real lens. The Ghost angle slider stays in sync.
- **intensity / scale** — overall strength and size.
- **core / core radius** — gain and size of the central hotspot + halo only (dial the bright circle up/down or grow/shrink it without touching ghosts, streak or rays).
- **hue / saturation** — flare tint (markers take the tint too).
- **ghosts** — lens ghost reflections along the light-center axis + halo ring.
- **streak / streak hue / streak width** — anamorphic streak with its own color and thickness.
- **rays / ray count** — starburst rays.
- Per-flare 👁 on/off, ⧉ duplicate (clone every setting — e.g. build one car headlight, duplicate it and drag the copy to the other light), ⟲ reset and ✕ delete; global 👁 hides all markers; A|B one-click before/after.
- **flare_layer** output: just the flare over pure black — the classic screen-blend element, ready as a compositing pass or as an input for other models. Need a transparent PNG? Run it through the native **Image to Mask** + **Join Image with Alpha**.

## ER Lens Camera Dirt

Procedural dirty-lens for images: dust specks and smudges on the front element that **reveal under the image's bright lights**, like a real camera. Deterministic — same seed, same dirt.

- **amount / size / density / smudges / softness** — how much dirt, how big, how many specks, blotchy smudges and edge softness.
- **seed** — regenerate the pattern.
- **base vis. / highlights / threshold** — how visible the dirt is on its own vs. how strongly the blurred highlights reveal it (and from which brightness).
- **tint hue / sat** — dirt tint (slightly warm by default).
- A|B one-click before/after; **dirt_layer** output with just the dirt over pure black for compositing.

## Notes

- Connect an image (or run once) and the preview loads automatically.
- The preview mirrors the exact same math as the GPU render.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
