import json

import torch
import torch.nn.functional as F

from nodes import PreviewImage

try:
    import comfy.model_management as mm
except Exception:
    mm = None


MAX_LAYERS = 4

MODES = ["normal", "add", "screen", "multiply", "overlay",
         "soft light", "difference", "lighten", "darken"]

DEFAULT_LAYER = {"mode": "add", "opacity": 1.0}


def _device():
    try:
        if mm is not None:
            return mm.get_torch_device()
    except Exception:
        pass
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _free_caches():
    try:
        import gc
        gc.collect()
        if mm is not None:
            mm.soft_empty_cache()
    except Exception:
        pass


def parse_layers(s):
    """Lista de {mode, opacity} por capa desde el widget JSON de la UI."""
    out = []
    try:
        data = json.loads(s or "{}")
        items = data.get("layers", []) if isinstance(data, dict) else []
        for it in items[:MAX_LAYERS]:
            d = dict(DEFAULT_LAYER)
            if isinstance(it, dict):
                if it.get("mode") in MODES:
                    d["mode"] = it["mode"]
                try:
                    d["opacity"] = min(1.0, max(0.0, float(it.get("opacity", 1.0))))
                except Exception:
                    pass
            out.append(d)
    except Exception:
        pass
    while len(out) < MAX_LAYERS:
        out.append(dict(DEFAULT_LAYER))
    return out


def _fit(layer, H, W):
    """Reescala la capa al tamano de la base si difiere (bilineal)."""
    if layer.shape[1] == H and layer.shape[2] == W:
        return layer
    x = layer.movedim(-1, 1)
    x = F.interpolate(x, size=(H, W), mode="bilinear", align_corners=False)
    return x.movedim(1, -1)


def _blend_one(base, layer, mode, opacity):
    """Compone UNA capa sobre la base. Formulas estandar en sRGB (las mismas
    que usa el lienzo 2D del preview, para que lo que ves sea lo que sale).
    Si la capa trae alpha (RGBA), se usa como transparencia por pixel."""
    if layer.shape[-1] >= 4:
        rgb = layer[..., :3]
        a = layer[..., 3:4] * opacity
    else:
        rgb = layer[..., :3]
        a = torch.full_like(layer[..., :1], opacity)
    b = base
    l = rgb
    if mode == "add":
        return torch.clamp(b + l * a, 0.0, 1.0)
    if mode == "normal":
        return l * a + b * (1.0 - a)
    if mode == "screen":
        f = 1.0 - (1.0 - b) * (1.0 - l)
    elif mode == "multiply":
        f = b * l
    elif mode == "overlay":
        f = torch.where(b <= 0.5, 2.0 * b * l, 1.0 - 2.0 * (1.0 - b) * (1.0 - l))
    elif mode == "soft light":
        # formula W3C (la del lienzo 2D)
        d = torch.where(b <= 0.25, ((16.0 * b - 12.0) * b + 4.0) * b, torch.sqrt(b.clamp(min=0.0)))
        f = torch.where(l <= 0.5,
                        b - (1.0 - 2.0 * l) * b * (1.0 - b),
                        b + (2.0 * l - 1.0) * (d - b))
    elif mode == "difference":
        f = (b - l).abs()
    elif mode == "lighten":
        f = torch.maximum(b, l)
    elif mode == "darken":
        f = torch.minimum(b, l)
    else:
        f = l
    return torch.clamp(b + (f - b) * a, 0.0, 1.0)


def apply_combine(base, layers, params):
    """base: [B,H,W,3]; layers: lista de tensores IMAGE (3 o 4 canales) o
    None, en orden. Se componen 1..N sobre la base."""
    dev = _device()
    out_frames = []
    B, H, W = base.shape[0], base.shape[1], base.shape[2]
    for bi in range(B):
        acc = base[bi:bi + 1, ..., :3].to(dev).float()
        for li, layer in enumerate(layers):
            if layer is None:
                continue
            p = params[li]
            frame = layer[min(bi, layer.shape[0] - 1)]
            frame = _fit(frame.unsqueeze(0).to(dev).float(), H, W)
            acc = _blend_one(acc, frame, p["mode"], p["opacity"])
        out_frames.append(acc.cpu())
    result = torch.cat(out_frames, dim=0)
    _free_caches()
    return result


class ERCombine(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base": ("IMAGE", {"tooltip": "Bottom image: the layers stack on top of this."}),
            },
            "optional": {
                **{f"layer_{i}": ("IMAGE", {"tooltip": "Layer %d: composited over the result of the previous ones. RGBA layers use their own alpha." % i})
                   for i in range(1, MAX_LAYERS + 1)},
                # modos/opacidades por capa en JSON (los gestiona la UI)
                "params": ("STRING", {"default": "{}"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Layer compositing: stack up to 4 layers over a base image, each "
        "with its own blend mode (normal, add, screen, multiply, overlay, "
        "soft light, difference, lighten, darken) and opacity, with a live "
        "preview. A new layer input appears as you connect the previous "
        "one. RGBA layers (like the *_layer_alpha outputs of the ER suite) "
        "composite with their own per-pixel alpha; RGB light layers over "
        "black work best with add or screen."
    )

    def run(self, base, params="{}", prompt=None, extra_pnginfo=None, **kw):
        p = parse_layers(params)
        layers = [kw.get(f"layer_{i}") for i in range(1, MAX_LAYERS + 1)]
        out = apply_combine(base, layers, p)
        res = self.save_images(out[:1], "ER.combine.", prompt, extra_pnginfo)
        n = sum(1 for l in layers if l is not None)
        info = "{} layer{}".format(n, "s" if n != 1 else "")
        return {"ui": {"er_combine": res["ui"]["images"], "er_combine_info": [info]},
                "result": (out,)}


NODE_CLASS_MAPPINGS = {
    "ERCombine": ERCombine,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERCombine": "ER Combine",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
