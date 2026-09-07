import math

import torch
import torch.nn.functional as F

import comfy.utils

# presupuesto de pixeles y multiplo de redondeo por modelo
# (compartido conceptualmente con el JS: cambiar alli tambien)
MODELS = {
    "SD 1.5": {"pixels": 512 * 512, "multiple": 64},
    "SDXL / Pony / Illustrious": {"pixels": 1024 * 1024, "multiple": 64},
    "SD 3 / 3.5": {"pixels": 1024 * 1024, "multiple": 64},
    "FLUX.1 (1MP)": {"pixels": 1024 * 1024, "multiple": 16},
    "FLUX.1 (2MP)": {"pixels": 2 * 1024 * 1024, "multiple": 16},
    "FLUX.2 / Klein (2MP)": {"pixels": 2 * 1024 * 1024, "multiple": 16},
    "FLUX.2 (4MP)": {"pixels": 4 * 1024 * 1024, "multiple": 16},
    "Qwen-Image": {"pixels": 1328 * 1328, "multiple": 16},
    "HiDream-I1": {"pixels": 1024 * 1024, "multiple": 64},
}

RATIOS = {
    "auto (match input)": None,
    "1:1": 1.0,
    "4:3": 4 / 3,
    "3:4": 3 / 4,
    "3:2": 3 / 2,
    "2:3": 2 / 3,
    "16:9": 16 / 9,
    "9:16": 9 / 16,
    "21:9": 21 / 9,
    "9:21": 9 / 21,
}


def compute_resolution(model, ratio):
    """Resolucion optima para el modelo con esa relacion de aspecto."""
    cfg = MODELS[model]
    mult = cfg["multiple"]
    w = math.sqrt(cfg["pixels"] * ratio)
    h = w / ratio
    w = max(mult, round(w / mult) * mult)
    h = max(mult, round(h / mult) * mult)
    return int(w), int(h)


def closest_ratio(aspect):
    """La relacion de la lista mas parecida a la de la imagen de entrada."""
    best, best_d = "1:1", 1e9
    for name, r in RATIOS.items():
        if r is None:
            continue
        d = abs(math.log(aspect / r))
        if d < best_d:
            best, best_d = name, d
    return best


class ERAutoResolution:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "model": (list(MODELS.keys()), {"default": "SDXL / Pony / Illustrious"}),
                "aspect_ratio": (list(RATIOS.keys()), {"default": "auto (match input)"}),
                "mode": (["crop", "pad", "stretch"], {"default": "crop", "tooltip": "crop: fills and center-crops | pad: fits with black bars | stretch: distorts to fit"}),
            },
            "hidden": {},
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")
    FUNCTION = "resize"
    OUTPUT_NODE = True
    CATEGORY = "image/transform"
    DESCRIPTION = (
        "Resizes an image to the optimal resolution for the chosen model "
        "(SD 1.5, SDXL, FLUX, Qwen...) and aspect ratio, with no manual math. "
        "Outputs the image plus width/height for empty latents."
    )

    def resize(self, image, model, aspect_ratio, mode):
        B, H, W, C = image.shape
        ratio = RATIOS[aspect_ratio]
        if ratio is None:
            ratio = RATIOS[closest_ratio(W / H)]
        tw, th = compute_resolution(model, ratio)

        x = image[..., :3].movedim(-1, 1)  # BCHW
        if mode == "stretch":
            out = comfy.utils.common_upscale(x, tw, th, "lanczos", "disabled")
        elif mode == "crop":
            out = comfy.utils.common_upscale(x, tw, th, "lanczos", "center")
        else:  # pad: encaja dentro manteniendo aspecto y rellena con negro
            scale = min(tw / W, th / H)
            iw = max(1, round(W * scale))
            ih = max(1, round(H * scale))
            inner = comfy.utils.common_upscale(x, iw, ih, "lanczos", "disabled")
            pl = (tw - iw) // 2
            pt = (th - ih) // 2
            out = F.pad(inner, (pl, tw - iw - pl, pt, th - ih - pt), value=0.0)

        out = out.movedim(1, -1).clamp(0.0, 1.0)
        return {
            "ui": {"er_res": [[tw, th]]},
            "result": (out, tw, th),
        }


NODE_CLASS_MAPPINGS = {
    "ERAutoResolution": ERAutoResolution,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERAutoResolution": "ER Auto Resolution",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
