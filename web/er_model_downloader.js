import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

// inyecta la hoja de estilos ER Academy una sola vez
erTheme();

const NODE_TYPE = "ERModelDownloader";
const MODEL_EXT = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

// input name -> carpeta de models/ (heurística estándar de ComfyUI)
const NAME_MAP = {
    ckpt_name: "checkpoints",
    lora_name: "loras",
    vae_name: "vae",
    clip_name: "text_encoders",
    clip_name1: "text_encoders",
    clip_name2: "text_encoders",
    clip_name3: "text_encoders",
    clip_name4: "text_encoders",
    unet_name: "diffusion_models",
    control_net_name: "controlnet",
    style_model_name: "style_models",
    gligen_name: "gligen",
    ipadapter_file: "ipadapter",
    model_name: "upscale_models",
};
const TYPE_OVERRIDES = {
    CLIPVisionLoader: { clip_name: "clip_vision" },
};

const logo = new Image();
logo.src = new URL("./logo.png", import.meta.url).href;
logo.onload = () => app.graph?.setDirtyCanvas(true, true);

const fmtSize = (b) => {
    if (!b) return "";
    if (b > 1e9) return (b / 1e9).toFixed(2) + " GB";
    if (b > 1e6) return (b / 1e6).toFixed(1) + " MB";
    return Math.round(b / 1e3) + " KB";
};

// mensaje "no encontrado" con enlace para buscar el modelo en la web
function showWebSearch(msgEl, name) {
    msgEl.textContent = "not found on HuggingFace — ";
    const a = document.createElement("a");
    a.textContent = "🌐 search the web";
    a.href = "https://www.google.com/search?q=" + encodeURIComponent(`"${name}" download`);
    a.target = "_blank";
    a.rel = "noopener";
    a.style.cssText = `color:${ER.accent};text-decoration:underline;cursor:pointer;`;
    a.addEventListener("pointerdown", (e) => e.stopPropagation());
    msgEl.appendChild(a);
    msgEl.appendChild(document.createTextNode(" or paste the URL manually"));
}

// todos los nodos del grafo, incluidos los que viven DENTRO de subgrafos
// (agrupaciones de nodos): sus modelos tambien deben detectarse
function allNodes(graph, out = [], seen = new Set()) {
    for (const n of graph?._nodes || []) {
        out.push(n);
        const sub = n.subgraph;
        if (sub && !seen.has(sub)) {
            seen.add(sub);
            allNodes(sub, out, seen);
        }
    }
    return out;
}

app.registerExtension({
    name: "comfy.ERModelDownloader",

    // al terminar de cargar un workflow, escanea automaticamente si el
    // nodo esta presente (asi al abrirlo ya ves que modelos tienes y cuales no)
    afterConfigureGraph() {
        setTimeout(() => {
            for (const n of allNodes(app.graph)) {
                if (n.type === NODE_TYPE && n.erScan) n.erScan();
            }
        }, 600);
    },

    setup() {
        // workaround de un bug del frontend: a veces queda una mascara
        // BlockUI huerfana (sin dialogo visible) cubriendo el canvas entero,
        // que se traga todos los clics (incluidos los botones de este nodo).
        // Si hay mascara pero ningun dialogo abierto, se neutraliza.
        setInterval(() => {
            const dialogOpen = [...document.querySelectorAll(".p-dialog")].some((d) => d.offsetWidth > 0);
            if (dialogOpen) return;
            for (const m of document.querySelectorAll(".p-blockui-mask.p-overlay-mask")) {
                if (m.style.pointerEvents !== "none") {
                    m.style.pointerEvents = "none";
                    console.warn("[ERModelDownloader] neutralized an orphaned BlockUI mask");
                }
            }
        }, 1500);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // logo en la barra de título
        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        // en cada redibujado, la tabla se ajusta al tamaño actual del nodo
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFitCC?.();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this); // colores de marca en titulo y cuerpo
            const node = this;
            let folders = [];
            let rows = []; // {name, folder, found, url, status, size, dlId, els:{}}
            let freeSpace = null; // espacio libre del disco de modelos

            // resumen: total de modelos, faltantes, GB a descargar y espacio
            // libre; en rojo si las descargas no caben en el disco
            const updateSummary = () => {
                const missing = rows.filter((r) => r.status !== "ok");
                let total = 0, unknown = 0;
                for (const r of missing) {
                    if (r.size) total += r.size;
                    else unknown++;
                }
                let txt = `${rows.length} models · ${missing.length} missing`;
                if (missing.length && total) txt += ` · ${fmtSize(total)}${unknown ? "+" : ""} to download`;
                if (missing.length && freeSpace) txt += ` · ${fmtSize(freeSpace)} free`;
                summary.textContent = txt;
                summary.style.color = total && freeSpace && total > freeSpace ? ER.error : "";
                if (total && freeSpace && total > freeSpace) txt += "  (not enough disk space!)";
                summary.title = txt;
            };

            // tamano remoto de un modelo faltante (para el resumen y su fila)
            const fetchSizeFor = async (row) => {
                if (!row.url || !row.url.toLowerCase().startsWith("https://")) return;
                try {
                    const r = await api.fetchApi(`/er_nodes/model_size?url=${encodeURIComponent(row.url)}`);
                    const d = await r.json();
                    if (d.size) {
                        row.size = d.size;
                        if (row.els.sz) row.els.sz.textContent = fmtSize(d.size);
                        updateSummary();
                    }
                } catch (e) { /* sin tamano: se queda como desconocido */ }
            };
            const refreshSizes = () => {
                for (const row of rows) {
                    if (row.status !== "ok" && !row.size) fetchSizeFor(row);
                }
            };

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:6px;font-family:${ER.font};font-size:11px;color:${ER.text};`;

            const topBar = document.createElement("div");
            topBar.style.cssText = "display:flex;align-items:center;gap:6px;";
            const mkBtn = (text, title) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.title = title;
                b.className = "er-btn"; // colores/borde desde la hoja ER
                b.style.cssText = "height:22px;font-size:11px;line-height:1;padding:0 10px;";
                return b;
            };
            const scanBtn = mkBtn("🔍 Scan workflow", "Find every model used by this workflow and check which ones are missing");
            const allBtn = mkBtn("⬇ Download all missing", "Download every missing model that has a URL");
            // acciones principales en cian de marca
            scanBtn.className = "er-btn-primary";
            allBtn.className = "er-btn-primary";
            allBtn.style.display = "none";
            const summary = document.createElement("span");
            summary.className = "er-dim";
            topBar.append(scanBtn, allBtn, summary);

            const table = document.createElement("div");
            // flex:0 0 auto: el contenedor flex no puede encogerla; la altura
            // real la fija updateTableHeight segun el tamano del nodo
            table.style.cssText = "display:flex;flex-direction:column;gap:4px;overflow-y:auto;flex:0 0 auto;max-height:420px;";

            root.append(topBar, table);
            const widget = node.addDOMWidget("er_models", "ER_MODELS", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // minimo; el usuario escala libremente y la tabla llena el nodo
            widget.computeSize = function (width) {
                return [width, 190];
            };
            const resize = () => {
                const min = node.computeSize();
                node.setSize([Math.max(node.size[0], 420), Math.max(node.size[1], min[1])]);
                app.graph.setDirtyCanvas(true, true);
            };

            // Ajuste con realimentacion: la tabla ocupa exactamente el hueco
            // que el nodo le da (mide el desborde real del contenido respecto
            // al borde inferior del nodo y corrige) — la barra de scroll solo
            // aparece si el nodo es demasiado pequeno para las filas
            const updateTableHeight = () => {
                const rootW = root.clientWidth || root.getBoundingClientRect().width;
                if (!rootW || !rows.length) return;
                const ds = app.canvas.ds;
                const scale = ds.scale || 1;
                const nodeBottom = (node.pos[1] + node.size[1] + ds.offset[1]) * scale;
                let mx = -Infinity;
                for (const c of root.children) {
                    if (getComputedStyle(c).display === "none") continue;
                    mx = Math.max(mx, c.getBoundingClientRect().bottom);
                }
                if (!isFinite(mx)) return;
                const delta = (mx - nodeBottom) / scale + 10;
                if (Math.abs(delta) < 3) return;
                const cur = parseFloat(table.style.height) || table.clientHeight || 200;
                const h = Math.max(80, cur - delta);
                table.style.height = `${h}px`;
                table.style.maxHeight = `${h}px`;
            };
            node._erFitCC = updateTableHeight;
            new ResizeObserver(updateTableHeight).observe(root);
            const fitTimer = setInterval(updateTableHeight, 500);
            const onRemovedFit = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemovedFit?.apply(this, arguments);
            };

            // ---------- escaneo del workflow ----------
            const guessFolder = (nodeType2, inputName) => {
                const o = TYPE_OVERRIDES[nodeType2];
                if (o && o[inputName]) return o[inputName];
                return NAME_MAP[inputName] || "checkpoints";
            };

            const collectModels = () => {
                // 1) notas markdown de los templates oficiales: URLs de cada
                //    modelo Y su carpeta (el encabezado en negrita que precede
                //    a cada grupo de enlaces: **checkpoints**, **loras**, ...)
                const noteUrls = new Map();    // basename -> url
                const noteFolders = new Map(); // basename -> carpeta de la nota
                const MD_LINK = /\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g;
                const HEADING = /^\s*(?:\*\*([^*]+)\*\*|#{1,6}\s+(.+?))\s*:?\s*$/;
                for (const n of allNodes(app.graph)) {
                    if (!/note/i.test(n.type || "")) continue;
                    for (const w of n.widgets || []) {
                        if (typeof w.value !== "string") continue;
                        let section = "";
                        for (const line of w.value.split("\n")) {
                            const h = line.match(HEADING);
                            if (h) {
                                section = (h[1] || h[2] || "").trim().toLowerCase().replace(/\s+/g, "_");
                                continue;
                            }
                            for (const m of line.matchAll(MD_LINK)) {
                                const label = m[1].trim();
                                if (MODEL_EXT.test(label)) {
                                    const base = label.split("/").pop();
                                    noteUrls.set(base, m[2]);
                                    if (section) noteFolders.set(base, section);
                                }
                            }
                        }
                    }
                }

                // 2) modelos usados por los nodos + URL si la conocemos
                const items = new Map(); // name -> {folder, url}
                for (const n of allNodes(app.graph)) {
                    if (n.type === NODE_TYPE) continue;
                    const metaModels = n.properties?.models; // workflows modernos
                    for (const w of n.widgets || []) {
                        if (typeof w.value !== "string" || !MODEL_EXT.test(w.value)) continue;
                        if (!(w.options && (w.options.values || w.type === "combo")) && w.type !== "combo") continue;
                        const name = w.value;
                        if (!items.has(name)) {
                            const base = name.split("/").pop();
                            let url = "";
                            if (Array.isArray(metaModels)) {
                                const m = metaModels.find((m) => m.name === base || m.name === name);
                                if (m?.url) url = m.url;
                            }
                            if (!url && noteUrls.has(base)) url = noteUrls.get(base);
                            items.set(name, {
                                folder: guessFolder(n.type, w.name),
                                noteFolder: noteFolders.get(base) || "",
                                url,
                            });
                        }
                    }
                }
                return items;
            };

            const doScan = async () => {
                node._erScanned = true;
                summary.textContent = "scanning...";
                const items = collectModels();
                if (!items.size) {
                    rows = [];
                    table.innerHTML = "";
                    summary.textContent = "no model files found in this workflow";
                    resize();
                    return;
                }
                let resp;
                try {
                    resp = await api.fetchApi("/er_nodes/models_check", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ items: [...items.keys()].map((name) => ({ name })) }),
                    });
                } catch (e) {
                    summary.textContent = "server error";
                    return;
                }
                const data = await resp.json();
                folders = data.folders || []; // [{name, path}]
                freeSpace = data.free_space || null;
                const validFolders = new Set((data.folders || []).map((f) => f.name));
                rows = data.items.map((r) => {
                    const it = items.get(r.name) || {};
                    // prioridad de carpeta: donde ya existe > la que dice la
                    // nota del workflow (Model Storage Location) > heurística
                    let folder = r.found || (validFolders.has(it.noteFolder) ? it.noteFolder : "") || it.folder || "checkpoints";
                    return {
                        name: r.name,
                        found: r.found,
                        path: r.path || "",
                        folder,
                        url: it.url || "",
                        status: r.found ? "ok" : "missing",
                        size: null,
                        dlId: null,
                        els: {},
                    };
                });
                buildTable();
                updateSummary();
                refreshSizes();
                allBtn.style.display = rows.some((r) => r.status !== "ok") ? "" : "none";
                // altura por defecto comoda tras escanear (tope 640px); a
                // partir de aqui el usuario escala libre y la tabla le sigue
                const wy = widget.y || 40;
                const rowH = rows.some((r) => r.status !== "ok") ? 96 : 44;
                const want = Math.min(wy + 44 + rows.length * rowH + 20, 640);
                node.setSize([Math.max(node.size[0], 420), Math.max(node.size[1], want)]);
                updateTableHeight();
                app.graph.setDirtyCanvas(true, true);
            };
            scanBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                doScan();
            });
            node.erScan = doScan;

            // auto-escaneo al añadir el nodo (o poco despues de cargar un
            // workflow que lo contiene; afterConfigureGraph lo re-lanza con
            // los valores definitivos)
            setTimeout(() => {
                if (!node._erScanned && node.graph) doScan();
            }, 1200);

            // ---------- tabla ----------
            const buildTable = () => {
                table.innerHTML = "";
                for (const row of rows) {
                    const box = document.createElement("div");
                    // fondo #171717 con tinte verde (instalado) o rojo (falta)
                    box.style.cssText =
                        "display:flex;flex-direction:column;gap:3px;padding:5px 7px;border-radius:6px;" +
                        `background:${row.status === "ok" ? "#14251b" : "#2a1717"};`;

                    const line1 = document.createElement("div");
                    line1.style.cssText = "display:flex;align-items:center;gap:6px;";
                    const stat = document.createElement("span");
                    stat.textContent = row.status === "ok" ? "✅" : "❌";
                    const nm = document.createElement("span");
                    nm.textContent = row.name;
                    nm.title = row.name;
                    nm.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${ER.text};`;
                    // tamano del archivo remoto (cuando se conoce)
                    const sz = document.createElement("span");
                    sz.className = "er-dim";
                    sz.style.cssText = "font-size:10px;white-space:nowrap;";
                    sz.textContent = row.size ? fmtSize(row.size) : "";
                    const fold = document.createElement("select");
                    fold.className = "er-select";
                    fold.style.cssText = "font-size:10px;max-width:130px;padding:1px 5px;";
                    for (const f of folders) {
                        const o = document.createElement("option");
                        o.value = o.textContent = f.name;
                        fold.appendChild(o);
                    }
                    fold.value = row.folder;
                    fold.disabled = row.status === "ok";
                    fold.addEventListener("pointerdown", (e) => e.stopPropagation());
                    line1.append(stat, nm, sz, fold);
                    box.appendChild(line1);
                    row.els = { stat, box, sz };

                    // ruta completa en disco, SIEMPRE visible (clic para copiar)
                    const dest = document.createElement("div");
                    dest.className = "er-dim";
                    dest.style.cssText =
                        "font-size:10px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;" +
                        "white-space:nowrap;cursor:copy;";
                    const folderPath = (name) => (folders.find((f) => f.name === name)?.path || "models/" + name);
                    const sep = (p) => (p.includes("\\") ? "\\" : "/");
                    const updateDest = () => {
                        const root = row.destRoot || folderPath(row.folder);
                        const full = row.path || (root + sep(root) + row.name);
                        dest.textContent = "→ " + full;
                        dest.title = full + "  (click to copy)";
                        dest._full = full;
                    };
                    // selector de ruta de destino cuando la categoria tiene
                    // varias registradas (carpeta local + carpeta compartida
                    // de extra_model_paths.yaml, setups multi-ComfyUI...)
                    const destSel = document.createElement("select");
                    destSel.className = "er-select";
                    destSel.style.cssText = "font-size:9px;padding:1px 4px;max-width:100%;display:none;";
                    destSel.title = "Where to download this model (this category has several registered folders)";
                    destSel.addEventListener("pointerdown", (e) => e.stopPropagation());
                    const fillDestSel = () => {
                        const info = folders.find((f) => f.name === row.folder);
                        const paths = info?.paths || [];
                        destSel.innerHTML = "";
                        if (row.status === "ok" || paths.length < 2) {
                            destSel.style.display = "none";
                            row.destRoot = null;
                            return;
                        }
                        for (const p of paths) {
                            const o = document.createElement("option");
                            o.value = p;
                            const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
                            o.textContent = "📁 …" + sep(p) + parts.slice(-2).join(sep(p));
                            o.title = p;
                            destSel.appendChild(o);
                        }
                        const def = info?.path || paths[0];
                        destSel.value = row.destRoot && [...destSel.options].some((o) => o.value === row.destRoot)
                            ? row.destRoot : def;
                        row.destRoot = destSel.value;
                        destSel.style.display = "";
                    };
                    destSel.addEventListener("change", () => {
                        row.destRoot = destSel.value;
                        updateDest();
                    });
                    box.appendChild(destSel);
                    fillDestSel();
                    updateDest();
                    dest.addEventListener("pointerdown", (e) => e.stopPropagation());
                    dest.addEventListener("click", async (e) => {
                        e.stopPropagation();
                        try {
                            await navigator.clipboard.writeText(dest._full);
                            const prev = dest.textContent;
                            dest.textContent = "✔ copied: " + dest._full;
                            setTimeout(() => (dest.textContent = prev), 1200);
                        } catch (err) {}
                    });
                    box.appendChild(dest);
                    row.els.dest = dest;

                    if (row.status !== "ok") {
                        fold.addEventListener("change", () => {
                            row.folder = fold.value;
                            row.destRoot = null; // la nueva categoria decide su destino
                            fillDestSel();
                            updateDest();
                        });

                        const line2 = document.createElement("div");
                        line2.style.cssText = "display:flex;align-items:center;gap:5px;";
                        const url = document.createElement("input");
                        url.type = "text";
                        url.placeholder = "https:// model URL (or use 🔎 HF)";
                        url.value = row.url;
                        url.className = "er-input"; // foco en cian via hoja ER
                        url.style.cssText = "flex:1;font-size:10px;padding:2px 5px;";
                        url.addEventListener("input", () => (row.url = url.value.trim()));
                        // al pegar una URL, consulta su tamano para el resumen
                        url.addEventListener("change", () => {
                            row.size = null;
                            fetchSizeFor(row);
                        });
                        url.addEventListener("pointerdown", (e) => e.stopPropagation());
                        url.addEventListener("keydown", (e) => e.stopPropagation());
                        const hfBtn = mkBtn("🔎 HF", "Search this file on HuggingFace");
                        const dlBtn = mkBtn("⬇", "Download to the selected folder");
                        line2.append(url, hfBtn, dlBtn);
                        const prog = document.createElement("div");
                        prog.style.cssText = `height:5px;border-radius:3px;background:${ER.inset};overflow:hidden;display:none;`;
                        const bar = document.createElement("div");
                        bar.style.cssText = `height:100%;width:0%;background:${ER.accent};transition:width .3s;`;
                        prog.appendChild(bar);
                        const msg = document.createElement("div");
                        msg.style.cssText = `color:${ER.warn};font-size:10px;display:none;`;
                        box.append(line2, prog, msg);
                        Object.assign(row.els, { url, hfBtn, dlBtn, prog, bar, msg });

                        hfBtn.addEventListener("click", async (e) => {
                            e.stopPropagation();
                            hfBtn.textContent = "…";
                            try {
                                const r = await api.fetchApi(`/er_nodes/model_search?name=${encodeURIComponent(row.name)}`);
                                const d = await r.json();
                                if (d.results?.length) {
                                    row.url = d.results[0].url;
                                    url.value = row.url;
                                    if (d.results[0].size) {
                                        row.size = d.results[0].size;
                                        sz.textContent = fmtSize(row.size);
                                        updateSummary();
                                    }
                                    msg.style.display = "block";
                                    msg.style.color = ER.ok;
                                    msg.textContent = `found in ${d.results[0].repo} (${fmtSize(d.results[0].size)})` +
                                        (d.results.length > 1 ? ` · +${d.results.length - 1} more repos` : "");
                                } else {
                                    msg.style.display = "block";
                                    msg.style.color = ER.warn;
                                    showWebSearch(msg, row.name);
                                }
                            } catch (err) {
                                msg.style.display = "block";
                                msg.textContent = "search failed: " + err;
                            }
                            hfBtn.textContent = "🔎 HF";
                        });

                        dlBtn.addEventListener("click", (e) => {
                            e.stopPropagation();
                            startDownload(row);
                        });
                    }
                    table.appendChild(box);
                }
            };

            // ---------- descargas ----------
            const startDownload = async (row) => {
                if (row.dlId) return;
                // respuesta visual inmediata al pulsar la flecha
                if (row.els.dlBtn) row.els.dlBtn.textContent = "⏳";
                const restore = () => {
                    if (row.els.dlBtn && !row.dlId) row.els.dlBtn.textContent = "⬇";
                };
                if (!row.url || !row.url.toLowerCase().startsWith("https://")) {
                    // sin URL: intenta resolverla sola en HuggingFace
                    row.els.msg.style.display = "block";
                    row.els.msg.style.color = ER.accent;
                    row.els.msg.textContent = "no URL - searching HuggingFace...";
                    try {
                        const r = await api.fetchApi(`/er_nodes/model_search?name=${encodeURIComponent(row.name)}`);
                        const d = await r.json();
                        if (d.results?.length) {
                            row.url = d.results[0].url;
                            if (row.els.url) row.els.url.value = row.url;
                            row.els.msg.textContent = `found in ${d.results[0].repo} - downloading...`;
                        } else {
                            row.els.msg.style.color = ER.warn;
                            showWebSearch(row.els.msg, row.name);
                            restore();
                            return;
                        }
                    } catch (e) {
                        row.els.msg.style.color = ER.warn;
                        row.els.msg.textContent = "search failed - paste a https:// URL manually";
                        restore();
                        return;
                    }
                }
                try {
                    const r = await api.fetchApi("/er_nodes/model_download", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ url: row.url, folder: row.folder, name: row.name, dest_root: row.destRoot || "" }),
                    });
                    const d = await r.json();
                    if (!r.ok) {
                        row.els.msg.style.display = "block";
                        row.els.msg.style.color = ER.error;
                        row.els.msg.textContent = d.error || "download failed";
                        restore();
                        return;
                    }
                    row.dlId = d.id;
                    row.els.prog.style.display = "block";
                    row.els.msg.style.display = "none";
                    row.els.dlBtn.disabled = true;
                    pollDownload(row);
                } catch (e) {
                    row.els.msg.style.display = "block";
                    row.els.msg.textContent = String(e);
                    restore();
                }
            };

            const pollDownload = async (row) => {
                if (!row.dlId) return;
                try {
                    const r = await api.fetchApi(`/er_nodes/model_progress?id=${row.dlId}`);
                    const d = await r.json();
                    if (d.error) {
                        row.els.msg.style.display = "block";
                        row.els.msg.style.color = ER.error;
                        row.els.msg.textContent = "error: " + d.error +
                            (String(d.error).includes("401") || String(d.error).includes("403")
                                ? " (gated model? set the HF_TOKEN environment variable or download manually)" : "");
                        row.els.prog.style.display = "none";
                        row.els.dlBtn.disabled = false;
                        row.els.dlBtn.textContent = "⬇";
                        row.dlId = null;
                        return;
                    }
                    if (d.done) {
                        row.status = "ok";
                        row.els.stat.textContent = "✅";
                        row.els.box.style.background = "#14251b"; // tinte verde = instalado
                        row.els.prog.style.display = "none";
                        row.els.msg.style.display = "block";
                        row.els.msg.style.color = ER.ok;
                        row.els.msg.textContent = "downloaded ✔ → " + (d.path || "") + " (refresh combos with R)";
                        row.els.msg.title = d.path || "";
                        if (d.path && row.els.dest) {
                            row.path = d.path;
                            row.els.dest.textContent = "→ " + d.path;
                            row.els.dest.title = d.path + "  (click to copy)";
                            row.els.dest._full = d.path;
                        }
                        const missing = rows.filter((x) => x.status !== "ok").length;
                        summary.textContent = `${rows.length} models · ${missing} missing`;
                        if (!missing) allBtn.style.display = "none";
                        row.dlId = null;
                        return;
                    }
                    const pct = d.total ? Math.round((d.read / d.total) * 100) : 0;
                    row.els.bar.style.width = pct + "%";
                    row.els.msg.style.display = "block";
                    row.els.msg.style.color = ER.accent;
                    row.els.msg.textContent = d.total
                        ? `${pct}% · ${fmtSize(d.read)} / ${fmtSize(d.total)}`
                        : `${fmtSize(d.read)}...`;
                    setTimeout(() => pollDownload(row), 700);
                } catch (e) {
                    setTimeout(() => pollDownload(row), 1500);
                }
            };

            allBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                for (const row of rows) {
                    if (row.status !== "ok" && row.url && !row.dlId) startDownload(row);
                }
            });

            resize();
        };
    },
});
