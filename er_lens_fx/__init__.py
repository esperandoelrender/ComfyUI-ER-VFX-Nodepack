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


def _smoothstep(a, b, x):
    t = torch.clamp((x - a) / max(b - a, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


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


# ---------------------------------------------------------------- lens effects

HALATION_TINT = (1.0, 0.30, 0.18)  # sangrado rojizo, sync with the JS


def _gauss_kernel(sigma_px, dev):
    sigma = max(1.0, sigma_px)
    rad = min(int(3 * sigma), 127)
    xs_k = torch.arange(-rad, rad + 1, device=dev, dtype=torch.float32)
    k1 = torch.exp(-(xs_k * xs_k) / (2 * sigma * sigma))
    return (k1 / k1.sum()).view(1, 1, 1, -1)


def _blur_sep(x, kernel):
    rad = kernel.shape[-1] // 2
    x = F.conv2d(F.pad(x, (rad, rad, 0, 0), mode="replicate"),
                 kernel.expand(3, 1, 1, -1), groups=3)
    x = F.conv2d(F.pad(x, (0, 0, rad, rad), mode="replicate"),
                 kernel.transpose(2, 3).expand(3, 1, -1, 1), groups=3)
    return x


def apply_lens_effects(images, p):
    """Efectos de lente en GPU. Must stay in sync with the WebGL preview.
    Orden: distorsion+CA -> sharpen -> corner softness -> glow + halation
    -> diffusion -> vineta.
    Distorsion: modelo radial Brown-Conrady (k1 + k2) con radio circular
    corregido por aspecto y esquinas normalizadas (sin bordes en barrel)."""
    dev = _device()
    B, H, W, _ = images.shape
    aspect = W / H
    out_frames = []

    distortion = float(p["distortion"])
    distortion_fine = float(p["distortion_fine"])
    ca = float(p["chromatic_aberration"])
    sharpen = float(p["sharpen"])
    corner = float(p["corner_softness"])
    glow = float(p["glow"])
    glow_thr = float(p["glow_threshold"])
    glow_size = float(p["glow_size"])
    halation = float(p["halation"])
    diffusion = float(p["diffusion"])

    # rejilla base de distorsion (compartida por todo el batch)
    ys = torch.linspace(-1.0, 1.0, H, device=dev)
    xs = torch.linspace(-1.0, 1.0, W, device=dev)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    # radio fotografico: circular en el plano de imagen, 1.0 en la esquina
    r2 = (gx * gx * aspect * aspect + gy * gy) / (aspect * aspect + 1.0)
    norm = max(1e-3, 1.0 + distortion + distortion_fine)
    m = (1.0 + distortion * r2 + distortion_fine * r2 * r2) / norm
    base_sx = {s: gx * m * s for s in (1.0 + ca, 1.0, 1.0 - ca)}
    base_sy = {s: gy * m * s for s in (1.0 + ca, 1.0, 1.0 - ca)}
    scales = (1.0 + ca, 1.0, 1.0 - ca)

    # vineta con centro desplazable
    cvx = float(p["vignette_x"]) * 2.0 - 1.0
    cvy = float(p["vignette_y"]) * 2.0 - 1.0
    rv = torch.sqrt((gx - cvx) ** 2 + (gy - cvy) ** 2)
    vig = 1.0 - float(p["vignette"]) * _smoothstep(1.0 - float(p["vignette_softness"]) * 1.2, 1.55, rv)
    vig = vig.unsqueeze(0).unsqueeze(0)  # 1,1,H,W

    # mascara radial de la suavidad de esquinas (radio fotografico)
    r_photo = torch.sqrt(r2)
    corner_mask = (corner * _smoothstep(0.35, 1.0, r_photo)).clamp(0.0, 1.0)
    corner_mask = corner_mask.unsqueeze(0).unsqueeze(0)

    # kernels: blur suave (corner+diffusion) y blur del glow/halation
    k_soft = _gauss_kernel(0.015 * W, dev) if (corner > 0 or diffusion > 0) else None
    k_glow = _gauss_kernel(glow_size / 100.0 * W, dev) if (glow > 0 or halation > 0) else None
    hal_tint = torch.tensor(HALATION_TINT, device=dev).view(1, 3, 1, 1)

    # rejillas de sampleo por canal (fijas para todo el batch)
    grids = {
        s: torch.stack((
            torch.clamp(base_sx[s], -1.0, 1.0),
            torch.clamp(base_sy[s], -1.0, 1.0),
        ), dim=-1).unsqueeze(0)
        for s in scales
    }

    for i in range(B):
        img = images[i:i + 1, ..., :3].to(dev).permute(0, 3, 1, 2)  # 1,3,H,W

        chans = []
        for ci, s in enumerate(scales):
            chans.append(F.grid_sample(img[:, ci:ci + 1], grids[s], mode="bilinear",
                                       padding_mode="border", align_corners=True))
        base = torch.cat(chans, dim=1)
        x = base

        # sharpen (unsharp con media 3x3 sobre la imagen distorsionada)
        if sharpen > 0:
            mean3 = F.avg_pool2d(F.pad(base, (1, 1, 1, 1), mode="replicate"), 3, stride=1)
            x = base + sharpen * (base - mean3)

        # suavidad de esquinas: mezcla radial hacia la version desenfocada
        blur_soft = _blur_sep(base, k_soft) if k_soft is not None else None
        if corner > 0 and blur_soft is not None:
            x = x * (1.0 - corner_mask) + blur_soft * corner_mask

        # glow + halation (mismo blur, la halation tenida de rojo)
        if k_glow is not None:
            g = _blur_sep(torch.clamp(base - glow_thr, min=0.0), k_glow)
            if glow > 0:
                x = x + glow * g
            if halation > 0:
                x = x + halation * 1.5 * g * hal_tint

        # diffusion (Pro-Mist): levanta y florece con la imagen desenfocada
        if diffusion > 0 and blur_soft is not None:
            x = 1.0 - (1.0 - x) * (1.0 - diffusion * 0.65 * torch.clamp(blur_soft, 0.0, 1.0))

        x = torch.clamp(x * vig, 0.0, 1.0)
        out_frames.append(x.permute(0, 2, 3, 1).cpu())

    result = torch.cat(out_frames, dim=0)
    _free_caches()
    return result


# ------------------------------------------------------------------ lens flare

# fantasmas: (posicion a lo largo del eje, tamano, giro de tono, peso)
GHOSTS = [
    (-0.55, 0.11, 160.0, 0.25),
    (0.32, 0.06, 30.0, 0.35),
    (0.55, 0.12, 60.0, 0.25),
    (0.85, 0.05, 210.0, 0.30),
    (1.20, 0.16, 100.0, 0.22),
    (1.55, 0.09, 320.0, 0.28),
]

MAX_FLARES = 4
DEFAULT_FLARE = {
    "x": 0.7, "y": 0.3, "intensity": 1.0, "core": 1.0, "core_radius": 1.0,
    "scale": 1.0, "hue": 35.0,
    "sat": 0.35, "ghosts": 0.5, "streak": 0.4, "streak_hue": 245.0,
    "streak_width": 1.0, "rays": 0.3, "ray_count": 7.0,
    # grados: gira el patron de puntas del starburst alrededor de la luz
    "ray_rotation": 0.0,
    # grados: SOLO el angulo del reguero de ghosts (girado alrededor de la
    # luz; 0 = eje natural luz->centro). El streak siempre va recto.
    "rotation": 0.0,
    "on": True,
}


def parse_flares(s):
    """Lista de flares desde el widget JSON; ignora entradas invalidas."""
    try:
        data = json.loads(s or "[]")
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    out = []
    for item in data[:MAX_FLARES]:
        if not isinstance(item, dict):
            continue
        f = dict(DEFAULT_FLARE)
        for key in f:
            if key in item:
                f[key] = item[key]
        out.append(f)
    return out


def flare_field(H, W, f, dev):
    """Campo aditivo de UN flare (3,H,W). Must stay in sync with the WebGL."""
    aspect = W / H
    ys = torch.linspace(0.0, 1.0, H, device=dev)
    xs = torch.linspace(0.0, 1.0, W, device=dev)
    gy, gx = torch.meshgrid(ys, xs, indexing="ij")
    px = (gx - 0.5) * aspect
    py = gy - 0.5
    lx = (float(f["x"]) - 0.5) * aspect
    ly = float(f["y"]) - 0.5
    scale = float(f["scale"])
    hue = float(f["hue"])
    sat = float(f["sat"])
    ghosts = float(f["ghosts"])
    streak = float(f["streak"])
    rays = float(f["rays"])
    rot = math.radians(float(f.get("rotation", 0.0)))
    cosr, sinr = math.cos(rot), math.sin(rot)

    dx = px - lx
    dy = py - ly
    rl = torch.sqrt(dx * dx + dy * dy)

    tint = torch.tensor(_hsv_rgb(hue, sat), device=dev).view(3, 1, 1)

    # nucleo + halo suave alrededor de la luz, con ganancia ("core") y
    # radio propio ("core_radius") independientes del resto del flare
    cr = scale * max(0.05, float(f.get("core_radius", 1.0)))
    core = (1.2 * torch.exp(-(rl / (0.05 * cr)) ** 2) + 0.45 * torch.exp(-(rl / (0.16 * cr)) ** 2)) * float(f.get("core", 1.0))
    acc = core.unsqueeze(0) * tint

    # rayos (starburst): ray_count puntas, patron girable con ray_rotation
    if rays > 0:
        ang = torch.atan2(dy, dx) - math.radians(float(f.get("ray_rotation", 0.0)))
        k = max(1.0, float(f["ray_count"])) * 0.5
        star = torch.abs(torch.cos(ang * k)) ** 24 * torch.exp(-(rl / (0.45 * scale)) ** 1.5)
        acc = acc + rays * 0.6 * star.unsqueeze(0) * tint

    # racha anamorfica horizontal (siempre recta), con su color y grosor
    if streak > 0:
        sw = 0.015 * max(0.05, float(f["streak_width"])) * scale
        st = torch.exp(-(dy / sw) ** 2) * torch.exp(-torch.abs(dx) / (0.55 * scale))
        scol = torch.tensor(_hsv_rgb(float(f["streak_hue"]), min(1.0, sat + 0.2)), device=dev).view(3, 1, 1)
        acc = acc + streak * st.unsqueeze(0) * scol

    # fantasmas: el reguero sale de la luz por el eje natural luz->centro,
    # girado "rotation" grados alrededor de la luz (angulo del ghost)
    if ghosts > 0:
        for t, size, hshift, wgt in GHOSTS:
            bx = -lx * (t + 1.0)
            by = -ly * (t + 1.0)
            cx_g = lx + bx * cosr - by * sinr
            cy_g = ly + bx * sinr + by * cosr
            d = torch.sqrt((px - cx_g) ** 2 + (py - cy_g) ** 2)
            gcol = torch.tensor(_hsv_rgb(hue + hshift, min(1.0, sat + 0.35)), device=dev).view(3, 1, 1)
            acc = acc + ghosts * wgt * torch.exp(-(d / (size * scale)) ** 2).unsqueeze(0) * gcol
        rc = torch.sqrt(px * px + py * py)
        ring = torch.exp(-(((rc - 0.42 * scale)) / 0.10) ** 2)
        acc = acc + ghosts * 0.30 * ring.unsqueeze(0) * tint

    return acc * float(f["intensity"])  # 3,H,W


def apply_lens_flare(images, flares_json):
    """Devuelve (resultado, capa): la capa es SOLO el flare sobre negro,
    para usarla como pass en composicion o como input de otros modelos."""
    dev = _device()
    B, H, W, _ = images.shape
    flares = [f for f in parse_flares(flares_json) if f.get("on", True)]
    if not flares:
        empty = torch.zeros(B, H, W, 3)
        return images[..., :3].clone(), empty

    total = None
    for f in flares:
        field = flare_field(H, W, f, dev)
        total = field if total is None else total + field
    flare = torch.clamp(total, 0.0, 1.0).permute(1, 2, 0).unsqueeze(0)  # 1,H,W,3

    # capa RGB pura sobre negro: predecible en cualquier pipeline (mezcla
    # screen/add o como referencia para modelos generativos)
    flare_cpu = flare.cpu()

    out_frames = []
    layer_frames = []
    for i in range(B):
        layer_frames.append(flare_cpu)
        img = images[i:i + 1, ..., :3].to(dev)
        # mezcla screen: respeta las altas luces
        out = 1.0 - (1.0 - img) * (1.0 - flare)
        out_frames.append(torch.clamp(out, 0.0, 1.0).cpu())
    result = torch.cat(out_frames, dim=0)
    layer = torch.cat(layer_frames, dim=0)
    _free_caches()
    return result, layer


# ----------------------------------------------------------------- camera dirt

def _perm(x):
    """Permutacion estilo Ashima (mod 289): exacta en float32, sin los
    artefactos de precision del clasico hash con sin().
    Same hash family as er_regrain; must stay in sync with the WebGL."""
    return torch.remainder((x * 34.0 + 1.0) * x, 289.0)


def _hash2(x, y, k):
    """Hash determinista 2D+seed. Must stay in sync with the WebGL."""
    xx = torch.remainder(x + k * 31.0, 289.0)
    yy = torch.remainder(y + k * 17.0, 289.0)
    return torch.frac(_perm(_perm(xx) + yy) / 41.0)


def _vnoise01(qx, qy, k):
    """Value noise bilineal en [0,1]. Must stay in sync with the WebGL."""
    cx = torch.floor(qx)
    cy = torch.floor(qy)
    fx = qx - cx
    fy = qy - cy
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    a = _hash2(cx, cy, k)
    b = _hash2(cx + 1.0, cy, k)
    c = _hash2(cx, cy + 1.0, k)
    d = _hash2(cx + 1.0, cy + 1.0, k)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy


DEFAULT_DIRT = {
    "amount": 1.0, "size": 1.0, "density": 0.5, "smudge": 0.5,
    "softness": 0.4, "seed": 7.0,
    "base": 0.15, "highlights": 1.0, "threshold": 0.7,
    "hue": 40.0, "sat": 0.08,
}


def _dirt_map(H, W, p, dev):
    """Mapa de suciedad procedural (H,W) en [0,1]: motas Worley + manchas
    fbm, deterministas por seed. Must stay in sync with the WebGL."""
    aspect = W / H
    size = max(0.2, float(p["size"]))
    density = float(p["density"])
    smudge = float(p["smudge"])
    softness = float(p["softness"])
    seed = float(int(p["seed"]))

    ys = (torch.arange(H, device=dev, dtype=torch.float32) + 0.5) / H
    xs = (torch.arange(W, device=dev, dtype=torch.float32) + 0.5) / W * aspect
    py, px = torch.meshgrid(ys, xs, indexing="ij")

    # motas: Worley con radio, existencia y opacidad aleatorios por celda
    qx = px * (18.0 / size)
    qy = py * (18.0 / size)
    cqx = torch.floor(qx)
    cqy = torch.floor(qy)
    fqx = qx - cqx
    fqy = qy - cqy
    edge = 0.85 - 0.75 * softness
    speck = torch.zeros_like(qx)
    for oy in (-1.0, 0.0, 1.0):
        for ox in (-1.0, 0.0, 1.0):
            cellx = cqx + ox
            celly = cqy + oy
            hx = _hash2(cellx, celly, seed)
            hy = _hash2(cellx, celly, seed + 57.0)
            hr = _hash2(cellx, celly, seed + 113.0)
            he = _hash2(cellx, celly, seed + 171.0)
            ho = _hash2(cellx, celly, seed + 229.0)
            dx = ox + hx - fqx
            dy = oy + hy - fqy
            d = torch.sqrt(dx * dx + dy * dy)
            r = 0.10 + 0.22 * hr
            s = _smoothstep_rev(r, r * edge, d)
            exist = (he < density).float()
            op = 0.45 + 0.55 * ho
            speck = torch.maximum(speck, s * exist * op)

    # manchas: fbm de 3 octavas, umbral suave
    q2x = px * (3.5 / size)
    q2y = py * (3.5 / size)
    n1 = _vnoise01(q2x, q2y, seed + 300.0)
    n2 = _vnoise01(q2x * 2.0 + 11.0, q2y * 2.0 + 7.0, seed + 300.0)
    n3 = _vnoise01(q2x * 4.0 + 23.0, q2y * 4.0 + 29.0, seed + 300.0)
    fbm = (0.5 * n1 + 0.25 * n2 + 0.125 * n3) / 0.875
    smm = _smoothstep(0.5, 0.9, fbm) * smudge

    return torch.clamp(speck + smm * 0.75, 0.0, 1.0)


def _smoothstep_rev(a, b, x):
    """smoothstep con borde descendente (b < a): 1 dentro, 0 fuera.
    Acepta bordes tensor (radio por celda)."""
    denom = torch.clamp(torch.as_tensor(b - a), max=-1e-6)
    t = torch.clamp((x - a) / denom, 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def apply_camera_dirt(images, p):
    """Suciedad de lente en GPU: el mapa es fijo y se revela con las luces
    de la imagen (base + highlights). Must stay in sync with the WebGL.
    Devuelve (resultado, capa de suciedad sobre negro)."""
    dev = _device()
    B, H, W, _ = images.shape
    amount = float(p["amount"])
    base_vis = float(p["base"])
    hi = float(p["highlights"])
    thr = float(p["threshold"])

    dirt = _dirt_map(H, W, p, dev).view(1, 1, H, W) * amount
    tint = torch.tensor(_hsv_rgb(float(p["hue"]), float(p["sat"])), device=dev).view(1, 3, 1, 1)
    k_blur = _gauss_kernel(0.04 * W, dev)

    out_frames = []
    layer_frames = []
    for i in range(B):
        img = images[i:i + 1, ..., :3].to(dev).permute(0, 3, 1, 2)  # 1,3,H,W
        # las altas luces (desenfocadas) revelan la suciedad
        hl = _blur_sep(torch.clamp(img - thr, min=0.0), k_blur)
        vis = base_vis + hi * 2.0 * hl
        add = dirt * tint * vis
        out_frames.append(torch.clamp(img + add, 0.0, 1.0).permute(0, 2, 3, 1).cpu())
        layer_frames.append(torch.clamp(add, 0.0, 1.0).permute(0, 2, 3, 1).cpu())
    result = torch.cat(out_frames, dim=0)
    layer = torch.cat(layer_frames, dim=0)
    _free_caches()
    return result, layer


# ---------------------------------------------------------------------- nodos

DEFAULT_LENS = {
    "distortion": 0.0, "distortion_fine": 0.0, "chromatic_aberration": 0.0,
    "vignette": 0.0, "vignette_softness": 0.5, "vignette_x": 0.5, "vignette_y": 0.5,
    "sharpen": 0.0, "glow": 0.0, "glow_threshold": 0.75, "glow_size": 3.0,
    "corner_softness": 0.0, "diffusion": 0.0, "halation": 0.0,
}


def parse_lens_params(s):
    """Parametros del nodo desde el widget JSON (con defaults)."""
    p = dict(DEFAULT_LENS)
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
    """Version RGBA de una capa de luz: alpha = luminosidad (max RGB), color
    premultiplicado tal cual. Para compositores que mezclan con normal en vez
    de Add/Screen. Los modelos de edicion (klein...) NO quieren esta capa:
    usar la RGB sobre negro."""
    a = layer[..., :3].amax(dim=-1, keepdim=True).clamp(0.0, 1.0)
    return torch.cat([layer[..., :3], a], dim=-1)

class ERLensEffects(PreviewImage):
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

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "GPU lens effects for images with a real-time preview: photographic "
        "Brown-Conrady distortion (k1+k2), chromatic aberration, movable "
        "vignette, sharpen, highlight glow, corner softness, diffusion and "
        "halation, plus lens-type presets that fill values as a starting "
        "point."
    )

    def run(self, images, params="{}", prompt=None, extra_pnginfo=None):
        p = parse_lens_params(params)
        out = apply_lens_effects(images, p)
        res = self.save_images(images[:1], "ER.lens.", prompt, extra_pnginfo)
        return {"ui": {"er_lens": res["ui"]["images"]}, "result": (out,)}


class ERLensFlare(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                # lista JSON de flares (la gestiona la UI del nodo)
                "flares": ("STRING", {"default": "[]"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "IMAGE")
    RETURN_NAMES = ("images", "flare_layer", "flare_layer_alpha")
    OUTPUT_TOOLTIPS = ("The image with the flares screened on top.",
                       "Flares only over pure black (RGB): additive light for Add/Screen in a compositor, and the CLEAN input for edit models (klein, nano banana) that dislike alpha.",
                       "Flares only with alpha (RGBA, alpha = brightness): for normal-blend compositing. Do NOT feed this one to edit models.")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Procedural GPU lens flares for images with a real-time preview: up "
        "to 4 independent flares (Flare 1, 2...), each with a draggable "
        "position marker plus a ghost-angle handle to aim where the ghost "
        "trail falls (the streak always stays straight), its own tint, "
        "core gain/radius, ghosts, anamorphic streak with custom color, rays "
        "with count and angle, and an on/off eye toggle. Screen-blended. "
        "flare_layer outputs just "
        "the flare over pure black, ready to use as a compositing pass or "
        "as an input for other models."
    )

    def run(self, images, flares="[]", prompt=None, extra_pnginfo=None):
        out, layer = apply_lens_flare(images, flares)
        res = self.save_images(images[:1], "ER.flare.", prompt, extra_pnginfo)
        return {"ui": {"er_lens": res["ui"]["images"]}, "result": (out, layer, _layer_with_alpha(layer))}


class ERLensCameraDirt(PreviewImage):
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
    RETURN_NAMES = ("images", "dirt_layer", "dirt_layer_alpha")
    OUTPUT_TOOLTIPS = ("The image with the camera dirt revealed by its highlights.",
                       "Dirt only over pure black (RGB): additive, for Add/Screen or as a CLEAN edit-model input (no alpha).",
                       "Dirt only with alpha (RGBA, alpha = brightness): for normal-blend compositing. Do NOT feed this one to edit models.")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Procedural GPU camera lens dirt for images with a real-time "
        "preview: dust specks and smudges that reveal under the image's "
        "bright lights, like a real dirty front element. Deterministic by "
        "seed, with size, density, softness, tint and highlight-reveal "
        "controls. dirt_layer outputs just the dirt over pure black, ready "
        "to use as a compositing pass."
    )

    def run(self, images, params="{}", prompt=None, extra_pnginfo=None):
        p = dict(DEFAULT_DIRT)
        try:
            data = json.loads(params or "{}")
            if isinstance(data, dict):
                for k in p:
                    if k in data:
                        try:
                            p[k] = float(data[k])
                        except Exception:
                            pass
        except Exception:
            pass
        out, layer = apply_camera_dirt(images, p)
        res = self.save_images(images[:1], "ER.dirt.", prompt, extra_pnginfo)
        return {"ui": {"er_lens": res["ui"]["images"]}, "result": (out, layer, _layer_with_alpha(layer))}


DEFAULT_DEFOCUS = {
    "radius": 2.0, "blades": 0.0, "blade_rotation": 0.0,
    "boost": 1.5, "threshold": 0.75, "fringe": 0.0,
}


def _aperture_kernel(rpx, blades, rot_deg, dev):
    """Kernel de diafragma: disco (blades=0) o poligono de N palas, con borde
    antialiasado. Es la forma en que una lente real reparte un punto de luz
    desenfocado — el bokeh ES este kernel."""
    r = max(1.0, float(rpx))
    n = int(round(blades))
    size = int(math.ceil(r)) * 2 + 3
    c = size // 2
    ys = torch.arange(size, device=dev, dtype=torch.float32) - c
    gy, gx = torch.meshgrid(ys, ys, indexing="ij")
    d = torch.sqrt(gx * gx + gy * gy)
    if n >= 3:
        # radio del poligono regular en funcion del angulo
        ang = torch.atan2(gy, gx) - math.radians(rot_deg)
        step = 2.0 * math.pi / n
        a = torch.remainder(ang, step) - step * 0.5
        rp = r * math.cos(math.pi / n) / torch.cos(a).clamp(min=1e-4)
    else:
        rp = torch.full_like(d, r)
    k = torch.clamp((rp - d) + 0.5, 0.0, 1.0)  # borde AA de ~1px
    s = k.sum()
    return k / s if float(s) > 0 else k, size


def _fft_blur(x, kernel, ksize):
    """Convolucion exacta imagen*kernel via FFT. x: [B,C,H,W]; el kernel se
    centra en el origen (roll) para que no desplace la imagen."""
    B, C, H, W = x.shape
    pad = ksize // 2
    xp = F.pad(x, (pad, pad, pad, pad), mode="reflect")
    Hp, Wp = xp.shape[-2], xp.shape[-1]
    kp = torch.zeros((Hp, Wp), device=x.device, dtype=torch.float32)
    kp[:ksize, :ksize] = kernel
    kp = torch.roll(kp, shifts=(-pad, -pad), dims=(0, 1))
    Xf = torch.fft.rfft2(xp)
    Kf = torch.fft.rfft2(kp)
    out = torch.fft.irfft2(Xf * Kf.unsqueeze(0).unsqueeze(0), s=(Hp, Wp))
    return out[..., pad:pad + H, pad:pad + W]


def apply_camera_defocus(images, p):
    """Defocus de camara: desenfoque con kernel de diafragma, bokeh que
    'florece' en las altas luces (media ponderada: los especulares dominan el
    disco en vez de diluirse) y fringe cromatico opcional en el borde."""
    dev = _device()
    radius = max(0.0, float(p["radius"]))
    boost = max(0.0, float(p["boost"]))
    thr = min(0.99, max(0.0, float(p["threshold"])))
    fringe = max(0.0, float(p["fringe"]))
    out_frames = []
    for i in range(images.shape[0]):
        img = images[i:i + 1].to(dev).movedim(-1, 1).float()  # [1,3,H,W]
        H, W = img.shape[-2], img.shape[-1]
        rpx = radius / 100.0 * W
        if rpx < 0.75:
            out_frames.append(images[i:i + 1].clone())
            continue
        # peso de altas luces: los especulares mandan en el bokeh
        luma = (img[:, 0:1] * 0.2126 + img[:, 1:2] * 0.7152 + img[:, 2:3] * 0.0722)
        t = torch.clamp((luma - thr) / max(1.0 - thr, 1e-3), 0.0, 1.0)
        wgt = 1.0 + boost * 4.0 * t * t
        # fringe: radio ligeramente distinto por canal (borde del bokeh)
        radii = [rpx * (1.0 + fringe * 0.10), rpx, rpx * (1.0 - fringe * 0.10)]
        chans = []
        wchans = []
        for ci in range(3):
            k, ks = _aperture_kernel(radii[ci], p["blades"], p["blade_rotation"], dev)
            cw = img[:, ci:ci + 1] * wgt
            chans.append(_fft_blur(cw, k, ks))
            wchans.append(_fft_blur(wgt, k, ks))
        num = torch.cat(chans, dim=1)
        den = torch.cat(wchans, dim=1).clamp(min=1e-6)
        outi = torch.clamp(num / den, 0.0, 1.0)
        out_frames.append(outi.movedim(1, -1).cpu())
    result = torch.cat(out_frames, dim=0)
    _free_caches()
    return result


class ERCameraDefocus(PreviewImage):
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

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Camera defocus with a real-time GPU preview: true aperture-shaped "
        "blur (disc or N-blade polygon bokeh, with rotation), highlight "
        "boost so speculars bloom into bright bokeh instead of washing out, "
        "and optional chromatic fringe on the bokeh edge. Radius is a % of "
        "the image width, so the look survives resolution changes."
    )

    def run(self, images, params="{}", prompt=None, extra_pnginfo=None):
        p = dict(DEFAULT_DEFOCUS)
        try:
            data = json.loads(params or "{}")
            if isinstance(data, dict):
                for k in p:
                    if k in data:
                        try:
                            p[k] = float(data[k])
                        except Exception:
                            pass
        except Exception:
            pass
        out = apply_camera_defocus(images, p)
        res = self.save_images(images[:1], "ER.defocus.", prompt, extra_pnginfo)
        return {"ui": {"er_lens": res["ui"]["images"]}, "result": (out,)}


NODE_CLASS_MAPPINGS = {
    "ERLensEffects": ERLensEffects,
    "ERLensFlare": ERLensFlare,
    "ERLensCameraDirt": ERLensCameraDirt,
    "ERCameraDefocus": ERCameraDefocus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERLensEffects": "ER Lens Effects",
    "ERLensFlare": "ER Lens Flare",
    "ERLensCameraDirt": "ER Lens Camera Dirt",
    "ERCameraDefocus": "ER Camera Defocus",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
