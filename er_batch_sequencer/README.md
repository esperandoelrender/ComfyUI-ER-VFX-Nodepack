# ER Wedge Sequencer

ComfyUI custom nodes for **VFX-style wedging** (as in Houdini): run several iterations of your workflow with different parameter values and compare every result side by side, each one labelled with the values that produced it. Works for **images and videos** (frame batches get an MP4 proxy automatically).

The pack ships two nodes:

- **ER Wedge Sequencer** — define and run the wedges, results appear in the node.
- **ER Wedge Preview** — a clean, client-facing gallery that mirrors every wedge result with its attributes (WEDGE 1, WEDGE 2...), ready to present.

## ER Wedge Sequencer

1. Route the image/video you want to compare into the node's `images` input (it also passes them through, so you can keep chaining).
2. **＋ Wedge** adds a wedge (Wedge 1, Wedge 2...). Inside each wedge, **＋ param** adds a parameter row: pick the **node**, pick its **widget**, and type the values:
   - list: `7, 7.5, 8`
   - range: `1:10:2` (start:end:step)
   - random seeds: `rand5` (5 random values)
   - text values for combos also work: `euler, dpmpp_2m`
3. A wedge with a list of values expands into one run per value (several params in a wedge = all combinations, capped at 64 runs total).
4. **▶ Run wedges** queues the executions and restores your original widget values afterwards.
5. Results appear in the grid at their native aspect ratio, with the parameter values overlaid on the image (`W1 · seed: 123`). Click a result to open it full size. **🗑** clears the grid. Results are saved with the workflow.
6. **Right-click the node → "🖼 Save contact sheet"** downloads a single PNG with ALL the results and their labels.

## ER Wedge Preview

Drop it anywhere in the workflow — no wiring needed. It automatically mirrors the results of every ER Wedge Sequencer in the graph (or pick one from the dropdown), grouped per wedge with their attributes. Use **🖼 Contact sheet** (or right-click) to export one PNG with everything, perfect for sending to a client.

## Notes

- Runs are matched to results in queue order — avoid queueing unrelated prompts while wedges are running.
- Video proxies are capped at 448px for a smooth grid; click to open the full file.
- Requires PyAV (`av`) for video proxies, bundled with recent ComfyUI versions.

## Installation

Copy this folder into `ComfyUI/custom_nodes/` and restart ComfyUI.
