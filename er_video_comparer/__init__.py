import os
import time
import random
from fractions import Fraction

import numpy as np
import av
import folder_paths


def encode_video(images, fps, path, crf=19):
    """Encode a ComfyUI IMAGE batch (B,H,W,C float 0-1) to an H.264 MP4."""
    frames = np.clip(images.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    h, w = frames.shape[1], frames.shape[2]
    # H.264 with yuv420p requires even dimensions
    w2, h2 = w - (w % 2), h - (h % 2)

    container = av.open(path, mode="w")
    stream = container.add_stream("libx264", rate=Fraction(fps).limit_denominator(1000))
    stream.width = w2
    stream.height = h2
    stream.pix_fmt = "yuv420p"
    stream.options = {"crf": str(crf), "preset": "veryfast"}

    for f in frames:
        frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(f[:h2, :w2, :3]), format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def _probe_fps(name):
    """FPS real de un fichero de video del directorio de inputs."""
    try:
        name = str(name).split(" [")[0]
        path = folder_paths.get_annotated_filepath(name)
        if not path or not os.path.isfile(path):
            return None
        with av.open(path) as c:
            if not c.streams.video:
                return None
            rate = c.streams.video[0].average_rate
            if rate:
                return float(rate)
    except Exception:
        return None
    return None


def _walk_fps(prompt, start_id, depth=0, seen=None):
    """Busca aguas arriba un fps explicito (CreateVideo, VHS...) o un fichero
    de video cargado (LoadVideo) del que leer el frame rate real."""
    if seen is None:
        seen = set()
    node = prompt.get(str(start_id)) if isinstance(prompt, dict) else None
    if not node or str(start_id) in seen or depth > 12:
        return None
    seen.add(str(start_id))
    ins = node.get("inputs", {})
    for key in ("fps", "frame_rate", "force_rate"):
        v = ins.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
    for key in ("file", "video"):
        v = ins.get(key)
        if isinstance(v, str) and v:
            fps = _probe_fps(v)
            if fps:
                return fps
    for v in ins.values():
        if isinstance(v, list) and len(v) == 2:
            fps = _walk_fps(prompt, v[0], depth + 1, seen)
            if fps:
                return fps
    return None


class VideoCompareSlider:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video_a": ("IMAGE", {"tooltip": "Generated video (left side of the slider)"}),
                "video_b": ("IMAGE", {"tooltip": "Reference video (right side of the slider)"}),
                "fps": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 120.0, "step": 0.5,
                    "tooltip": "0 = auto-detect from the source video in this workflow; set a value to override",
                }),
            },
            "hidden": {"prompt": "PROMPT", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ()
    FUNCTION = "compare"
    OUTPUT_NODE = True
    CATEGORY = "preview"
    DESCRIPTION = (
        "Compare two videos with a real-time wipe slider. fps at 0 detects "
        "the frame rate automatically from the workflow (an upstream video "
        "file or an explicit fps on a video node)."
    )

    def compare(self, video_a, video_b, fps=0.0, prompt=None, unique_id=None):
        if not fps or fps <= 0:
            detected = None
            if isinstance(prompt, dict) and unique_id is not None:
                me = prompt.get(str(unique_id), {})
                for inp in ("video_a", "video_b"):
                    v = me.get("inputs", {}).get(inp)
                    if isinstance(v, list) and len(v) == 2:
                        detected = _walk_fps(prompt, v[0])
                        if detected:
                            break
            fps = detected or 24.0

        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        uid = f"{int(time.time() * 1000)}_{random.randint(0, 99999):05d}"

        results = {}
        for key, images in (("video_a", video_a), ("video_b", video_b)):
            filename = f"vcs_{uid}_{key}.mp4"
            encode_video(images, fps, os.path.join(temp_dir, filename))
            results[key] = [{"filename": filename, "subfolder": "", "type": "temp"}]

        results["fps"] = [fps]
        return {"ui": results}


NODE_CLASS_MAPPINGS = {
    "VideoCompareSlider": VideoCompareSlider,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoCompareSlider": "ER Video Comparer",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
