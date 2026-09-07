"""ER EditGen: edicion generativa multi-referencia en un solo nodo.

Pensado para modelos de edicion que usan referencias latentes (FLUX.2 klein,
FLUX.1 Kontext, Qwen-Image-Edit...): varias imagenes de entrada + prompt, y
una salida LATENT para poder encadenar iteraciones SIN pasar por el VAE
(sin decodificar y volver a codificar, que es lo que degrada la imagen a
cada vuelta).
"""

import gc
import json
import math

import torch

import comfy.latent_formats
import comfy.model_management
import comfy.sample
import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import latent_preview
import node_helpers
from nodes import MAX_RESOLUTION, PreviewImage

MAX_REFS = 8  # ranuras de referencia disponibles; el nodo va mostrando la siguiente


# ------------------------------------------------------- carga de modelos
# El nodo carga el modelo, el text encoder y el VAE el mismo (como el
# subgrafo oficial) para no tener que cablear tres loaders. Se quedan en
# cache: ComfyUI vuelve a ejecutar el nodo en cada tirada y no queremos
# releer 9 GB de disco cada vez. Solo se guarda uno de cada tipo, asi al
# cambiar de modelo se suelta el anterior.

_CACHE = {}


def _cached(kind, key, factory):
    entry = _CACHE.get(kind)
    if entry is not None and entry[0] == key:
        return entry[1]
    _CACHE.pop(kind, None)  # suelta el anterior antes de cargar el nuevo
    obj = factory()
    _CACHE[kind] = (key, obj)
    return obj


def _clip_types():
    try:
        names = [t.name.lower() for t in comfy.sd.CLIPType]
    except Exception:
        names = ["flux2", "stable_diffusion"]
    if "flux2" in names:  # el caso principal, primero
        names.remove("flux2")
        names.insert(0, "flux2")
    return names


def _load_unet(name, weight_dtype):
    def build():
        options = {}
        if weight_dtype == "fp8_e4m3fn":
            options["dtype"] = torch.float8_e4m3fn
        elif weight_dtype == "fp8_e4m3fn_fast":
            options["dtype"] = torch.float8_e4m3fn
            options["fp8_optimizations"] = True
        elif weight_dtype == "fp8_e5m2":
            options["dtype"] = torch.float8_e5m2
        path = folder_paths.get_full_path_or_raise("diffusion_models", name)
        return comfy.sd.load_diffusion_model(path, model_options=options)

    return _cached("unet", (name, weight_dtype), build)


def _load_clip(name, clip_type):
    def build():
        ctype = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
        path = folder_paths.get_full_path_or_raise("text_encoders", name)
        return comfy.sd.load_clip(
            ckpt_paths=[path],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=ctype,
            model_options={},
        )

    return _cached("clip", (name, clip_type), build)


def _pick(names, patterns):
    """Preselecciona el fichero que mejor encaje. Los valores por defecto del
    nodo son los de FLUX.2 klein destilado (4 pasos, cfg 1, 1 MP, euler), asi
    que al soltarlo ya viene listo si tienes esos ficheros; si no, queda vacio
    y eliges tu."""
    low = [(n, n.lower()) for n in names]
    for p in patterns:
        for name, lower in low:
            if p in lower:
                return name
    return ""


def _load_vae(name):
    def build():
        path = folder_paths.get_full_path_or_raise("vae", name)
        return comfy.sd.VAE(sd=comfy.utils.load_torch_file(path))

    return _cached("vae", (name,), build)


# ficheros de LoRA cacheados entre tiradas (LRU de 4)
_LORA_FILES = {}


def _lora_sd(name):
    sd = _LORA_FILES.pop(name, None)
    if sd is None:
        path = folder_paths.get_full_path_or_raise("loras", name)
        sd = comfy.utils.load_torch_file(path, safe_load=True)
    _LORA_FILES[name] = sd
    while len(_LORA_FILES) > 4:
        _LORA_FILES.pop(next(iter(_LORA_FILES)))
    return sd


def _apply_loras(model, clip, loras_json):
    """Aplica la lista de LoRAs del widget JSON, en orden. Lista vacia o
    entradas sin nombre = no hace nada. Devuelve clones; la cache del
    modelo base no se toca."""
    try:
        items = json.loads(loras_json or "[]")
    except Exception:
        items = []
    count = 0
    if isinstance(items, list):
        for it in items:
            if not isinstance(it, dict):
                continue
            name = it.get("name") or ""
            try:
                strength = float(it.get("strength", 1.0))
            except Exception:
                strength = 1.0
            if not name or abs(strength) < 1e-6:
                continue
            model, clip = comfy.sd.load_lora_for_models(model, clip, _lora_sd(name), strength, strength)
            count += 1
    return model, clip, count


def _free_caches():
    try:
        gc.collect()
        comfy.model_management.soft_empty_cache()
    except Exception:
        pass


# ------------------------------------------------------------ espacio latente

def _latent_geometry(model, vae):
    """(canales, reduccion espacial) del latente que espera el modelo.
    Flux.2 -> 128 canales y /16; Flux.1 / Qwen / SDXL -> 16 o 4 y /8."""
    ch, ds = 16, 8
    try:
        lf = model.model.latent_format
        ch = int(getattr(lf, "latent_channels", ch))
        ds = int(getattr(lf, "spacial_downscale_ratio", ds))
    except Exception:
        # sin latent_format utilizable, el VAE sabe en que espacio trabaja
        try:
            ch = int(getattr(vae, "latent_channels", ch))
            ds = int(getattr(vae, "downscale_ratio", ds))
        except Exception:
            pass
    return max(1, ch), max(1, ds)


def _is_flux2(model):
    """Flux.2 (klein incluido) usa un horario de ruido empirico propio."""
    try:
        cls = getattr(comfy.latent_formats, "Flux2", None)
        return cls is not None and isinstance(model.model.latent_format, cls)
    except Exception:
        return False


# ------------------------------------------------- horario de ruido de Flux.2
# Espejo de comfy_extras/nodes_flux.py (Flux2Scheduler): el modelo destilado
# depende de este horario, con otro los 4 pasos no convergen.

def _snr_shift(t, mu, sigma):
    return math.exp(mu) / (math.exp(mu) + (1.0 / t - 1.0) ** sigma)


def _empirical_mu(image_seq_len, num_steps):
    a1, b1 = 8.73809524e-05, 1.89833333
    a2, b2 = 0.00016927, 0.45666666
    if image_seq_len > 4300:
        return float(a2 * image_seq_len + b2)
    m_200 = a2 * image_seq_len + b2
    m_10 = a1 * image_seq_len + b1
    a = (m_200 - m_10) / 190.0
    b = m_200 - 200.0 * a
    return float(a * num_steps + b)


def _flux2_sigmas(num_steps, image_seq_len):
    mu = _empirical_mu(image_seq_len, num_steps)
    timesteps = torch.linspace(1, 0, num_steps + 1)
    return _snr_shift(timesteps, mu, 1.0)


# ----------------------------------------------------------------- referencias

def _align(ds):
    """Multiplo al que redondear los lados en pixeles. Ademas de la reduccion
    del VAE, los DiT agrupan el latente en parches 2x2, asi que el latente
    tiene que quedar par: con ds=8 hacen falta multiplos de 16."""
    return max(ds, 16)


def _scale_image(image, megapixels, ds, method="lanczos"):
    """Reescala a ~megapixels manteniendo aspecto, con lados alineados
    (asi el encode es exacto y el latente entra entero en los parches)."""
    _, h, w, _ = image.shape
    a = _align(ds)
    s = math.sqrt((megapixels * 1024.0 * 1024.0) / max(1.0, float(w * h))) if megapixels > 0 else 1.0
    nw = max(a, int(round(w * s / a)) * a)
    nh = max(a, int(round(h * s / a)) * a)
    if (nw, nh) == (w, h):
        return image
    out = comfy.utils.common_upscale(image.movedim(-1, 1), nw, nh, method, "disabled")
    return out.movedim(1, -1)


def _encode_ref(vae, image, megapixels, ds):
    """Codifica UNA imagen de referencia (si llega un batch, el primer frame)."""
    img = _scale_image(image[:1], megapixels, ds)
    return vae.encode(img[:, :, :, :3])


def _add_refs(cond, refs):
    """Encadena referencias latentes en el condicionado (equivale a encadenar
    varios nodos Set Reference Latent)."""
    for r in refs:
        cond = node_helpers.conditioning_set_values(cond, {"reference_latents": [r]}, append=True)
    return cond


def _change_mask(new, base, strong=False):
    """Candado de edicion: mascara suave [1,1,H,W] con las zonas que el modelo
    cambio DE VERDAD respecto a la base, medida en el propio espacio latente.
    Devuelve None si la edicion es global (reinyectar seria contraproducente)
    o si no se detecta ningun cambio."""
    d = (new.float() - base.float()).abs().mean(dim=1, keepdim=True)  # [1,1,H,W]
    med = d.median()
    mad = (d - med).abs().median() + 1e-6
    k = 4.0 if strong else 6.0
    m = (d > med + k * mad).float()
    area = float(m.mean())
    if area <= 0.001 or area > (0.85 if strong else 0.6):
        return None
    # FUERZA de la senal: en una edicion local real, la zona marcada destaca
    # muchisimo sobre el fondo (x10-100 la mediana). Si apenas destaca, el
    # cambio es GLOBAL y SUTIL (reinterpretaciones, texturas, gradings del
    # modelo) y bloquearlo se comeria la edicion entera — mejor apartarse.
    sel = d[m > 0.5]
    strength = float(sel.mean() / (med + 1e-6)) if sel.numel() else 0.0
    if strength < (2.5 if strong else 6.0):
        return None
    # dilata un paso y empluma dos: el injerto no debe dejar costuras (cada
    # pixel latente son ~16 px de imagen, la pluma cubre la transicion)
    m = torch.nn.functional.max_pool2d(m, 3, stride=1, padding=1)
    for _ in range(2):
        m = torch.nn.functional.avg_pool2d(m, 3, stride=1, padding=1)
    return m.clamp(0.0, 1.0)


def _zero_out(cond):
    """Condicionado negativo vacio (equivale a ConditioningZeroOut)."""
    out = []
    for t in cond:
        d = t[1].copy()
        pooled = d.get("pooled_output", None)
        if pooled is not None:
            d["pooled_output"] = torch.zeros_like(pooled)
        out.append([torch.zeros_like(t[0]), d])
    return out


def _encode_prompt(clip, text):
    tokens = clip.tokenize(text)
    try:
        return clip.encode_from_tokens_scheduled(tokens)
    except AttributeError:  # ComfyUI antiguos
        cond, pooled = clip.encode_from_tokens(tokens, return_pooled=True)
        return [[cond, {"pooled_output": pooled}]]


# ----------------------------------------------------------------------- nodo

class EREditGen(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        unets = folder_paths.get_filename_list("diffusion_models")
        clips = folder_paths.get_filename_list("text_encoders")
        vaes = folder_paths.get_filename_list("vae")
        # el nodo sale configurado para FLUX.2 klein; si no esta instalado,
        # los selectores salen vacios en vez de preseleccionar cualquier cosa
        klein = _pick(unets, ("klein", "flux-2", "flux2"))
        return {
            "required": {
                # los modelos se eligen aqui mismo; las entradas model/clip/vae
                # de abajo son para quien prefiera sus propios loaders
                "unet_name": ([""] + unets,
                              {"default": klein,
                               "tooltip": "Diffusion model. Leave empty to use the model input."}),
                "clip_name": ([""] + clips,
                              {"default": _pick(clips, ("qwen_3_8b", "qwen3_8b", "qwen_3", "qwen3")) if klein else "",
                               "tooltip": "Text encoder. Leave empty to use the clip input."}),
                "clip_type": (_clip_types(), {"default": "flux2",
                                              "tooltip": "Text encoder family: flux2 for FLUX.2 klein."}),
                "vae_name": ([""] + vaes,
                             {"default": _pick(vaes, ("full_encoder_small_decoder", "flux2-vae", "flux2")) if klein else "",
                              "tooltip": "VAE. Leave empty to use the vae input."}),
                "text": ("STRING", {"multiline": True, "default": "", "dynamicPrompts": True,
                                    "tooltip": "What to generate or how to edit the reference images."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 200,
                                  "tooltip": "4 for distilled models (FLUX.2 klein distilled), 20-28 for base ones."}),
                "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 30.0, "step": 0.1,
                                  "tooltip": "1.0 for distilled models. Above 1.0 the negative pass is computed too (slower)."}),
                "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 4.0, "step": 0.05,
                                         "tooltip": "Working resolution: references are scaled to this, and the output matches the first one."}),
                "denoise": ("FLOAT", {"default": 1.0, "min": 0.05, "max": 1.0, "step": 0.01,
                                      "tooltip": "1.0 = generate from scratch. Below 1.0 it refines the connected latent instead (no VAE round-trip)."}),
            },
            "optional": {
                # la cadena de latentes esta oculta hasta que se pide con el
                # boton de la cadena; las imagenes van apareciendo una a una
                "latent": ("LATENT", {"tooltip": "Result of another ER EditGen: used as a reference WITHOUT re-encoding it (no quality loss)."}),
                **{f"image_{i}": ("IMAGE",) for i in range(1, MAX_REFS + 1)},
                # inpaint: con mascara conectada solo se regenera la zona
                # blanca; el resto queda clavado a image_1 (o al latente)
                "mask": ("MASK", {"tooltip": "Inpaint mask: white = area to regenerate, black = untouched. Applies over image_1 (or the chained latent)."}),
                # LoRAs opcionales gestionados por la UI del nodo (JSON):
                # lista de {name, strength}; vacia = sin LoRA
                "loras": ("STRING", {"default": "[]"}),
                "weight_dtype": (["default", "fp8_e4m3fn", "fp8_e4m3fn_fast", "fp8_e5m2"], {"default": "default"}),
                "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
                "scheduler": (["auto"] + list(comfy.samplers.KSampler.SCHEDULERS), {"default": "auto"}),
                # candado de edicion: tras generar, detecta DONDE cambio de
                # verdad la imagen y reinyecta el latente original en todo lo
                # demas — la zona no editada queda bit a bit identica, por
                # muchos eslabones que encadenes
                "preserve": (["auto", "off", "strong"],
                             {"default": "auto",
                              "tooltip": "Edit lock: keeps un-edited areas bit-exact from the source latent/image. "
                                         "auto = detect the changed region and graft the rest back (skipped when the "
                                         "edit is global); strong = tighter detection; off = raw model output."}),
                "width": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 16,
                                  "tooltip": "0 = same size as the first reference (or 1024 with no references)."}),
                "height": ("INT", {"default": 0, "min": 0, "max": MAX_RESOLUTION, "step": 16}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("IMAGE", "LATENT")
    RETURN_NAMES = ("images", "latent")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "image/generation"
    DESCRIPTION = (
        "Multi-reference generative editing in a single node, for edit models "
        "that take reference latents (FLUX.2 klein, FLUX.1 Kontext, "
        "Qwen-Image-Edit...). Pick the model, the text encoder and the VAE "
        "right here (no loader nodes to wire), plug up to 4 reference images "
        "(a new image slot appears as you fill the previous one) "
        "plus a prompt, and it handles the scaling, the VAE encoding, the "
        "reference chain on both positive and negative, the model's own noise "
        "schedule and the sampling. The latent output feeds the latent input "
        "of the next ER EditGen, so you can keep editing round after round "
        "WITHOUT decoding and re-encoding the image (no generation loss)."
    )

    def run(self, unet_name, clip_name, clip_type, vae_name, text, seed, steps, cfg,
            megapixels, denoise, weight_dtype="default", latent=None, mask=None,
            loras="[]",
            sampler_name="euler", scheduler="auto", width=0, height=0,
            preserve="auto", prompt=None, extra_pnginfo=None, **images):

        if not unet_name:
            raise ValueError("ER EditGen: pick a diffusion model in unet_name.")
        if not vae_name:
            raise ValueError("ER EditGen: pick a VAE in vae_name.")
        if not clip_name:
            raise ValueError("ER EditGen: pick a text encoder in clip_name.")

        model = _load_unet(unet_name, weight_dtype)
        vae = _load_vae(vae_name)
        clip = _load_clip(clip_name, clip_type)
        model, clip, lora_count = _apply_loras(model, clip, loras)
        positive = _encode_prompt(clip, text)

        ch, ds = _latent_geometry(model, vae)

        # referencias: primero el latente encadenado (ya esta en el espacio del
        # modelo, no se vuelve a codificar), luego las imagenes
        refs = []
        prev = None
        if latent is not None:
            prev = latent["samples"]
            refs.append(prev)
        for i in range(1, MAX_REFS + 1):
            img = images.get(f"image_{i}")
            if img is not None:
                refs.append(_encode_ref(vae, img, megapixels, ds))

        # base del candado de edicion: el latente encadenado o, si no lo hay,
        # la primera imagen codificada (se capta ANTES de las exclusiones de
        # inpaint/refinado)
        keep_src = refs[0] if refs else None

        # inpaint: la base es el latente encadenado o image_1 codificada; el
        # sampler solo regenera la zona blanca de la mascara.
        # CLAVE: la base se SACA de las referencias — un modelo de edicion
        # (klein, Kontext...) reconstruye lo que ve en su referencia, incluida
        # la zona enmascarada, y el inpaint no cambiaria nada. El contexto de
        # la escena le llega igualmente por el propio latente bloqueado; las
        # demas referencias (image_2..., o image_1 si la base es el latente)
        # quedan como material para el hueco.
        inpaint_base = None
        if mask is not None:
            if not refs:
                raise ValueError("ER EditGen: the mask needs image_1 (or a chained latent) to inpaint over.")
            inpaint_base = refs[0]
            refs = refs[1:]

        # tamano de trabajo: el pedido, el de la primera referencia, o 1024
        a = _align(ds)
        refine = denoise < 1.0 and prev is not None
        if refine:
            # el latente que se refina NO va tambien como referencia: el
            # modelo se condicionaria con la misma imagen que esta
            # denoising y cada eslabon amplificaria sus propios rasgos
            # (contraste/saturacion/textura cada vez mas "fritos"). Igual
            # que en inpaint, el contexto ya le llega por el propio latente.
            refs = [r for r in refs if r is not prev]
        if inpaint_base is not None:
            w, h = int(inpaint_base.shape[-1]) * ds, int(inpaint_base.shape[-2]) * ds
        elif refine:
            w, h = int(prev.shape[-1]) * ds, int(prev.shape[-2]) * ds
        else:
            if width and height:
                w, h = int(width), int(height)
            elif refs:
                w, h = int(refs[0].shape[-1]) * ds, int(refs[0].shape[-2]) * ds
            else:
                w = h = 1024
            w, h = max(a, w // a * a), max(a, h // a * a)

        # el negativo lleva las MISMAS referencias que el positivo
        pos = _add_refs(positive, refs)
        neg = _add_refs(_zero_out(positive), refs)

        denoise_mask = None
        if inpaint_base is not None:
            latent_image = inpaint_base.clone()
            # mismo formato que SetLatentNoiseMask; el sampler la reescala
            # al tamano del latente y la lleva al dispositivo
            m = mask
            if m.dim() == 2:
                m = m.unsqueeze(0)
            denoise_mask = m[:1].reshape((-1, 1, m.shape[-2], m.shape[-1])).float()
        elif refine:
            latent_image = prev.clone()
        else:
            latent_image = torch.zeros(
                [1, ch, h // ds, w // ds],
                device=comfy.model_management.intermediate_device(),
            )
        latent_image = comfy.sample.fix_empty_latent_channels(model, latent_image)

        # horario de ruido: el empirico de Flux.2 cuando toca, si no el elegido
        total_steps = steps if denoise >= 1.0 else max(1, int(steps / max(denoise, 1e-3)))
        if _is_flux2(model) and scheduler == "auto":
            sigmas = _flux2_sigmas(total_steps, round(w * h / float(ds * ds)))
        else:
            sched = "normal" if scheduler == "auto" else scheduler
            sigmas = comfy.samplers.calculate_sigmas(
                model.get_model_object("model_sampling"), sched, total_steps
            )
        sigmas = sigmas[-(steps + 1):]

        guider = comfy.samplers.CFGGuider(model)
        guider.set_conds(pos, neg)
        guider.set_cfg(cfg)
        sampler = comfy.samplers.sampler_object(sampler_name)
        noise = comfy.sample.prepare_noise(latent_image, seed, None)
        callback = latent_preview.prepare_callback(model, sigmas.shape[-1] - 1)

        samples = guider.sample(
            noise, latent_image, sampler, sigmas,
            denoise_mask=denoise_mask, callback=callback,
            disable_pbar=not comfy.utils.PROGRESS_BAR_ENABLED, seed=seed,
        )
        samples = samples.to(comfy.model_management.intermediate_device())

        # candado de edicion: fuera de la zona realmente editada se reinyecta
        # el latente original bit a bit — la unica perdida queda dentro del
        # cambio pedido, por muchos eslabones que se encadenen. Con mascara
        # manual (inpaint) no hace falta: el sampler ya bloqueo el resto.
        locked = None
        if (preserve != "off" and denoise_mask is None and keep_src is not None
                and keep_src.shape == samples.shape):
            m = _change_mask(samples, keep_src, strong=(preserve == "strong"))
            if m is not None:
                m = m.to(samples.device, samples.dtype)
                base = keep_src.to(samples.device, samples.dtype)
                samples = samples * m + base * (1.0 - m)
                locked = 1.0 - float(m.mean())

        images = vae.decode(samples)
        if len(images.shape) == 5:  # VAE de video: aplana a lista de frames
            images = images.reshape(-1, images.shape[-3], images.shape[-2], images.shape[-1])

        res = self.save_images(images, "ER.editgen.", prompt, extra_pnginfo)
        info = "{}x{} · {} ref · {} steps".format(w, h, len(refs), steps)
        if lora_count:
            info += " · {} lora{}".format(lora_count, "s" if lora_count > 1 else "")
        if inpaint_base is not None:
            info += " · mask"
        if locked is not None:
            info += " · lock {}%".format(int(round(locked * 100)))
        ui = {"er_editgen": res["ui"]["images"], "er_editgen_info": [info]}

        _free_caches()
        return {"ui": ui, "result": (images, {"samples": samples})}


NODE_CLASS_MAPPINGS = {
    "EREditGen": EREditGen,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EREditGen": "ER EditGen",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
