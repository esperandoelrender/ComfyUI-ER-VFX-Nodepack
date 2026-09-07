import json

import torch
import torch.nn.functional as F
from nodes import PreviewImage

# constantes compartidas con el shader/JS (no cambiar sin cambiar el JS)
DEPTH_Z = 0.25
GRAD_K = 2
GRAD_CLAMP = 8.0


def _hex_rgb(hex_color):
    try:
        h = hex_color.lstrip("#")
        return [int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0]
    except Exception:
        return [1.0, 1.0, 1.0]


def parse_lights(lights):
    try:
        data = json.loads(lights) if isinstance(lights, str) else lights
        out = []
        for l in data[:4]:
            out.append({
                "x": float(l.get("x", 0.5)),
                "y": float(l.get("y", 0.5)),
                "z": float(l.get("z", 0.6)),
                "radius": float(l.get("radius", 0.8)),
                "intensity": float(l.get("intensity", 1.2)),
                "color": _hex_rgb(l.get("color", "#ffffff")),
            })
        return out
    except Exception:
        return []


def luminance_depth(images):
    """Pseudo-depth por luminancia cuando no hay depth conectado.
    Must stay in sync with the JS fallback."""
    return (
        images[..., 0] * 0.2126 + images[..., 1] * 0.7152 + images[..., 2] * 0.0722
    ).clamp(0.0, 1.0)


def prepare_depth(images, depth):
    """Devuelve el depth (B,H,W) alineado con las imagenes."""
    if depth is None:
        return luminance_depth(images)
    d = depth[..., :3].mean(dim=-1)
    if d.shape[1:] != images.shape[1:3]:
        d = F.interpolate(d.unsqueeze(1), size=images.shape[1:3], mode="bilinear", align_corners=False).squeeze(1)
    if d.shape[0] != images.shape[0]:
        d = d[:1].expand(images.shape[0], -1, -1)
    return d.clamp(0.0, 1.0)


def box_blur(d, radius):
    """Triple box blur separable (aprox. gaussiana), bordes replicados.
    Must stay in sync with boxBlur3 in the JS."""
    r = int(round(radius))
    if r <= 0:
        return d
    k = 2 * r + 1
    wh = torch.ones(1, 1, 1, k, device=d.device, dtype=d.dtype) / k
    wv = torch.ones(1, 1, k, 1, device=d.device, dtype=d.dtype) / k
    x = d.unsqueeze(1)
    for _ in range(3):
        x = F.conv2d(F.pad(x, (r, r, 0, 0), mode="replicate"), wh)
        x = F.conv2d(F.pad(x, (0, 0, r, r), mode="replicate"), wv)
    return x.squeeze(1)


def derive_normals(d, normal_strength, normal_smooth):
    """Normales desde el depth: suavizado -> gradientes centrales -> clamp.
    Must stay in sync with computeNormals in the JS."""
    B, H, W = d.shape
    ds = box_blur(d, normal_smooth)
    k = GRAD_K
    dp = F.pad(ds.unsqueeze(1), (k, k, k, k), mode="replicate").squeeze(1)
    grad_x = (dp[:, k:H + k, 2 * k:] - dp[:, k:H + k, :W]) / (2.0 * k / W)
    grad_y = (dp[:, 2 * k:, k:W + k] - dp[:, :H, k:W + k]) / (2.0 * k / H)
    nx = (-grad_x * normal_strength).clamp(-GRAD_CLAMP, GRAD_CLAMP)
    ny = (-grad_y * normal_strength).clamp(-GRAD_CLAMP, GRAD_CLAMP)
    nz = torch.ones_like(nx)
    n_len = (nx * nx + ny * ny + nz * nz).sqrt()
    return nx / n_len, ny / n_len, nz / n_len


def prepare_normals(images, normals):
    """Normal map externo (RGB OpenGL, G = arriba) -> componentes y-abajo."""
    n = normals[..., :3] * 2.0 - 1.0
    if n.shape[1:3] != images.shape[1:3]:
        n = F.interpolate(n.permute(0, 3, 1, 2), size=images.shape[1:3], mode="bilinear", align_corners=False).permute(0, 2, 3, 1)
    if n.shape[0] != images.shape[0]:
        n = n[:1].expand(images.shape[0], -1, -1, -1)
    nx = n[..., 0]
    ny = -n[..., 1]  # convencion OpenGL: G hacia arriba; nuestro eje y va hacia abajo
    nz = n[..., 2].clamp(min=1e-3)
    n_len = (nx * nx + ny * ny + nz * nz).sqrt()
    return nx / n_len, ny / n_len, nz / n_len


def apply_relight(images, depth, lights, ambient, normal_strength, invert_depth, normal_smooth=3.0, normals=None):
    """Relighting screen-space. Must stay in sync with the GLSL shader in the JS."""
    img = images[..., :3].clone()
    B, H, W, _ = img.shape
    device, dtype = img.device, img.dtype

    d = prepare_depth(images, depth).to(device=device, dtype=dtype)
    if invert_depth:
        d = 1.0 - d

    # --- normales: del normal map externo si existe, si no derivadas del depth ---
    if normals is not None:
        nx, ny, nz = prepare_normals(images, normals.to(device=device, dtype=dtype))
    else:
        nx, ny, nz = derive_normals(d, normal_strength, normal_smooth)

    # --- posicion por pixel (x escalado por aspecto, y hacia abajo, z = depth) ---
    aspect = W / H
    u = torch.linspace(0.0, 1.0, W, device=device, dtype=dtype).view(1, 1, W).expand(B, H, W)
    v = torch.linspace(0.0, 1.0, H, device=device, dtype=dtype).view(1, H, 1).expand(B, H, W)
    px = u * aspect
    py = v
    pz = d * DEPTH_Z

    # --- luces puntuales (Lambert + atenuacion) ---
    total = torch.zeros(B, H, W, 3, device=device, dtype=dtype)
    for l in lights:
        lx = l["x"] * aspect
        ly = l["y"]
        lz = l["z"]
        dx = lx - px
        dy = ly - py
        dz = lz - pz
        dist = (dx * dx + dy * dy + dz * dz).sqrt().clamp(min=1e-6)
        ndotl = ((nx * dx + ny * dy + nz * dz) / dist).clamp(min=0.0)
        atten = 1.0 / (1.0 + (dist / max(l["radius"], 1e-3)) ** 2)
        contrib = (ndotl * atten * l["intensity"]).unsqueeze(-1)
        col = torch.tensor(l["color"], device=device, dtype=dtype).view(1, 1, 1, 3)
        total = total + contrib * col

    out = (img * (ambient + total)).clamp(0.0, 1.0)

    if images.shape[-1] > 3:
        out = torch.cat([out, images[..., 3:]], dim=-1)
    return out, d


class ERRelighting(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "ambient": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.01, "tooltip": "How much of the original lighting remains (0 = only your lights)"}),
                "normal_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 5.0, "step": 0.05, "tooltip": "Relief strength of the normals derived from depth"}),
                "invert_depth": ("BOOLEAN", {"default": False, "tooltip": "Enable if your depth map is black = near"}),
                # gestionado por la UI del nodo (widget oculto)
                "lights": ("STRING", {"default": "[]"}),
                # al FINAL para no desplazar los valores de workflows antiguos
                "normal_smooth": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 10.0, "step": 1.0, "tooltip": "Depth smoothing (px) before deriving normals - higher = cleaner, softer relief"}),
            },
            "optional": {
                "depth": ("IMAGE", {"tooltip": "Depth map (white = near). If not connected, a luminance-based pseudo-depth is used"}),
                "normals": ("IMAGE", {"tooltip": "Optional normal map (OpenGL convention). If connected, it replaces the depth-derived normals"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "relight"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Screen-space relighting with a real-time GPU preview: up to 4 draggable "
        "point lights (color, intensity, radius, height) shaded with normals "
        "derived from the depth map. Connect a depth map (e.g. Depth Anything) "
        "for best results."
    )

    def relight(self, images, ambient, normal_strength, invert_depth, lights, normal_smooth, depth=None, normals=None, prompt=None, extra_pnginfo=None):
        out, d_used = apply_relight(
            images, depth, parse_lights(lights), ambient, normal_strength, invert_depth,
            normal_smooth=normal_smooth, normals=normals,
        )

        # previews para el shader: imagen original + depth usado (primer frame)
        img_ui = self.save_images(images[:1], "ER.relight.img.", prompt, extra_pnginfo)["ui"]["images"]
        d_img = d_used[:1].unsqueeze(-1).expand(-1, -1, -1, 3)
        depth_ui = self.save_images(d_img, "ER.relight.depth.", prompt, extra_pnginfo)["ui"]["images"]
        ui = {"er_img": img_ui, "er_depth": depth_ui}
        if normals is not None:
            ui["er_normals"] = self.save_images(normals[:1, ..., :3], "ER.relight.norm.", prompt, extra_pnginfo)["ui"]["images"]

        return {
            "ui": ui,
            "result": (out,),
        }


NODE_CLASS_MAPPINGS = {
    "ERRelighting": ERRelighting,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERRelighting": "ER Relighting",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
