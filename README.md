# ER VFX Nodepack

**Film-grade VFX tools for ComfyUI, with GPU live previews on every node.**

[![Comfy Registry](https://img.shields.io/badge/Comfy%20Registry-er--vfx--nodepack-blue)](https://registry.comfy.org/publishers/eracademy/nodes/er-vfx-nodepack)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1.0-lightgrey)](pyproject.toml)

19 nodes built by a VFX artist for VFX work: generative editing, lens optics, glow, grain, color correction with a vectorscope, relighting, layer compositing, wedging and more. Every node processes the final render on the GPU (PyTorch/CUDA, CPU fallback) and shows you a **real-time preview inside the node** using the exact same math — tweak, see, run.

<!-- TODO screenshots: drop 2-3 PNGs into docs/ and uncomment
| | | |
|---|---|---|
| ![ER EditGen](docs/screenshot_editgen.png) | ![ER Lens Flare](docs/screenshot_lens_flare.png) | ![ER Color Correct](docs/screenshot_color_correct.png) |
-->

Docs en español: [esperandoelrender.com](https://esperandoelrender.com)

---

## Install

**ComfyUI Manager (recommended)** — open Manager → *Custom Nodes Manager* → search **"ER VFX Nodepack"** → Install → restart ComfyUI.

**Manual**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/esperandoelrender/ComfyUI-ER-VFX-Nodepack.git
```

Restart ComfyUI. All nodes appear under the `image/adjust`, `image/generation`, `image/transform`, `utils` and `preview` categories — search for **"ER"** in the node menu.

> If you previously installed the individual `er_*` packs, remove those folders from `custom_nodes/` first — this pack replaces all of them.

---

## Node catalog

| Node | Category | What it does |
|---|---|---|
| [ER EditGen](#er-editgen) | image/generation | Multi-reference generative editing (FLUX.2 klein / Kontext / Qwen-Edit) in one node |
| [ER Combine](#er-combine) | image/adjust | Layer compositing: base + up to 4 layers with blend modes and opacity |
| [ER Lens Effects](#er-lens-effects) | image/adjust | Distortion, chromatic aberration, vignette, diffusion/halation, sharpen |
| [ER Lens Flare](#er-lens-flare) | image/adjust | Up to 4 procedural flares, draggable in the viewport, 8 cinema presets |
| [ER Camera Defocus](#er-camera-defocus) | image/adjust | Aperture-shaped defocus: disc or N-blade bokeh with highlight boost |
| [ER Lens Camera Dirt](#er-lens-camera-dirt) | image/adjust | Procedural dust/smudges revealed by highlights |
| [ER Glow](#er-glow) | image/adjust | Soft-knee multi-octave optical glow, anamorphic, dispersion |
| [ER Regrain](#er-regrain) | image/adjust | Film grain with luminance response, animated per frame |
| [ER Color Correct](#er-color-correct) | image/adjust | Full CC: Kelvin temp/tint, tone, 3 color wheels, secondaries, vectorscope |
| [ER Video Color Correct](#er-video-color-correct) | image/adjust | Video CC with real-time WebGL playback preview |
| [ER Grade](#er-grade) | image/adjust | Black/white match against a reference image with in-viewport pickers |
| [ER Relighting](#er-relighting) | image/adjust | Screen-space relighting with draggable point lights |
| [ER Auto Resolution](#er-auto-resolution) | image/transform | Optimal resolution per model (SD1.5, SDXL, FLUX, Qwen…) and aspect |
| [ER Wedge Sequencer](#er-wedge-sequencer--er-wedge-preview) (+Video) | utils | VFX-style wedging: run value lists/ranges and compare labelled results |
| [ER Wedge Preview](#er-wedge-sequencer--er-wedge-preview) (+Video) | utils | Client-facing gallery of every wedge + contact sheet export |
| [ER Video Comparer](#er-video-comparer) | preview | Real-time A/B wipe between two videos |
| [ER Model Downloader](#er-model-downloader) | utils | Scans the workflow for missing models and downloads each to its folder |

Each sub-folder (`er_editgen/`, `er_lens_fx/`, …) ships its own detailed README.

### ER EditGen

Multi-reference generative editing for edit models that take reference latents — **FLUX.2 klein, FLUX.1 Kontext, Qwen-Image-Edit** — in a single node. The model family is detected automatically.

- Internal cached loaders (`unet_name` / `clip_name` / `vae_name`) — nothing to wire, nothing re-read from disk between runs; external `model` / `clip` / `vae` inputs take over if connected (🔌 badge).
- klein auto-defaults (4 steps, cfg 1.0, the model's own noise schedule via `scheduler = auto`).
- Dynamic image slots: a new `image_N` appears as you connect the previous one (up to 8). The first reference sets the output size.
- Internal LoRA list: stack any number of LoRAs with per-entry strength, applied to model and text encoder.
- Inpaint by mask: connect a `mask` and the node rebuilds only the masked area.
- Latent chaining (⛓): `latent` in/out so rounds of edits never go through the VAE.
- `preserve` edit-lock: after sampling, detects the changed region and grafts the original latent back everywhere else — **bit-exact** outside the edited region (`auto` / `strong` / `off`).
- Live sampler preview.

[Full docs →](er_editgen/README.md)

### ER Combine

Layer compositing in one node: a `base` plus up to 4 layers (a new `layer_N` input appears as you connect the previous one), each with its own blend mode — normal, add, screen, multiply, overlay, soft light, difference, lighten, darken — and 0–1 opacity. Alpha-aware (RGBA layers use their own per-pixel alpha), layers of a different size are scaled to the base, single-frame layers are reused across batches. The live preview uses the exact same operations as the render; **A|B** toggles composite / base.

[Full docs →](er_combine/README.md)

### ER Lens Effects

Photographic lens simulation with 7 lens presets as starting points: Brown-Conrady distortion (+ fine k2), radial chromatic aberration, vignette with movable center, unsharp-mask sharpen, highlight glow, corner softness, Pro-Mist-style diffusion and reddish halation. Per-value / per-group reset, A|B before/after. GPU live preview.

[Full docs →](er_lens_fx/README.md)

### ER Lens Flare

Up to 4 independent procedural flares. **Drag the round marker** on the preview to place the light and **drag the small diamond** to aim the ghost trail. Core + halo with their own gain/radius, lens ghosts, anamorphic streak (own hue and width), starburst rays with count and angle, hue/saturation tint, 8 cinema-look presets (anamorphic blue, vintage prime, 70s zoom ghosts, golden sun, clean modern, sci-fi streak, night sodium, car headlight). Per-flare 👁 / ⧉ duplicate / ⟲ / ✕. Outputs the flare as a layer too.

[Full docs →](er_lens_fx/README.md)

### ER Camera Defocus

True aperture-shaped defocus: disc or N-blade polygon bokeh with blade rotation, highlight boost so speculars bloom into proper bokeh shapes, chromatic fringe. Radius expressed in % of image width, so it is resolution independent.

[Full docs →](er_lens_fx/README.md)

### ER Lens Camera Dirt

Procedural dirty-lens: dust specks and smudges on the front element that **reveal under the image's bright lights**. Deterministic by seed. Controls for amount, size, density, smudges, softness, base visibility, highlight reveal and threshold, tint. Layer outputs.

[Full docs →](er_lens_fx/README.md)

### ER Glow

Glow/bloom built as a **multi-octave optical pyramid** instead of a single blur: soft-knee highlight extraction (threshold, knee, boost, 4 extract modes), size in % of width, octaves and falloff to distribute energy between tight core and long tail, anamorphic stretch, gain/gamma/saturation/tint and chromatic **dispersion** across octaves. Add / Screen / Max blend, Result / Glow only / Highlights views. Layer outputs.

[Full docs →](er_glow/README.md)

### ER Regrain

Film grain with stock-like controls: amount, grain size, color amount (mono → RGB), luminance response (uniform → midtone-weighted like real stock), seed. **Animated per frame** on batches. Layer outputs.

[Full docs →](er_regrain/README.md)

#### Layer outputs

The four "light" nodes — **ER Lens Flare, ER Glow, ER Lens Camera Dirt, ER Regrain** — give a **double output** besides the composited image:

- `*_layer` — the element over black (RGB): the classic screen/add pass, and a clean input for edit models.
- `*_layer_alpha` — the element with alpha (RGBA), for normal compositing in **ER Combine** or any other compositor.

### ER Color Correct

Full color correction with a real-time preview: hue, **temperature in Kelvin** / tint (luma-compensated), saturation, contrast (pivot 0.18), gamma, gain, offset, three **color wheels** (Shadows / Midtones / Highlights), hue-band **secondaries** with a mask view, and a custom **vectorscope with skin-tone line**. Foldable panels, Reset, hold 👁 to compare with the original. The preview is processed in the browser with the same math as the Python node; the output is always full resolution.

[Full docs →](er_color_correct/README.md)

### ER Video Color Correct

The same correction stack for **video**: the frame batch plays inside the node with the grade applied live by a WebGL shader. Play/pause, timeline scrubbing, hold 👁 Original. The node encodes a downscaled MP4 proxy for playback; the workflow run applies the grade to every frame at full quality.

[Full docs →](er_video_color_correct/README.md)

### ER Grade

Classic **grade** with black/white match: pick blackpoint and whitepoint on your image and on a **reference image** with in-viewport pickers (3×3 average), and the node remaps one to the other — plus manual multiply, offset and gamma. Result / Input / Ref viewer tabs switch automatically while picking. Picked points are saved with the workflow.

[Full docs →](er_grade/README.md)

### ER Relighting

Screen-space relighting with up to 4 **draggable point lights** (color, intensity, radius, height). Normals are derived from a depth map (with pre-smoothing and clamped gradients to kill banding), or use a real normal map through the `normals` input; without depth a luminance pseudo-depth keeps it working out of the box. Result / Lights / Depth / Normals views.

[Full docs →](er_relighting/README.md)

### ER Auto Resolution

Pick the **model** (SD 1.5, SDXL, FLUX.1, FLUX.2/Klein, SD 3.5, Qwen-Image, HiDream) and the **aspect ratio** (or `auto` from the input image) and the node resizes to the optimal bucket for that model — e.g. SDXL 16:9 → 1344×768. Crop / pad / stretch modes, live target label, `width` and `height` INT outputs.

[Full docs →](er_auto_resolution/README.md)

### ER Wedge Sequencer / ER Wedge Preview

VFX-style **wedging** (as in Houdini): link any node widget, give it a list (`7, 7.5, 8`), a range (`1:10:2`) or random seeds (`rand5`), and run every combination (capped at 64). Results appear in the node at native aspect with the values overlaid; right-click → **Save contact sheet** exports one PNG with everything. **ER Wedge Preview** is a clean, client-facing gallery that mirrors every sequencer in the graph. Both come in image and **video** variants (frame batches get an MP4 proxy).

[Full docs →](er_batch_sequencer/README.md)

### ER Video Comparer

Real-time **A/B wipe** between two videos (frame batches): drag the wipe line, play/pause both in sync, scrub the timeline. Different resolutions are letterboxed automatically; different durations loop B against A. Auto FPS.

[Full docs →](er_video_comparer/README.md)

### ER Model Downloader

Press **Scan workflow** and the node lists every model file the workflow uses, which `models/` subfolder it belongs to, and whether it is installed or **missing**. For missing ones it pre-fills embedded URLs, searches HuggingFace by exact file name (blob → resolve rewrite, HTML responses rejected) or accepts a pasted `https://` URL, then downloads to the right folder with a progress bar, resume-safe (`.part` files). Gated HF models need `HF_TOKEN` in the environment.

[Full docs →](er_model_downloader/README.md)

---

## Requirements

- A recent ComfyUI (the nodes use ComfyUI's own `torch` / `numpy`; no extra Python dependencies are installed).
- The video nodes (ER Video Color Correct, ER Video Comparer, ER Wedge Sequencer Video) use **PyAV**, which recent ComfyUI builds already bundle. If it is missing: `pip install av`.
- GPU previews run in the browser (WebGL); final renders run on CUDA when available, CPU otherwise.

## Repository layout

```
ComfyUI-ER-VFX-Nodepack/
├── __init__.py          # aggregator: collects NODE_CLASS_MAPPINGS from every er_* sub-package
├── pyproject.toml       # Comfy Registry metadata
├── web/                 # shared front-end (er_theme.js, logo.png, one .js per pack)
└── er_*/                # one folder per pack: __init__.py (nodes) + README.md (docs)
```

## License

MIT — see [LICENSE](LICENSE).

Made by **Héctor Gallego ([ER Academy](https://esperandoelrender.com))** — built end-to-end with AI-assisted development.
