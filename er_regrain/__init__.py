import json

import torch

from nodes import PreviewImage

try:
    import comfy.model_management as mm
except Exception:
    mm = None


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


def _perm(x):
    """Permutacion estilo Ashima (mod 289): exacta en float32, sin los
    artefactos de precision del clasico hash con sin()."""
    return torch.remainder((x * 34.0 + 1.0) * x, 289.0)


def _hash2(x, y, k):
    """Hash determinista 2D+seed. Must stay in sync with the WebGL."""
    xx = torch.remainder(x + k * 31.0, 289.0)
    yy = torch.remainder(y + k * 17.0, 289.0)
    return torch.frac(_perm(_perm(xx) + yy) / 41.0)


# presets de stock filmico: (tamano de grano, color, respuesta, ganancia)
FILM_PRESETS = {
    "35mm fine (50D)": (1.0, 0.15, 0.70, 0.6),
    "35mm (250D)": (1.5, 0.25, 0.65, 0.9),
    "35mm high speed (500T)": (2.2, 0.40, 0.60, 1.25),
    "super 16mm": (2.8, 0.35, 0.55, 1.5),
    "16mm": (3.4, 0.45, 0.50, 1.8),
    "8mm": (5.0, 0.55, 0.45, 2.4),
}


def resolve_film_preset(film_preset, amount, grain_size, color_amount, response):
    """Con preset: el stock define tamano/color/respuesta y multiplica la
    cantidad; con 'custom' mandan los sliders. Sync with the JS."""
    p = FILM_PRESETS.get(film_preset)
    if p is None:
        return amount, grain_size, color_amount, response
    size, color, resp, gain = p
    return amount * gain, size, color, resp


def _value_noise(H, W, size, k, dev):
    """Ruido de valor con celdas de `size` px, interpolado suave, en [-0.5, 0.5]."""
    ys = torch.arange(H, device=dev, dtype=torch.float32)
    xs = torch.arange(W, device=dev, dtype=torch.float32)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    cx = torch.floor(gx / size)
    cy = torch.floor(gy / size)
    fx = gx / size - cx
    fy = gy / size - cy
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    a = _hash2(cx, cy, k)
    b = _hash2(cx + 1.0, cy, k)
    c = _hash2(cx, cy + 1.0, k)
    d = _hash2(cx + 1.0, cy + 1.0, k)
    n = a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
    return n - 0.5


def apply_regrain(images, amount, grain_size, color_amount, response, seed, film_preset="custom"):
    """Grano filmico en GPU. Must stay in sync with the WebGL preview.
    El grano varia por frame (batch): en video queda animado, como el real.
    Devuelve (resultado, capa): la capa es el grano sobre gris medio (0.5),
    lista para componer en modo overlay o usar como input de otros modelos."""
    amount, grain_size, color_amount, response = resolve_film_preset(
        film_preset, amount, grain_size, color_amount, response)
    dev = _device()
    B, H, W, _ = images.shape
    out_frames = []
    layer_frames = []
    for i in range(B):
        img = images[i:i + 1, ..., :3].to(dev)
        k = float(seed % 97) + i * 7.0
        mono = _value_noise(H, W, grain_size, k * 3.0 + 0.0, dev)
        if color_amount > 0:
            nr = _value_noise(H, W, grain_size, k * 3.0 + 1.0, dev)
            nb = _value_noise(H, W, grain_size, k * 3.0 + 2.0, dev)
            noise = torch.stack((
                mono * (1 - color_amount) + nr * color_amount,
                mono,
                mono * (1 - color_amount) + nb * color_amount,
            ), dim=-1)
        else:
            noise = mono.unsqueeze(-1).expand(H, W, 3)
        noise = noise.unsqueeze(0)  # 1,H,W,3

        # respuesta por luminancia: el grano vive sobre todo en los medios
        luma = (img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722).unsqueeze(-1)
        w = 1.0 + response * (4.0 * luma * (1.0 - luma) - 1.0)

        out = torch.clamp(img + amount * 0.6 * w * noise, 0.0, 1.0)
        out_frames.append(out.cpu())
        layer_frames.append(torch.clamp(0.5 + amount * 0.6 * noise, 0.0, 1.0).cpu())
    result = torch.cat(out_frames, dim=0)
    layer = torch.cat(layer_frames, dim=0)
    _free_caches()
    return result, layer


DEFAULT_GRAIN = {
    "amount": 0.25, "grain_size": 1.6, "color_amount": 0.3,
    "response": 0.6, "seed": 0, "film_preset": "custom",
}


def parse_grain_params(s):
    """Parametros del nodo desde el widget JSON (con defaults)."""
    p = dict(DEFAULT_GRAIN)
    try:
        data = json.loads(s or "{}")
    except Exception:
        return p
    if isinstance(data, dict):
        for k in p:
            if k in data:
                if k == "film_preset":
                    p[k] = str(data[k])
                else:
                    try:
                        p[k] = float(data[k])
                    except Exception:
                        pass
    return p



def _layer_with_alpha(layer):
    """Version RGBA de la capa de grano: alpha = desviacion respecto al gris
    medio 0.5 (sin grano = transparente). Para mezcla normal en compositores.
    Los modelos de edicion NO quieren esta capa."""
    a = ((layer[..., :3] - 0.5).abs() * 2.0).amax(dim=-1, keepdim=True).clamp(0.0, 1.0)
    return torch.cat([layer[..., :3], a], dim=-1)

class ERRegrain(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                # parametros en JSON (los gestiona la UI de paneles del nodo)
                "params": ("STRING", {"default": "{}"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("images", "grain_layer", "grain_layer_alpha")
    OUTPUT_TOOLTIPS = ("The image with the grain applied.",
                       "Grain only over mid gray (RGB): Overlay / Linear Light in a compositor, or feed edit models directly (no alpha).",
                       "Grain only with alpha (RGBA, alpha = deviation from mid gray): for normal-blend compositing. Do NOT feed this one to edit models.")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "GPU film grain (regrain) with a real-time preview: amount, grain "
        "size, color amount and film-like luminance response. On frame "
        "batches (video) the grain is animated per frame, like real film."
    )

    def run(self, images, params="{}", prompt=None, extra_pnginfo=None):
        p = parse_grain_params(params)
        out, layer = apply_regrain(images, p["amount"], p["grain_size"], p["color_amount"],
                                   p["response"], int(p["seed"]), p["film_preset"])
        res = self.save_images(images[:1], "ER.grain.", prompt, extra_pnginfo)
        return {"ui": {"er_grain": res["ui"]["images"]}, "result": (out, layer, _layer_with_alpha(layer))}


NODE_CLASS_MAPPINGS = {
    "ERRegrain": ERRegrain,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERRegrain": "ER Regrain",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
