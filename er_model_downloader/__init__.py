import json
import os
import shutil
import threading
import time
import urllib.parse
import urllib.request
import uuid

import folder_paths


class ERModelDownloader:
    """Nodo utilitario: toda la logica vive en la UI + endpoints."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    OUTPUT_NODE = True
    CATEGORY = "utils"
    DESCRIPTION = (
        "Scans the current workflow for model files, shows which ones are "
        "missing, and downloads them into the right models/ subfolder "
        "(workflow-embedded URLs, HuggingFace search, or manual URL)."
    )

    def noop(self):
        return {"ui": {}}


# ---------------------------------------------------------------------------
# endpoints
# ---------------------------------------------------------------------------
try:
    from server import PromptServer
    from aiohttp import web

    DOWNLOADS = {}  # id -> {"done","error","read","total","path"}

    def _safe_rel(filename):
        """Nombre relativo saneado (permite subcarpetas, nunca escapar)."""
        rel = os.path.normpath(str(filename)).replace("\\", "/").lstrip("/")
        if rel.startswith("..") or "/../" in rel or not rel:
            return None
        return rel

    def _dest_dir(folder):
        """Ruta de destino: prefiere la carpeta canonica (mismo nombre que la
        categoria, p. ej. models/diffusion_models) sobre alias legacy (unet)."""
        paths = folder_paths.get_folder_paths(folder)
        for p in paths:
            if os.path.basename(os.path.normpath(p)).lower() == folder.lower():
                return p
        return paths[0]

    def _folder_info():
        """Por categoria: ruta de destino por defecto y TODAS las rutas
        registradas (incluidas las de extra_model_paths.yaml / carpetas de
        modelos compartidas), para que el usuario pueda elegir destino."""
        out = []
        for name in sorted(folder_paths.folder_names_and_paths.keys()):
            try:
                paths = [os.path.abspath(p) for p in folder_paths.get_folder_paths(name)]
                out.append({"name": name, "path": os.path.abspath(_dest_dir(name)), "paths": paths})
            except Exception:
                continue
        return out

    @PromptServer.instance.routes.post("/er_nodes/models_check")
    async def er_models_check(request):
        """Para cada nombre de archivo, busca en que carpeta de modelos existe."""
        data = await request.json()
        items = data.get("items") or []
        out = []
        for it in items[:200]:
            name = _safe_rel(it.get("name", ""))
            found = None
            path = None
            if name:
                for folder in folder_paths.folder_names_and_paths:
                    try:
                        p = folder_paths.get_full_path(folder, name)
                        if p:
                            found = folder
                            path = os.path.abspath(p)
                            break
                    except Exception:
                        continue
            out.append({"name": it.get("name", ""), "found": found, "path": path})
        # espacio libre del disco de modelos: para saber si caben las descargas
        try:
            free_space = shutil.disk_usage(folder_paths.models_dir).free
        except Exception:
            free_space = None
        return web.json_response({"items": out, "folders": _folder_info(), "free_space": free_space})

    @PromptServer.instance.routes.get("/er_nodes/model_search")
    async def er_model_search(request):
        """Busca el archivo por nombre en HuggingFace y devuelve URLs candidatas."""
        name = request.query.get("name", "").strip()
        base = os.path.basename(name)
        if not base:
            return web.json_response({"results": []})
        import asyncio

        def try_repos(repos, results):
            """Busca el archivo exacto dentro de los repos candidatos."""
            for repo in repos[:8]:
                rid = repo.get("modelId") or repo.get("id")
                if not rid:
                    continue
                try:
                    req2 = urllib.request.Request(
                        f"https://huggingface.co/api/models/{rid}/tree/main?recursive=true",
                        headers={"User-Agent": "ER-Comfy-Tools"},
                    )
                    tree = json.loads(urllib.request.urlopen(req2, timeout=15).read())
                    for f in tree:
                        if os.path.basename(f.get("path", "")) == base:
                            results.append({
                                "repo": rid,
                                "url": f"https://huggingface.co/{rid}/resolve/main/{f['path']}",
                                "size": f.get("size") or (f.get("lfs") or {}).get("size"),
                            })
                            break
                except Exception:
                    continue
                if len(results) >= 5:
                    break

        def search():
            results = []
            # varias variantes del nombre: la busqueda de HF no encuentra
            # "iclight_sd15_fc" pero si "iclight sd15" o "iclight"
            stem = os.path.splitext(base)[0][:60]
            spaced = " ".join(t for t in stem.replace("_", " ").replace("-", " ").replace(".", " ").split() if t)
            tokens = spaced.split()
            variants = []
            for v in [stem, spaced, " ".join(tokens[:2]) if len(tokens) > 2 else "", tokens[0] if tokens else ""]:
                if v and v not in variants:
                    variants.append(v)
            try:
                for q_raw in variants:
                    q = urllib.parse.quote(q_raw)
                    req = urllib.request.Request(
                        f"https://huggingface.co/api/models?search={q}&limit=8",
                        headers={"User-Agent": "ER-Comfy-Tools"},
                    )
                    try:
                        repos = json.loads(urllib.request.urlopen(req, timeout=15).read())
                    except Exception:
                        continue
                    try_repos(repos, results)
                    if results:
                        break
            except Exception as e:
                return {"results": [], "error": str(e)}
            return {"results": results}

        res = await asyncio.get_event_loop().run_in_executor(None, search)
        return web.json_response(res)

    @PromptServer.instance.routes.get("/er_nodes/model_size")
    async def er_model_size(request):
        """Tamano remoto (bytes) de una URL de modelo, sin descargarla."""
        url = request.query.get("url", "").strip()
        if not url.startswith("https://"):
            return web.json_response({"size": None})
        import asyncio

        def head():
            headers = {"User-Agent": "ER-Comfy-Tools"}
            tok = os.environ.get("HF_TOKEN")
            if tok and "huggingface.co" in url:
                headers["Authorization"] = f"Bearer {tok}"
            try:
                req = urllib.request.Request(url, headers=headers, method="HEAD")
                with urllib.request.urlopen(req, timeout=15) as r:
                    size = r.headers.get("Content-Length")
                    if size:
                        return int(size)
            except Exception:
                pass
            # algunos servidores no aceptan HEAD: GET de 1 byte con Range
            try:
                h2 = dict(headers)
                h2["Range"] = "bytes=0-0"
                req = urllib.request.Request(url, headers=h2)
                with urllib.request.urlopen(req, timeout=15) as r:
                    cr = r.headers.get("Content-Range", "")
                    if "/" in cr:
                        return int(cr.split("/")[-1])
            except Exception:
                pass
            return None

        size = await asyncio.get_event_loop().run_in_executor(None, head)
        return web.json_response({"size": size})

    def _download_worker(dl_id, url, dest, tmp):
        d = DOWNLOADS[dl_id]
        try:
            headers = {"User-Agent": "ER-Comfy-Tools"}
            token = os.environ.get("HF_TOKEN", "")
            if token and "huggingface.co" in url:
                headers["Authorization"] = f"Bearer {token}"
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=60) as r:
                # una pagina web NO es un modelo: tipico al pegar el enlace
                # /blob/ de HF o una URL de repo (devuelven HTML con 200)
                ctype = (r.headers.get("Content-Type") or "").lower()
                if "text/html" in ctype:
                    raise RuntimeError(
                        "the URL returns a web page, not a model file "
                        "(use the 'resolve' download link, or download manually)"
                    )
                d["total"] = int(r.headers.get("Content-Length") or 0)
                with open(tmp, "wb") as f:
                    while True:
                        chunk = r.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        d["read"] += len(chunk)
            # cinturon extra: un binario de modelo nunca empieza como HTML
            try:
                with open(tmp, "rb") as f:
                    head_bytes = f.read(64).lstrip()
                if head_bytes.startswith(b"<!DOCTYPE") or head_bytes.startswith(b"<html"):
                    raise RuntimeError(
                        "downloaded content is a web page, not a model file "
                        "(wrong URL or gated model - download manually)"
                    )
            except RuntimeError:
                raise
            except Exception:
                pass
            os.replace(tmp, dest)
            d["done"] = True
        except Exception as e:
            d["error"] = str(e)
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass

    @PromptServer.instance.routes.post("/er_nodes/model_download")
    async def er_model_download(request):
        data = await request.json()
        url = (data.get("url") or "").strip()
        folder = data.get("folder") or ""
        name = _safe_rel(data.get("name") or "")
        if not url.lower().startswith("https://"):
            return web.json_response({"error": "Only https:// URLs are allowed"}, status=400)
        # enlace /blob/ de HF pegado del navegador: es la pagina web del
        # fichero, no el fichero; el binario real vive en /resolve/
        if "huggingface.co/" in url and "/blob/" in url:
            url = url.replace("/blob/", "/resolve/", 1)
        if folder not in folder_paths.folder_names_and_paths:
            return web.json_response({"error": f"Unknown models folder: {folder}"}, status=400)
        if not name:
            return web.json_response({"error": "Invalid file name"}, status=400)

        # destino: por defecto la carpeta canonica; si el usuario eligio otra
        # ruta registrada (p. ej. su carpeta de modelos compartida), se valida
        # que sea realmente una de las rutas de esa categoria
        base_dir = _dest_dir(folder)
        dest_root = (data.get("dest_root") or "").strip()
        if dest_root:
            registered = {os.path.normcase(os.path.abspath(p)) for p in folder_paths.get_folder_paths(folder)}
            if os.path.normcase(os.path.abspath(dest_root)) not in registered:
                return web.json_response({"error": "dest_root is not a registered path for this folder"}, status=400)
            base_dir = dest_root
        dest = os.path.abspath(os.path.join(base_dir, name))
        if not dest.startswith(os.path.abspath(base_dir)):
            return web.json_response({"error": "Invalid destination"}, status=400)
        if os.path.exists(dest):
            return web.json_response({"error": "File already exists", "exists": True}, status=409)
        os.makedirs(os.path.dirname(dest), exist_ok=True)

        dl_id = uuid.uuid4().hex[:12]
        DOWNLOADS[dl_id] = {"done": False, "error": None, "read": 0, "total": 0, "path": dest, "started": time.time()}
        t = threading.Thread(target=_download_worker, args=(dl_id, url, dest, dest + ".part"), daemon=True)
        t.start()
        return web.json_response({"id": dl_id})

    @PromptServer.instance.routes.get("/er_nodes/model_progress")
    async def er_model_progress(request):
        d = DOWNLOADS.get(request.query.get("id", ""))
        if not d:
            return web.json_response({"error": "Unknown download id"}, status=404)
        return web.json_response({
            "done": d["done"], "error": d["error"], "read": d["read"], "total": d["total"],
            "path": d["path"],
        })
except Exception:
    # fuera del servidor (p. ej. tests) los endpoints no se registran
    pass


NODE_CLASS_MAPPINGS = {
    "ERModelDownloader": ERModelDownloader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ERModelDownloader": "ER Model Downloader",
}

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
