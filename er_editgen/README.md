# ER EditGen

Multi-reference generative editing in a **single node**. Plug in up to 4 reference images plus a prompt, and it does the rest: scaling, VAE encoding, the reference chain on both the positive and the negative conditioning, the model's own noise schedule and the sampling.

It works with edit models that take **reference latents**: FLUX.2 klein, FLUX.1 Kontext, Qwen-Image-Edit and friends. The model family is detected automatically — there is nothing to pick.

## Why one node

The manual wiring for a two-image edit is a Scale → VAE Encode → Set Reference Latent per image, **twice** (the negative conditioning needs the same references or the model drifts), plus the three loaders, the empty latent at the right size, the scheduler, the guider and the sampler. That is around 18 nodes for something you do all day. ER EditGen is those 18 nodes, wired the way the official templates wire them.

The model, the text encoder and the VAE are picked **inside the node** (`unet_name`, `clip_name`, `clip_type`, `vae_name`) so there is nothing to cable: drop the node, choose your model, plug your images, write the prompt. They are kept loaded between runs, so switching seeds or prompts never re-reads gigabytes from disk. If you prefer your own loaders — or share one model across several nodes — connect them to the `model` / `clip` / `vae` inputs and they take over (the node shows a 🔌 badge when that happens).

The ⚙ button folds away the settings you only touch once (encoder type, dtype, sampler, scheduler, size), and ⤢ grows the prompt box when you are writing something long.

## Iterating without recompressing

Every time you decode a result to an image and encode it again to keep editing, the VAE loses a little: colours shift, fine detail smears. Round after round it piles up — the classic generation loss.

Press **⛓** on the node to reveal its **latent** input. Together with the **latent** output (same latent space) you can chain rounds without ever going through the VAE:

```
ER EditGen  ──latent──▶  ER EditGen  ──latent──▶  ER EditGen  ──images──▶  Save
 "put it on a table"      "make it night"          "add a reflection"
```

Each node still shows its own preview, but the pixels only get encoded once (from your source image) and decoded once (at the end of the chain). The node marks the chain with a **⛓ latent** badge when the input is connected.

## Inputs

The node starts with a single **image_1** socket and nothing else. Connect it and **image_2** appears, connect that one and **image_3** shows up, and so on up to 8 — you only ever see one free slot, never a wall of empty connectors. The first reference sets the output size; the rest are extra material (a product to insert, a style, a character...).

The **latent** socket is hidden until you ask for it with the **⛓ latent** button, so the node stays clean when you are not chaining.

## Edit lock (`preserve`)

Generative edit models repaint the WHOLE image on every edit — even the parts
you didn't ask to change drift a little each round. The `preserve` setting
(under ⚙) kills that: after sampling, the node detects where the image really
changed, keeps the model's result there, and grafts the original latent back
everywhere else — **bit-exact**. Chain as many edits as you want: only the
edited regions ever pay the model's re-render cost. The info tag shows how
much was locked ("lock 80%").

- `auto` (default): detects the changed region; steps aside automatically when
  the edit is global (relighting, color grades...).
- `strong`: tighter detection, locks more.
- `off`: raw model output.

## Inpainting

Connect a **mask** (white = regenerate, black = untouched) and the node switches to inpaint mode: it rebuilds only the masked area over `image_1` (or over the chained latent), guided by the prompt. The base image is deliberately NOT fed as a reference in this mode — edit models would just reconstruct the original masked content from it — so write the prompt describing **what the masked area should contain** ("a red sports car", not "change the car"). Any extra images (`image_2`...) still act as reference material for the hole. Paint the mask right in ComfyUI's Load Image / Preview mask editor and plug it straight in.

## Fitting into an existing workflow

Drop the node into a scene that already uses your edit model with its own UNET/CLIP/VAE loaders and it **adopts those selections automatically** — no re-picking.

The **LoRA** button opens a list where you can stack as many LoRAs as you want, each with its own dropdown and strength, loaded internally onto both the model and the text encoder — no LoraLoader nodes to wire. Empty list = none; the button shows how many are active (LoRA · 2).

## Parameters

- **text** — what to generate, or how to edit the references.
- **seed / steps / cfg** — 4 steps and cfg 1.0 are the distilled FLUX.2 klein defaults; base models want ~20-28 steps.
- **megapixels** — working resolution. References are scaled to this and the output matches the first one.
- **denoise** — 1.0 generates from scratch. Below 1.0 it *refines the connected latent* directly instead, which is the other lossless way to iterate: same image, a little more of the prompt.
- **sampler_name / scheduler / width / height** (optional) — `auto` scheduler picks the model's own schedule (the empirical one FLUX.2 needs); width/height at 0 follow the first reference.

## Notes

- With `cfg` at 1.0 the negative pass is skipped by ComfyUI, so it costs nothing — but it is built correctly for when you raise it.
- If a reference input carries a batch, only the first frame is used as reference.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
