# ER Video Comparer

ComfyUI custom node to compare two videos (`IMAGE` frame batches) with a real-time wipe slider.

## Usage

1. Search for **"ER Video Comparer"** (category `preview`).
2. Connect:
   - `video_a` → your generated video (shown on the **left** side of the slider)
   - `video_b` → your reference video (shown on the **right** side)
   - `fps` → preview framerate (default 16)
3. Run the workflow. Both videos are encoded to MP4 (H.264 via PyAV) in the temp folder and play in sync inside the node.

## Controls

- **Drag or click** on the video to move the wipe line (left = A, right = B).
- **⏸ / ▶** to pause/play both videos at once.
- **Timeline** to scrub frame by frame with both videos in sync.
- Videos with different resolutions or aspect ratios are aligned automatically (letterboxed if needed).
- If the videos have different durations, B loops in sync against A.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.

Requires the `av` (PyAV) package, bundled with recent ComfyUI versions. If missing: `pip install av`.

## Notes

Previews are written to ComfyUI's `temp` folder, which is cleared automatically on every server restart — re-run the workflow to regenerate them.
