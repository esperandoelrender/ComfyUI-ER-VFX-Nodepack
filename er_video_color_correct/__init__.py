import json
import math
import os
import random
import time
from fractions import Fraction

import numpy as np
import torch
import torch.nn.functional as F
import av

import folder_paths


def _hue_matrix(deg):
    """Matriz de rotación de tono (la misma que usa CSS/SVG hue-rotate)."""
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return [
        [0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.787 * s],
        [0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s],
        [0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s],
    ]


def _kelvin_rgb(kelvin):
    """Color de cuerpo negro (aprox. Tanner-Helland), 0-1 por canal.
    Must stay in sync with kelvinRGB in the JS."""
    k = max(1000.0, min(40000.0, kelvin)) / 100.0
    if k <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(k) - 161.1195681661
    else:
        r = 329.698727446 * ((k - 60.0) ** -0.1332047592)
        g = 288.1221695283 * ((k - 60.0) ** -0.0755148492)
    if k >= 66:
        b = 255.0
    elif k <= 19:
        b = 0.0
    else:
        b = 138.5177312231 * math.log(k - 10.0) - 305.0447927307
    return [min(max(r, 0.0), 255.0) / 255.0, min(max(g, 0.0), 255.0) / 255.0, min(max(b, 0.0), 255.0) / 255.0]


def temperature_gains(kelvin):
    """Gains RGB para simular luz a esa temperatura, neutro en 6500K,
    con luminosidad compensada. Must stay in sync with the JS."""
    rgb = _kelvin_rgb(kelvin)
    ref = _kelvin_rgb(6500.0)
    g = [rgb[i] / max(ref[i], 1e-6) for i in range(3)]
    luma = g[0] * 0.2126 + g[1] * 0.7152 + g[2] * 0.0722
    return [v / max(luma, 1e-6) for v in g]


def _hsv_rgb(h_deg):
    h = ((h_deg % 360.0) + 360.0) % 360.0 / 60.0
    x = 1.0 - abs((h % 2.0) - 1.0)
    if h < 1:
        return [1.0, x, 0.0]
    if h < 2:
        return [x, 1.0, 0.0]
    if h < 3:
        return [0.0, 1.0, x]
    if h < 4:
        return [0.0, x, 1.0]
    if h < 5:
        return [x, 0.0, 1.0]
    return [1.0, 0.0, x]


def tint_gains(angle, radius):
    """Posición de un color wheel -> gains RGB (luma-neutral).
    Must stay in sync with tintToGains in the JS."""
    r, g, b = _hsv_rgb(angle)
    luma = r * 0.2126 + g * 0.7152 + b * 0.0722
    k = radius * 0.8
    return [1.0 + k * (r - luma), 1.0 + k * (g - luma), 1.0 + k * (b - luma)]


def _parse_wheels(wheels):
    try:
        data = json.loads(wheels) if isinstance(wheels, str) else wheels
        assert len(data) == 3
        return [[float(w[0]), float(w[1])] for w in data]
    except Exception:
        return [[0.0, 0.0], [0.0, 0.0], [0.0, 0.0]]


def apply_color_correct(images, temperature, hue, saturation, contrast, gamma, gain, offset, wheels="[[0,0],[0,0],[0,0]]"):
    """Color correct. Must stay in sync with the GLSL shader in the JS.
    Orden: hue -> temperature -> saturation -> contrast -> gamma ->
    wheels (shadows/midtones/highlights) x gain -> offset."""
    img = images[..., :3].clone()

    if abs(hue) > 1e-6:
        mat = torch.tensor(_hue_matrix(hue), dtype=img.dtype, device=img.device)
        img = img @ mat.T

    if abs(temperature - 6500.0) > 1e-3:
        tg = torch.tensor(temperature_gains(temperature), dtype=img.dtype, device=img.device)
        img = img * tg

    luma = (
        img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722
    ).unsqueeze(-1)
    img = luma + (img - luma) * saturation

    img = (img - 0.18) * contrast + 0.18

    img = img.clamp(min=0.0) ** (1.0 / max(gamma, 1e-6))

    ws_t, wm_t, wh_t = [
        torch.tensor(tint_gains(a, r), dtype=img.dtype, device=img.device)
        for a, r in _parse_wheels(wheels)
    ]
    l = (
        img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722
    ).clamp(0.0, 1.0).unsqueeze(-1)
    w_shadow = (1.0 - l) ** 2
    w_high = l**2
    w_mid = 1.0 - w_shadow - w_high
    factor = 1.0 + w_shadow * (ws_t - 1.0) + w_mid * (wm_t - 1.0) + w_high * (wh_t - 1.0)
    img = img * factor * gain + offset

    img = img.clamp(0.0, 1.0)

    if images.shape[-1] > 3:
        img = torch.cat([img, images[..., 3:]], dim=-1)
    return img


def downscale_for_preview(images, max_side=512):
    """Reescala el batch para el proxy de preview (lado mayor <= max_side, dims pares)."""
    h, w = images.shape[1], images.shape[2]
    s = max_side / max(h, w)
    if s >= 1.0:
        nh, nw = h - (h % 2), w - (w % 2)
        if (nh, nw) == (h, w):
            return images
    else:
        nh = max(2, int(h * s)) // 2 * 2
        nw = max(2, int(w * s)) // 2 * 2
    x = images[..., :3].permute(0, 3, 1, 2)
    x = F.interpolate(x, size=(nh, nw), mode="bilinear", align_corners=False)
    return x.permute(0, 2, 3, 1)


def encode_video(images, fps, path, crf=19):
    """Encode a ComfyUI IMAGE batch (B,H,W,C float 0-1) to an H.264 MP4."""
    frames = np.clip(images.cpu().numpy() * 255.0, 0, 255).astype(np.uint8)
    h, w = frames.shape[1], frames.shape[2]
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


class ERVideoColorCorrect:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "fps": ("FLOAT", {"default": 16.0, "min": 1.0, "max": 120.0, "step": 0.5, "tooltip": "Framerate of the preview playback"}),
                "temperature": ("FLOAT", {"default": 6500.0, "min": 1500.0, "max": 15000.0, "step": 50.0, "tooltip": "Color temperature in Kelvin. 6500 = neutral, lower = warmer, higher = cooler"}),
                "hue": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 0.5}),
                "saturation": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
                "contrast": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
                "gamma": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 5.0, "step": 0.01}),
                "gain": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
                "offset": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.005}),
                # controlado por los color wheels del nodo (widget oculto)
                "wheels": ("STRING", {"default": "[[0,0],[0,0],[0,0]]"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "correct"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Video color correct with a real-time GPU preview: the video plays "
        "inside the node with the correction applied live (WebGL) while you "
        "tweak temperature (Kelvin), hue, saturation, contrast, gamma, gain, "
        "offset and shadows/midtones/highlights color wheels. Run for full quality."
    )

    def correct(self, images, fps, temperature, hue, saturation, contrast, gamma, gain, offset, wheels, prompt=None, extra_pnginfo=None):
        corrected = apply_color_correct(
            images, temperature, hue, saturation, contrast, gamma, gain, offset, wheels
        )

        # proxy MP4 del video ORIGINAL (reescalado): el shader WebGL aplica
        # la correccion en vivo encima con la misma matematica
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        filename = f"er_vcc_{int(time.time() * 1000)}_{random.randint(0, 99999):05d}.mp4"
        encode_video(downscale_for_preview(images), fps, os.path.join(temp_dir, filename))

        return {
            "ui": {
                "er_vcc": [{"filename": filename, "subfolder": "", "type": "temp"}],
                "fps": [fps],
            },
            "result": (corrected,),
        }


NODE_CLASS_MAPPINGS = {
    "ERVideoColorCorrect": ERVideoColorCorrect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERVideoColorCorrect": "ER Video Color Correct",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
