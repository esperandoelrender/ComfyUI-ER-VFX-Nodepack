import base64
import os
import random
import time
from fractions import Fraction

import numpy as np
import torch
import torch.nn.functional as F

import folder_paths
from nodes import PreviewImage


def free_memory_caches():
    """Purga las caches de RAM y VRAM tras cada computo del wedge: evita la
    acumulacion de memoria entre runs sin descargar los modelos (descargarlos
    obligaria a recargarlos en cada wedge y seria mucho mas lento)."""
    try:
        import gc
        gc.collect()
        import comfy.model_management as mm
        mm.soft_empty_cache()
    except Exception:
        pass


def downscale_for_preview(images, max_side=448):
    """Reescala el batch (lado mayor <= max_side, dims pares). Procesa por
    bloques para no duplicar batches grandes de golpe en memoria."""
    h, w = images.shape[1], images.shape[2]
    s = max_side / max(h, w)
    if s >= 1.0:
        nh, nw = h - (h % 2), w - (w % 2)
        if (nh, nw) == (h, w):
            return images
    else:
        nh = max(2, int(h * s)) // 2 * 2
        nw = max(2, int(w * s)) // 2 * 2
    out = []
    for i in range(0, images.shape[0], 8):
        x = images[i:i + 8, ..., :3].permute(0, 3, 1, 2)
        x = F.interpolate(x, size=(nh, nw), mode="bilinear", align_corners=False)
        out.append(x.permute(0, 2, 3, 1))
    return torch.cat(out)


def encode_video(images, fps, path, crf=21):
    """Encode a ComfyUI IMAGE batch (B,H,W,C float 0-1) to an H.264 MP4."""
    import av

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


class ERBatchSequencer(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
            },
            "optional": {
                # metadatos del wedge (los rellena el frontend en cada run);
                # viajan con el prompt y vuelven con el resultado, asi el
                # etiquetado sobrevive a recargas de la pagina
                "er_meta": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("images",)
    FUNCTION = "collect"
    OUTPUT_NODE = True
    CATEGORY = "utils"
    DESCRIPTION = (
        "VFX-style wedge sequencer (as in Houdini wedging): link any widgets "
        "of any nodes (seed, cfg, steps...), define value lists or ranges, "
        "run all the wedges and compare the results (image or video) side by "
        "side with their parameter values overlaid."
    )

    def collect(self, images, er_meta="", fps=16.0, prompt=None, extra_pnginfo=None):
        # fps solo se usa si llega un batch de frames (proxy MP4); los
        # workflows antiguos que aun envian fps siguen funcionando
        if images.shape[0] <= 1:
            # imagen: preview PNG estandar
            res = self.save_images(images, "ER.batch.", prompt, extra_pnginfo)
            item = dict(res["ui"]["images"][0])
            item["kind"] = "image"
            item["meta"] = er_meta
            ui = {"er_batch": [item]}
        else:
            # video: proxy MP4 ligero (rejilla) + version HD hasta 1080p/1920
            # (solo se usa al exportar el contact sheet, para que se vea bien)
            temp_dir = folder_paths.get_temp_directory()
            os.makedirs(temp_dir, exist_ok=True)
            base = f"er_batch_{int(time.time() * 1000)}_{random.randint(0, 99999):05d}"
            filename = f"{base}.mp4"
            hd_filename = f"{base}_hd.mp4"
            encode_video(downscale_for_preview(images), fps, os.path.join(temp_dir, filename))
            encode_video(downscale_for_preview(images, max_side=1920), fps, os.path.join(temp_dir, hd_filename))
            ui = {"er_batch": [{"kind": "video", "filename": filename, "hd": hd_filename, "subfolder": "", "type": "temp", "meta": er_meta}]}

        free_memory_caches()
        return {"ui": ui, "result": (images,)}


class ERBatchSequencerVideo(ERBatchSequencer):
    """Variante con entrada/salida VIDEO: el proxy usa el fps del propio video."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO",),
            },
            "optional": {
                "er_meta": ("STRING", {"default": ""}),
            },
            "hidden": {
                "prompt": "PROMPT",
                "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "collect_video"
    DESCRIPTION = (
        "VFX-style wedge sequencer for VIDEO inputs (Create Video, LTX, Wan...): "
        "link any widgets of any nodes, define value lists or ranges, run all "
        "the wedges and compare the resulting videos side by side with their "
        "parameter values overlaid. Passes the video through."
    )

    def collect_video(self, video, er_meta="", prompt=None, extra_pnginfo=None):
        comps = video.get_components()
        fps = float(comps.frame_rate) or 16.0
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(temp_dir, exist_ok=True)
        base = f"er_batch_{int(time.time() * 1000)}_{random.randint(0, 99999):05d}"
        filename = f"{base}.mp4"
        hd_filename = f"{base}_hd.mp4"
        encode_video(downscale_for_preview(comps.images), fps, os.path.join(temp_dir, filename))
        encode_video(downscale_for_preview(comps.images, max_side=1920), fps, os.path.join(temp_dir, hd_filename))
        ui = {"er_batch": [{"kind": "video", "filename": filename, "hd": hd_filename, "subfolder": "", "type": "temp", "meta": er_meta}]}
        free_memory_caches()
        return {"ui": ui, "result": (video,)}


class ERWedgePreview:
    """Galeria de presentacion (solo frontend): refleja los resultados de
    IMAGEN de un ER Wedge Sequencer con sus atributos, listo para cliente."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "utils"
    DESCRIPTION = (
        "Client-facing gallery for IMAGE results: mirrors every image produced "
        "by the ER Wedge Sequencer nodes in the workflow, grouped and labelled "
        "per wedge (WEDGE 1, WEDGE 2...) with the parameter values of each one. "
        "Type a custom title and export a single contact-sheet PNG."
    )

    def noop(self):
        return {}


class ERWedgePreviewVideo(ERWedgePreview):
    """Igual que ERWedgePreview pero para los resultados de VIDEO."""

    DESCRIPTION = (
        "Client-facing gallery for VIDEO results: mirrors every video produced "
        "by the ER Wedge Sequencer nodes in the workflow, grouped and labelled "
        "per wedge with the parameter values of each one (videos autoplay in "
        "the gallery). Type a custom title and export a contact-sheet PNG with "
        "the first frame of each video."
    )


def _sheet_font(size):
    """Fuente para las hojas de contacto (con fallback multiplataforma)."""
    from PIL import ImageFont
    for name in ("arialbd.ttf", "arial.ttf", "segoeui.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def _resolve_media_path(item):
    fname = os.path.basename(str(item.get("filename", "")))
    base = (
        folder_paths.get_temp_directory()
        if item.get("type", "temp") == "temp"
        else folder_paths.get_output_directory()
    )
    sub = str(item.get("subfolder", "")).strip()
    return os.path.join(base, sub, fname) if sub else os.path.join(base, fname)


# endpoint para guardar el contact sheet en una carpeta elegida por el usuario
# (si el campo de carpeta esta vacio, el frontend descarga via navegador)
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/er_wedge/save_sheet")
    async def er_wedge_save_sheet(request):
        try:
            data = await request.json()
            dir_raw = str(data.get("dir", "")).strip().strip('"')
            filename = os.path.basename(str(data.get("filename", "contact_sheet.png")))
            if not filename.lower().endswith(".png"):
                filename += ".png"
            b64 = str(data.get("data", ""))
            if "," in b64:
                b64 = b64.split(",", 1)[1]
            raw = base64.b64decode(b64)
            if not dir_raw:
                return web.json_response({"error": "no folder given"}, status=400)
            # ruta relativa -> dentro de la carpeta output de ComfyUI
            out_dir = dir_raw if os.path.isabs(dir_raw) else os.path.join(
                folder_paths.get_output_directory(), dir_raw
            )
            os.makedirs(out_dir, exist_ok=True)
            path = os.path.abspath(os.path.join(out_dir, filename))
            with open(path, "wb") as f:
                f.write(raw)
            return web.json_response({"path": path})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/er_wedge/save_sheet_video")
    async def er_wedge_save_sheet_video(request):
        """Compone un contact sheet en VIDEO (.mp4): rejilla con todos los
        clips reproduciendose a la vez, cabecera y etiquetas de atributos."""
        try:
            import av
            from PIL import Image, ImageDraw

            data = await request.json()
            items = data.get("items") or []
            if not items:
                return web.json_response({"error": "no items"}, status=400)
            title = str(data.get("title", "")).strip() or "ER WEDGES"
            subtitle = str(data.get("subtitle", "")).strip()
            dir_raw = str(data.get("dir", "")).strip().strip('"')
            filename = os.path.basename(str(data.get("filename", "er_wedges.mp4")))
            if not filename.lower().endswith(".mp4"):
                filename += ".mp4"

            # sondeo de dimensiones (sin decodificar) para fijar el layout
            probed = []
            for it in items:
                path = _resolve_media_path(it)
                if not os.path.isfile(path):
                    return web.json_response({"error": f"missing video: {os.path.basename(path)}"}, status=404)
                c = av.open(path)
                st = c.streams.video[0]
                probed.append({
                    "path": path,
                    "w": int(st.width), "h": int(st.height),
                    "fps": float(st.average_rate) if st.average_rate else 16.0,
                    "label": str(it.get("label", "")),
                })
                c.close()

            n = len(probed)
            cols = int(np.ceil(np.sqrt(n)))
            rows = int(np.ceil(n / cols))
            PAD, GAP = 16, 10
            # hoja de ~1920 de ancho (1080p), sin escalar por encima del material
            TARGET_W = 1920
            tw = (TARGET_W - PAD * 2 - (cols - 1) * GAP) // cols
            tw = min(tw, max(p["w"] for p in probed))
            aspects = sorted(p["w"] / p["h"] for p in probed)
            med_aspect = aspects[len(aspects) // 2]
            th = max(96, round(tw / med_aspect))
            tw += tw % 2
            th += th % 2
            title_size = max(24, (PAD * 2 + cols * tw + (cols - 1) * GAP) // 60)
            HEADER = title_size + 34
            label_size = max(15, tw // 34)
            LABEL_H = label_size + 12

            # decodifica escalando ya al tamano del tile (memoria contenida)
            clips = []
            for p in probed:
                s = min(tw / p["w"], th / p["h"])
                sw = max(2, int(p["w"] * s) // 2 * 2)
                sh = max(2, int(p["h"] * s) // 2 * 2)
                container = av.open(p["path"])
                frames = []
                for fr in container.decode(video=0):
                    frames.append(fr.reformat(width=sw, height=sh, format="rgb24").to_ndarray())
                    if len(frames) >= 900:  # tope de seguridad
                        break
                container.close()
                if not frames:
                    return web.json_response({"error": f"empty video: {os.path.basename(p['path'])}"}, status=400)
                clips.append({"frames": frames, "fps": p["fps"], "label": p["label"]})
            W = PAD * 2 + cols * tw + (cols - 1) * GAP
            H = HEADER + rows * (th + GAP) - GAP + PAD
            W += W % 2
            H += H % 2
            out_fps = max(c["fps"] for c in clips)
            total = max(len(c["frames"]) for c in clips)

            # plantilla estatica: fondo oscuro + cabecera con titulo y datos
            base_img = Image.new("RGB", (W, H), (20, 20, 20))
            draw = ImageDraw.Draw(base_img)
            draw.text((PAD, (HEADER - title_size) // 2 - 2), title, fill=(92, 225, 230), font=_sheet_font(title_size))
            if subtitle:
                sub_size = max(14, title_size * 7 // 12)
                fsub = _sheet_font(sub_size)
                tlen = draw.textlength(subtitle, font=fsub)
                draw.text((W - PAD - tlen, (HEADER - sub_size) // 2 + 2), subtitle, fill=(154, 154, 154), font=fsub)
            base = np.array(base_img, dtype=np.uint8)

            # overlay de etiqueta por tile (amarillo oscuro sobre banda tenue)
            label_font = _sheet_font(label_size)
            positions, overlays = [], []
            for i in range(n):
                cx, cy = i % cols, i // cols
                x = PAD + cx * (tw + GAP)
                y = HEADER + cy * (th + GAP)
                positions.append((x, y))
                lab = clips[i]["label"]
                if lab:
                    ov = Image.new("RGBA", (tw, LABEL_H), (0, 0, 0, 0))
                    d2 = ImageDraw.Draw(ov)
                    d2.rectangle([0, 0, tw, LABEL_H], fill=(0, 0, 0, 110))
                    d2.text((7, 4), lab, fill=(229, 192, 75, 255), font=label_font)
                    overlays.append(np.array(ov, dtype=np.uint8))
                else:
                    overlays.append(None)

            if dir_raw:
                out_dir = dir_raw if os.path.isabs(dir_raw) else os.path.join(
                    folder_paths.get_output_directory(), dir_raw
                )
                os.makedirs(out_dir, exist_ok=True)
                out_path = os.path.abspath(os.path.join(out_dir, filename))
            else:
                out_dir = folder_paths.get_temp_directory()
                os.makedirs(out_dir, exist_ok=True)
                out_path = os.path.join(out_dir, filename)

            # codificacion en streaming (frame a frame, memoria contenida)
            out = av.open(out_path, mode="w")
            stream = out.add_stream("libx264", rate=Fraction(out_fps).limit_denominator(1000))
            stream.width = W
            stream.height = H
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf": "21", "preset": "veryfast"}
            for t in range(total):
                frame = base.copy()
                for i, clip in enumerate(clips):
                    frs = clip["frames"]
                    fr = frs[t] if t < len(frs) else frs[-1]  # los cortos congelan el ultimo frame
                    fh, fw = fr.shape[0], fr.shape[1]
                    x, y = positions[i]
                    ox = x + (tw - fw) // 2
                    oy = y + (th - fh) // 2
                    frame[oy:oy + fh, ox:ox + fw] = fr
                    ov = overlays[i]
                    if ov is not None:
                        ly = y + th - LABEL_H
                        region = frame[ly:ly + LABEL_H, x:x + tw].astype(np.float32)
                        alpha = ov[:, :, 3:4].astype(np.float32) / 255.0
                        region = region * (1 - alpha) + ov[:, :, :3].astype(np.float32) * alpha
                        frame[ly:ly + LABEL_H, x:x + tw] = region.astype(np.uint8)
                vf = av.VideoFrame.from_ndarray(np.ascontiguousarray(frame), format="rgb24")
                for packet in stream.encode(vf):
                    out.mux(packet)
            for packet in stream.encode():
                out.mux(packet)
            out.close()

            if dir_raw:
                return web.json_response({"path": out_path})
            # sin carpeta: el frontend lo descarga desde el temp del servidor
            return web.json_response({"filename": filename, "subfolder": "", "type": "temp"})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
except Exception:
    pass


NODE_CLASS_MAPPINGS = {
    "ERBatchSequencer": ERBatchSequencer,
    "ERBatchSequencerVideo": ERBatchSequencerVideo,
    "ERWedgePreview": ERWedgePreview,
    "ERWedgePreviewVideo": ERWedgePreviewVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERBatchSequencer": "ER Wedge Sequencer",
    "ERBatchSequencerVideo": "ER Wedge Sequencer Video",
    "ERWedgePreview": "ER Wedge Preview Image",
    "ERWedgePreviewVideo": "ER Wedge Preview Video",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
