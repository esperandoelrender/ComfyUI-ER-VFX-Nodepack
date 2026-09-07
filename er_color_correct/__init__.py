import json
import math

import torch
from nodes import PreviewImage


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


# secundarias por bandas de tono (six-vector): centros de banda en grados
SEC_CENTERS = [0.0, 60.0, 120.0, 180.0, 240.0, 300.0]  # R Yl G Cy B Mg


def parse_cc_sec(s):
    """Ajustes secundarios desde el JSON de params: {banda: (hue_shift,
    sat_mul, lum_mul)} solo con las bandas realmente tocadas."""
    try:
        data = json.loads(s or "{}")
        sec = data.get("sec") if isinstance(data, dict) else None
    except Exception:
        return {}
    out = {}
    if isinstance(sec, dict):
        for k, v in sec.items():
            try:
                i = int(k)
                if 0 <= i < 6 and isinstance(v, list) and len(v) >= 3:
                    hs, sm, lm = float(v[0]), float(v[1]), float(v[2])
                    if abs(hs) > 1e-4 or abs(sm - 1.0) > 1e-4 or abs(lm - 1.0) > 1e-4:
                        out[i] = (hs, sm, lm)
            except Exception:
                pass
    return out


def _apply_secondaries(img, sec):
    """Correccion secundaria por bandas de tono sobre RGB 0-1.
    Must stay in sync with the JS preview: mascara suave de +-60 grados
    alrededor del centro de banda, ponderada por confianza de color
    (saturacion y valor) para no tocar grises ni casi-negros."""
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    eps = 1e-6
    maxc = torch.maximum(torch.maximum(r, g), b)
    minc = torch.minimum(torch.minimum(r, g), b)
    delta = maxc - minc
    mask = delta > eps
    h = torch.zeros_like(maxc)
    h = torch.where((maxc == r) & mask, ((g - b) / (delta + eps)) % 6.0, h)
    h = torch.where((maxc == g) & mask, (b - r) / (delta + eps) + 2.0, h)
    h = torch.where((maxc == b) & mask, (r - g) / (delta + eps) + 4.0, h)
    h = (h * 60.0) % 360.0
    s = torch.where(maxc > eps, delta / (maxc + eps), torch.zeros_like(maxc))
    v = maxc

    sq = torch.clamp((s - 0.05) / 0.20, 0.0, 1.0)
    sq = sq * sq * (3.0 - 2.0 * sq)
    conf = sq * torch.clamp(v / 0.06, 0.0, 1.0)

    hshift = torch.zeros_like(h)
    smul = torch.ones_like(h)
    vmul = torch.ones_like(h)
    for i, (hs, sm, lm) in sec.items():
        c = SEC_CENTERS[i]
        d = torch.abs((h - c + 180.0) % 360.0 - 180.0)
        t = torch.clamp(1.0 - d / 60.0, 0.0, 1.0)
        w = t * t * (3.0 - 2.0 * t) * conf
        hshift = hshift + w * hs
        smul = smul * (1.0 + w * (sm - 1.0))
        vmul = vmul * (1.0 + w * (lm - 1.0))

    h2 = (h + hshift) % 360.0
    s2 = torch.clamp(s * smul, 0.0, 1.0)
    v2 = torch.clamp(v * vmul, 0.0, 1.0)

    hh = h2 / 60.0
    i6 = torch.floor(hh)
    f = hh - i6
    i6 = (i6.long() % 6)
    p_ = v2 * (1.0 - s2)
    q_ = v2 * (1.0 - s2 * f)
    t_ = v2 * (1.0 - s2 * (1.0 - f))
    r2 = torch.where(i6 == 0, v2, torch.where(i6 == 1, q_, torch.where(i6 == 2, p_, torch.where(i6 == 3, p_, torch.where(i6 == 4, t_, v2)))))
    g2 = torch.where(i6 == 0, t_, torch.where(i6 == 1, v2, torch.where(i6 == 2, v2, torch.where(i6 == 3, q_, torch.where(i6 == 4, p_, p_)))))
    b2 = torch.where(i6 == 0, p_, torch.where(i6 == 1, p_, torch.where(i6 == 2, t_, torch.where(i6 == 3, v2, torch.where(i6 == 4, v2, q_)))))
    return torch.stack((r2, g2, b2), dim=-1)


def apply_color_correct(images, temperature, hue, saturation, contrast, gamma, gain, offset, wheels="[[0,0],[0,0],[0,0]]", sec=None):
    """Color correct. Must stay in sync with the JS preview math.
    Orden: hue -> temperature -> saturation -> contrast -> gamma ->
    wheels (shadows/midtones/highlights) x gain -> offset ->
    secundarias por banda de tono (aislar rojos, azules...)."""
    img = images[..., :3].clone()

    # hue rotate
    if abs(hue) > 1e-6:
        mat = torch.tensor(_hue_matrix(hue), dtype=img.dtype, device=img.device)
        img = img @ mat.T

    # temperatura de color en Kelvin (6500 = neutro)
    if abs(temperature - 6500.0) > 1e-3:
        tg = torch.tensor(temperature_gains(temperature), dtype=img.dtype, device=img.device)
        img = img * tg

    # saturation (Rec.709 luma)
    luma = (
        img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722
    ).unsqueeze(-1)
    img = luma + (img - luma) * saturation

    # contrast (pivote 0.18)
    img = (img - 0.18) * contrast + 0.18

    # gamma
    img = img.clamp(min=0.0) ** (1.0 / max(gamma, 1e-6))

    # color wheels por rango tonal + gain master + offset
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

    # secundarias: trabaja SOLO sobre la banda de color elegida
    if sec:
        img = _apply_secondaries(img, sec)

    if images.shape[-1] > 3:
        img = torch.cat([img, images[..., 3:]], dim=-1)
    return img


DEFAULT_CC = {
    "temperature": 6500.0, "hue": 0.0, "saturation": 1.0, "contrast": 1.0,
    "gamma": 1.0, "gain": 1.0, "offset": 0.0,
}


def parse_cc_params(s):
    """Parametros del nodo desde el widget JSON (con defaults)."""
    p = dict(DEFAULT_CC)
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


class ERColorCorrect(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                # parametros en JSON (los gestiona la UI de paneles del nodo)
                "params": ("STRING", {"default": "{}"}),
                # controlado por los color wheels del nodo (widget oculto):
                # [[angulo,radio] sombras, [angulo,radio] medios, [angulo,radio] altas]
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
        "Color correct with a real-time preview: temperature (Kelvin), hue, "
        "saturation, contrast, gamma, gain, offset, shadows/midtones/"
        "highlights color wheels, hue-band secondaries (isolate and grade "
        "just the reds, blues... with a mask preview) and a vectorscope "
        "with the skin tone line. Tweak live, then run for full quality."
    )

    def correct(self, images, params="{}", wheels="[[0,0],[0,0],[0,0]]", prompt=None, extra_pnginfo=None):
        p = parse_cc_params(params)
        corrected = apply_color_correct(
            images, p["temperature"], p["hue"], p["saturation"], p["contrast"],
            p["gamma"], p["gain"], p["offset"], wheels, parse_cc_sec(params)
        )
        # el preview que viaja a la UI es el ORIGINAL: el JS aplica la
        # corrección en vivo encima con la misma matemática
        res = self.save_images(images, "ER.cc.", prompt, extra_pnginfo)
        return {
            "ui": {"er_cc": res["ui"]["images"]},
            "result": (corrected,),
        }


NODE_CLASS_MAPPINGS = {
    "ERColorCorrect": ERColorCorrect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERColorCorrect": "ER Color Correct",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
