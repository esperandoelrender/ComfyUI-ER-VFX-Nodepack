import json
import math

import torch
import torch.nn.functional as F

from nodes import PreviewImage

try:
    import comfy.model_management as mm
except Exception:
    mm = None


def _device():
    """GPU (CUDA) si esta disponible; si no, CPU."""
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


def _hsv_rgb(h_deg, s):
    """Color RGB desde tono (grados) y saturacion, valor 1."""
    h = ((h_deg % 360.0) + 360.0) % 360.0 / 60.0
    x = 1.0 - abs((h % 2.0) - 1.0)
    if h < 1:
        rgb = [1.0, x, 0.0]
    elif h < 2:
        rgb = [x, 1.0, 0.0]
    elif h < 3:
        rgb = [0.0, 1.0, x]
    elif h < 4:
        rgb = [0.0, x, 1.0]
    elif h < 5:
        rgb = [x, 0.0, 1.0]
    else:
        rgb = [1.0, 0.0, x]
    return [1.0 - s * (1.0 - c) for c in rgb]


# ------------------------------------------------------------------- constantes
# Compartidas con el shader del preview: cualquier cambio va en los dos sitios.
SIGMA_LOCAL = 2.0    # sigma objetivo dentro de cada nivel de la piramide
MAX_LEVEL = 8        # niveles maximos de downsample (÷256)
MAX_RADIUS = 16      # radio maximo del kernel 1D (= bucle del shader)
MIN_SIGMA = 0.35     # por debajo, el desenfoque es la identidad

LUMA_MODES = ["Rec709 luma", "Max RGB", "Average", "Per channel"]
BLEND_MODES = ["Add", "Screen", "Max"]
VIEW_MODES = ["Result", "Glow only", "Highlights"]

LUMA = (0.2126, 0.7152, 0.0722)


# ------------------------------------------------------------- extraccion de luces

def _highlights(img, threshold, knee, gain, luma_mode):
    """Luces altas con umbral de rodilla suave (soft knee).
    img: 1,3,H,W -> 1,3,H,W. Must stay in sync with the WebGL preview."""
    if luma_mode == 1:
        v = img.max(dim=1, keepdim=True).values
    elif luma_mode == 2:
        v = img.mean(dim=1, keepdim=True)
    elif luma_mode == 3:
        v = img  # por canal: cada canal tiene su propio umbral
    else:
        v = img[:, 0:1] * LUMA[0] + img[:, 1:2] * LUMA[1] + img[:, 2:3] * LUMA[2]
    kn = max(knee, 1e-4)
    soft = torch.clamp(v - threshold + kn, min=0.0, max=2.0 * kn)
    soft = soft * soft / (4.0 * kn)
    hard = v - threshold
    contrib = torch.clamp(torch.maximum(soft, hard) / torch.clamp(v, min=1e-4), min=0.0)
    return img * contrib * gain


# -------------------------------------------------------------- piramide de glow

def _gauss1d(sigma, dev):
    sigma = max(sigma, MIN_SIGMA)
    rad = min(int(math.ceil(3.0 * sigma)), MAX_RADIUS)
    x = torch.arange(-rad, rad + 1, device=dev, dtype=torch.float32)
    k = torch.exp(-(x * x) / (2.0 * sigma * sigma))
    return k / k.sum()


def _blur(x, sigma_x, sigma_y):
    """Gaussiana separable con bordes replicados (= CLAMP_TO_EDGE en el shader)."""
    dev = x.device
    kx = _gauss1d(sigma_x, dev).view(1, 1, 1, -1)
    ky = _gauss1d(sigma_y, dev).view(1, 1, -1, 1)
    rx = kx.shape[-1] // 2
    ry = ky.shape[-2] // 2
    x = F.conv2d(F.pad(x, (rx, rx, 0, 0), mode="replicate"), kx.expand(3, 1, 1, -1), groups=3)
    x = F.conv2d(F.pad(x, (0, 0, ry, ry), mode="replicate"), ky.expand(3, 1, -1, 1), groups=3)
    return x


def _level_for(sigma):
    """Nivel de la piramide para que el sigma local ronde SIGMA_LOCAL.
    Sync with levelFor() in the JS."""
    if sigma <= SIGMA_LOCAL:
        return 0
    return min(MAX_LEVEL, int(math.floor(math.log2(sigma / SIGMA_LOCAL) + 0.5)))


def _glow_field(hl, p, width):
    """Glow optico multi-octava: la octava mas grande mide `size` (% del ancho)
    y las demas van dividiendo por 2, con pesos en progresion `falloff`.
    Must stay in sync with the WebGL preview."""
    octaves = int(max(1, min(8, round(p["octaves"]))))
    sigma_max = max(0.3, p["size"] / 100.0 * width)
    a = math.sqrt(max(0.05, p["aspect"]))  # anamorfico, conserva el area
    H, W = hl.shape[-2:]

    chain = [hl]
    total = None
    wsum = 0.0
    for i in range(octaves):
        oct_up = octaves - 1 - i           # 0 = la octava mas grande
        sigma = sigma_max / (2.0 ** oct_up)
        lvl = _level_for(sigma)
        while len(chain) <= lvl:
            if min(chain[-1].shape[-2:]) < 4:
                break
            chain.append(F.avg_pool2d(chain[-1], 2))
        lvl = min(lvl, len(chain) - 1)
        d = float(2 ** lvl)
        b = _blur(chain[lvl], sigma / d * a, sigma / d / a)
        if lvl > 0:
            b = F.interpolate(b, size=(H, W), mode="bilinear", align_corners=False)

        w = float(p["falloff"]) ** oct_up
        # dispersion: las octavas anchas se tinen mas (cola cromatica)
        hue = p["tint_hue"] + p["dispersion"] * 55.0 * oct_up
        sat = min(1.0, p["tint_sat"] + p["dispersion"] * 0.45)
        col = torch.tensor(_hsv_rgb(hue, sat), device=hl.device).view(1, 3, 1, 1)

        contrib = b * (w * col)
        total = contrib if total is None else total + contrib
        wsum += w

    return total / max(wsum, 1e-6)


def _grade(g, p):
    """Gamma -> saturacion -> ganancia sobre el glow ya acumulado."""
    g = torch.clamp(g, min=0.0)
    gamma = float(p["gamma"])
    if abs(gamma - 1.0) > 1e-4:
        g = torch.pow(g, 1.0 / max(gamma, 0.05))
    lum = g[:, 0:1] * LUMA[0] + g[:, 1:2] * LUMA[1] + g[:, 2:3] * LUMA[2]
    g = lum + (g - lum) * float(p["saturation"])
    return torch.clamp(g, min=0.0) * float(p["gain"])


# ------------------------------------------------------------------------ nodo

def apply_glow(images, p):
    """Glow en GPU. Must stay in sync with the WebGL preview:
    luces altas -> piramide multi-octava -> grade -> mezcla.
    Devuelve (resultado, capa): la capa es SOLO el glow sobre negro, para
    usarla como pass en composicion o como input de otros modelos."""
    dev = _device()
    B, H, W, _ = images.shape
    view = int(p["view"])
    blend = int(p["blend"])
    mode = int(p["luma_mode"])
    mix = float(p["mix"])
    out_frames = []
    layer_frames = []

    for i in range(B):
        img = images[i:i + 1, ..., :3].to(dev).permute(0, 3, 1, 2)  # 1,3,H,W
        hl = _highlights(img, p["threshold"], p["knee"], p["highlight_gain"], mode)
        g = _grade(_glow_field(hl, p, W), p)
        layer_frames.append(torch.clamp(g * mix, 0.0, 1.0).permute(0, 2, 3, 1).cpu())

        if view == 2:  # ver solo lo que entra al glow (para ajustar el umbral)
            out_frames.append(torch.clamp(hl, 0.0, 1.0).permute(0, 2, 3, 1).cpu())
            continue
        if view == 1:  # solo el glow, sobre negro
            res = g * mix
        elif blend == 1:  # screen
            res = img + mix * ((1.0 - (1.0 - img) * (1.0 - torch.clamp(g, 0.0, 1.0))) - img)
        elif blend == 2:  # max
            res = img + mix * (torch.maximum(img, g) - img)
        else:             # add
            res = img + mix * g
        out_frames.append(torch.clamp(res, 0.0, 1.0).permute(0, 2, 3, 1).cpu())

    result = torch.cat(out_frames, dim=0)
    layer = torch.cat(layer_frames, dim=0)
    _free_caches()
    return result, layer


DEFAULT_GLOW = {
    # luces altas
    "threshold": 0.70, "knee": 0.25, "highlight_gain": 1.0, "luma_mode": 0,
    # forma
    "size": 1.5, "octaves": 5, "falloff": 0.6, "aspect": 1.0,
    # color
    "gain": 1.0, "gamma": 1.0, "saturation": 1.0,
    "tint_hue": 40.0, "tint_sat": 0.0, "dispersion": 0.0,
    # mezcla
    "blend": 0, "mix": 1.0, "view": 0,
}


def parse_glow_params(s):
    """Parametros del nodo desde el widget JSON (con defaults)."""
    p = dict(DEFAULT_GLOW)
    try:
        data = json.loads(s or "{}")
    except Exception:
        return p
    if isinstance(data, dict):
        for k in p:
            if k in data:
                try:
                    p[k] = float(data[k])
                except Exception:
                    pass
    return p



def _layer_with_alpha(layer):
    """Version RGBA de la capa de luz: alpha = luminosidad (max RGB), color
    premultiplicado tal cual. Para compositores que mezclan con normal en vez
    de Add/Screen. Los modelos de edicion (klein...) NO quieren esta capa:
    usar la RGB sobre negro."""
    a = layer[..., :3].amax(dim=-1, keepdim=True).clamp(0.0, 1.0)
    return torch.cat([layer[..., :3], a], dim=-1)

class ERGlow(PreviewImage):
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
    RETURN_NAMES = ("images", "glow_layer", "glow_layer_alpha")
    OUTPUT_TOOLTIPS = ("The image with the glow applied.",
                       "Glow only over pure black (RGB): additive light for Add/Screen in a compositor, and the CLEAN input for edit models (klein, nano banana) that dislike alpha.",
                       "Glow only with alpha (RGBA, alpha = brightness): for normal-blend compositing. Do NOT feed this one to edit models.")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Advanced GPU glow / bloom with a real-time preview: soft-knee highlight "
        "extraction (luma, max, average or per channel), multi-octave optical "
        "falloff, anamorphic stretch, glow gamma / saturation / tint with "
        "chromatic dispersion, Add / Screen / Max blending, mix and Result / "
        "Glow only / Highlights views. Works on images and frame batches (video)."
    )

    def run(self, images, params="{}", prompt=None, extra_pnginfo=None):
        p = parse_glow_params(params)
        out, layer = apply_glow(images, p)
        res = self.save_images(images[:1], "ER.glow.", prompt, extra_pnginfo)
        return {"ui": {"er_glow": res["ui"]["images"]}, "result": (out, layer, _layer_with_alpha(layer))}


NODE_CLASS_MAPPINGS = {
    "ERGlow": ERGlow,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERGlow": "ER Glow",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
