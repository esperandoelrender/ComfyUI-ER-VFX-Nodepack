# ER Model Downloader

ComfyUI custom node: add it to any workflow, press **🔍 Scan workflow**, and it lists **every model file the workflow uses**, which `models/` subfolder each one belongs to (checkpoints, loras, vae, text_encoders, diffusion_models, controlnet...), and whether it is **already installed or missing** — checked against your real model folders.

For each missing model:

- If the workflow embeds a download URL (modern template workflows do), it is pre-filled.
- **🔎 HF** searches the exact file name on HuggingFace and fills the URL of the best match.
- Or paste any `https://` URL manually.
- **⬇** downloads it straight into the selected folder with a live progress bar — or use **⬇ Download all missing**.

Downloads resume-safe: files are written as `.part` and renamed only when complete. The target folder for each file can be changed with the dropdown before downloading.

## Notes

- Gated HuggingFace models (401/403) need a token: set the `HF_TOKEN` environment variable before launching ComfyUI, or download manually.
- After downloading, refresh the loader combos (press `R` in ComfyUI) so the new files appear.
- Only `https://` URLs and real ComfyUI model folders are accepted by the server endpoint.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
