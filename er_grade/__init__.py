import json

import torch
from nodes import PreviewImage

DEFAULT_POINTS = {"bp": [0.0, 0.0, 0.0], "wp": [1.0, 1.0, 1.0], "lift": [0.0, 0.0, 0.0], "gain": [1.0, 1.0, 1.0]}


def parse_points(points):
    """Puntos de grade: bp/wp (medidos en la imagen) y lift/gain (destino)."""
    out = {k: list(v) for k, v in DEFAULT_POINTS.items()}
    try:
        data = json.loads(points) if isinstance(points, str) else points
        for k in out:
            v = data.get(k)
            if isinstance(v, (list, tuple)) and len(v) == 3:
                out[k] = [float(x) for x in v]
    except Exception:
        pass
    return out


def apply_grade(images, points, multiply, offset, gamma):
    """Grade clasico por canal. Must stay in sync with gradePixels in the JS.
    A = multiply*(gain-lift)/(wp-bp); B = offset+lift-A*bp; out = (A*v+B)^(1/gamma)"""
    img = images[..., :3].clone()
    device, dtype = img.device, img.dtype

    p = points
    bp = torch.tensor(p["bp"], device=device, dtype=dtype)
    wp = torch.tensor(p["wp"], device=device, dtype=dtype)
    lift = torch.tensor(p["lift"], device=device, dtype=dtype)
    gain = torch.tensor(p["gain"], device=device, dtype=dtype)

    denom = wp - bp
    denom = torch.where(denom.abs() < 1e-4, torch.full_like(denom, 1e-4), denom)
    A = multiply * (gain - lift) / denom
    B = offset + lift - A * bp

    out = img * A + B
    out = out.clamp(min=0.0) ** (1.0 / max(gamma, 1e-6))
    out = out.clamp(0.0, 1.0)

    if images.shape[-1] > 3:
        out = torch.cat([out, images[..., 3:]], dim=-1)
    return out


class ERGrade(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "multiply": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 4.0, "step": 0.01}),
                "offset": ("FLOAT", {"default": 0.0, "min": -1.0, "max": 1.0, "step": 0.005}),
                "gamma": ("FLOAT", {"default": 1.0, "min": 0.2, "max": 5.0, "step": 0.01}),
                # gestionado por los pickers del nodo (widget oculto):
                # {"bp":[r,g,b],"wp":[...],"lift":[...],"gain":[...]}
                "points": ("STRING", {"default": json.dumps(DEFAULT_POINTS)}),
            },
            "optional": {
                "reference": ("IMAGE", {"tooltip": "Reference image to match: pick its blacks/whites with the ref pickers"}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "grade"
    OUTPUT_NODE = True
    CATEGORY = "image/adjust"
    DESCRIPTION = (
        "Grade node with black/white match pickers and a real-time preview: "
        "sample the blackpoint/whitepoint of your image and the target "
        "black/white of a reference image to match them, plus multiply, "
        "offset and gamma controls. Run for full quality."
    )

    def grade(self, images, multiply, offset, gamma, points, reference=None, prompt=None, extra_pnginfo=None):
        out = apply_grade(images, parse_points(points), multiply, offset, gamma)

        # previews para el JS: imagen original (+ referencia si existe)
        img_ui = self.save_images(images[:1], "ER.grade.img.", prompt, extra_pnginfo)["ui"]["images"]
        ui = {"er_img": img_ui}
        if reference is not None:
            ui["er_ref"] = self.save_images(reference[:1], "ER.grade.ref.", prompt, extra_pnginfo)["ui"]["images"]

        return {
            "ui": ui,
            "result": (out,),
        }


NODE_CLASS_MAPPINGS = {
    "ERGrade": ERGrade,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERGrade": "ER Grade",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
