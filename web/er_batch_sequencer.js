import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

// estilos extra propios de este pack (hover rojo en botones de borrado)
if (!document.getElementById("er-batch-sequencer-style")) {
    const s = document.createElement("style");
    s.id = "er-batch-sequencer-style";
    s.textContent = `
.er-bs-danger:hover { border-color: ${ER.error} !important; color: ${ER.error} !important; }
`;
    document.head.appendChild(s);
}

// dos sequencers (entrada IMAGE y entrada VIDEO) comparten la misma UI
const SEQ_TYPES = new Set(["ERBatchSequencer", "ERBatchSequencerVideo"]);
// dos variantes de preview: una para imagenes y otra para videos
const PREVIEW_KINDS = { ERWedgePreview: "image", ERWedgePreviewVideo: "video" };
const MAX_RUNS = 64;
// amarillo oscuro para las etiquetas superpuestas: legible sin cansar la vista
const LABEL_YELLOW = "#e5c04b";

const logo = new Image();
logo.src = new URL("./logo.png", import.meta.url).href;
logo.onload = () => app.graph?.setDirtyCanvas(true, true);

function viewURL(file) {
    return api.apiURL(
        "/view?" +
            new URLSearchParams({
                filename: file.filename,
                subfolder: file.subfolder || "",
                type: file.type || "temp",
                rand: Math.random(),
            })
    );
}

// "7,7.5,8" | "1:10:2" (inicio:fin:paso) | "rand5" (N aleatorios) | "42"
function expandValues(expr) {
    const s = String(expr || "").trim();
    if (!s) return [];
    const rnd = s.match(/^rand\s*(\d+)$/i);
    if (rnd) {
        const n = Math.min(parseInt(rnd[1], 10) || 0, MAX_RUNS);
        return Array.from({ length: n }, () => Math.floor(Math.random() * 0xffffffffff));
    }
    if (s.includes(":")) {
        const [a, b, st] = s.split(":").map(Number);
        const step = st || 1;
        if (!isFinite(a) || !isFinite(b) || !isFinite(step) || step === 0) return [];
        const out = [];
        for (let v = a; step > 0 ? v <= b + 1e-9 : v >= b - 1e-9; v += step) {
            out.push(Math.round(v * 1e6) / 1e6);
            if (out.length >= MAX_RUNS) break;
        }
        return out;
    }
    return s.split(",").map((x) => x.trim()).filter((x) => x !== "").map((x) => {
        const n = Number(x);
        return isFinite(n) ? n : x;
    });
}

// ---------- media compartido (celdas y contact sheet) ----------

// crea el <img>/<video> de un resultado a su aspecto nativo
function mkMedia(entry) {
    let media;
    if (entry.kind === "video") {
        media = document.createElement("video");
        media.muted = true;
        media.loop = true;
        media.autoplay = true;
        media.playsInline = true;
    } else {
        media = document.createElement("img");
    }
    media.src = viewURL(entry.item);
    // aspecto nativo: la altura exacta la asigna autoLayoutGrid en pixeles
    media.style.cssText =
        `width:100%;height:auto;display:block;object-fit:contain;cursor:zoom-in;background:${ER.inset};`;
    media.title = "click: open full size";
    media.addEventListener("pointerdown", (e) => e.stopPropagation());
    media.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(media.src.replace(/&rand=[^&]*/, ""), "_blank");
    });
    return media;
}

// Maquetacion manual por JS: dentro de los widgets DOM de ComfyUI el reflow
// del grid CSS no es fiable (las filas no se recalculan al cargar las
// imagenes y las celdas acaban solapadas). Colocamos cada celda con posicion
// absoluta y alturas en pixeles: el solape es imposible por construccion.
// Ademas el layout es "fit": se elige el numero de columnas para que TODOS
// los resultados quepan a la vez en el area visible — el tamano del nodo
// decide el tamano de las imagenes. Solo si el nodo es minusculo (celdas por
// debajo de MIN_CELL px) se permite scroll.
const MIN_CELL = 96;

function cellAspect(c) {
    return Number(c.dataset.aspect) || 1.5; // provisional hasta que cargue
}

// altura total del listado con k columnas de ancho cw
function rowsHeight(cells, k, cw, gap) {
    let h = 0;
    for (let i = 0; i < cells.length; i += k) {
        const row = cells.slice(i, i + k);
        h += Math.max(...row.map((c) => Math.round(cw / cellAspect(c)))) + gap;
    }
    return Math.max(0, h - gap);
}

// coloca las celdas en absoluto (fila a fila) y devuelve la altura usada
function placeCells(cells, k, cw, gap) {
    let y = 0;
    for (let i = 0; i < cells.length; i += k) {
        const row = cells.slice(i, i + k);
        const hs = row.map((c) => Math.round(cw / cellAspect(c)));
        row.forEach((c, j) => {
            c.style.position = "absolute";
            c.style.width = `${cw}px`;
            c.style.left = `${j * (cw + gap)}px`;
            c.style.top = `${y}px`;
            const media = c.firstChild;
            if (media) media.style.height = `${hs[j]}px`;
        });
        y += Math.max(...hs) + gap;
    }
    return Math.max(0, y - gap);
}

// numero de columnas: el menor k (celdas mas grandes) cuyo total cabe en H
function pickCols(cells, W, H, gap) {
    for (let k = 1; k <= cells.length; k++) {
        const cw = (W - (k - 1) * gap) / k;
        if (cw < MIN_CELL) break;
        if (rowsHeight(cells, k, cw, gap) <= H - 2) return k;
    }
    // no cabe ni con celdas minimas: maximo de columnas y scroll
    return Math.max(1, Math.min(Math.max(cells.length, 1), Math.floor((W + gap) / (MIN_CELL + gap))));
}

// contenedor de un solo listado (rejilla del sequencer)
function erFitCells(container, gap) {
    container.style.display = "block";
    container.style.position = "relative";
    // espaciador en flujo normal: da al contenedor su altura de scroll
    const spacer = document.createElement("div");
    spacer.style.cssText = "width:1px;visibility:hidden;pointer-events:none;";
    container.appendChild(spacer);
    const layout = () => {
        const W = container.clientWidth;
        const H = container.clientHeight;
        if (!W) return;
        if (spacer.parentElement !== container) container.appendChild(spacer); // sobrevive a innerHTML=""
        // solo las celdas de resultado (ignora espaciador y mensajes)
        const cells = [...container.children].filter((c) => c.classList?.contains("er-wcell"));
        if (!cells.length) {
            spacer.style.height = "0px";
            return;
        }
        const k = pickCols(cells, W, H, gap);
        const cw = (W - (k - 1) * gap) / k;
        spacer.style.height = `${placeCells(cells, k, cw, gap)}px`;
    };
    new ResizeObserver(layout).observe(container);
    container._erLayout = layout;
    return layout;
}

// celda con la etiqueta superpuesta en amarillo oscuro sobre la imagen
function mkResultCell(entry, fontSize = 10.5) {
    const cell = document.createElement("div");
    cell.className = "er-wcell"; // marca para el layout fit
    cell.style.cssText =
        `position:relative;background:${ER.inset};border:1px solid ${ER.border};` +
        `border-radius:5px;overflow:hidden;align-self:start;`;
    const media = mkMedia(entry);
    // en cuanto se conoce el tamano real, la celda reserva su aspecto exacto
    const onDim = () => {
        const w = media.naturalWidth || media.videoWidth;
        const h = media.naturalHeight || media.videoHeight;
        if (w && h) {
            cell.dataset.aspect = w / h;
            cell.parentElement?._erLayout?.();
        }
    };
    media.addEventListener("load", onDim);
    media.addEventListener("loadeddata", onDim);
    cell.appendChild(media);
    const cap = document.createElement("div");
    cap.style.cssText =
        `position:absolute;left:0;right:0;bottom:0;padding:3px 7px;` +
        `font-size:${fontSize}px;line-height:1.3;color:${LABEL_YELLOW};` +
        `text-shadow:0 1px 2px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.8);` +
        `background:linear-gradient(transparent,rgba(0,0,0,.45));pointer-events:none;`;
    cap.textContent = entry.label;
    cap.title = entry.label;
    cell.appendChild(cap);
    return cell;
}

// carga un resultado como elemento dibujable en canvas (frame 0 si es video)
function loadDrawable(entry) {
    return new Promise((resolve) => {
        const done = (el, w, h) => resolve(w && h ? { el, w, h, label: entry.label } : null);
        const t = setTimeout(() => resolve(null), 10000);
        if (entry.kind === "video") {
            const v = document.createElement("video");
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.addEventListener("loadeddata", () => {
                clearTimeout(t);
                done(v, v.videoWidth, v.videoHeight);
            });
            v.addEventListener("error", () => { clearTimeout(t); resolve(null); });
            v.src = viewURL(entry.item);
        } else {
            const im = new Image();
            im.onload = () => { clearTimeout(t); done(im, im.naturalWidth, im.naturalHeight); };
            im.onerror = () => { clearTimeout(t); resolve(null); };
            im.src = viewURL(entry.item);
        }
    });
}

// compone una unica imagen (contact sheet) con TODOS los resultados
async function buildContactSheet(entries, title, subtitle) {
    const media = (await Promise.all(entries.map(loadDrawable))).filter(Boolean);
    if (!media.length) return null;
    const n = media.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const TW = 512;
    const aspects = media.map((m) => m.w / m.h).sort((a, b) => a - b);
    const medAspect = aspects[Math.floor(aspects.length / 2)] || 1;
    const TH = Math.max(96, Math.round(TW / medAspect));
    const PAD = 18, GAP = 12, HEADER = 58;

    const canvas = document.createElement("canvas");
    canvas.width = PAD * 2 + cols * TW + (cols - 1) * GAP;
    canvas.height = HEADER + rows * (TH + GAP) - GAP + PAD + HEADER / 2;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#141414";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // cabecera: titulo personalizado (o marca por defecto) + datos a la derecha
    ctx.fillStyle = ER.accent;
    ctx.font = "700 22px 'Trebuchet MS', 'Segoe UI', sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(title || "ER WEDGES", PAD, HEADER / 2 + 3, canvas.width * 0.62);
    ctx.fillStyle = ER.textDim;
    ctx.font = "13px 'Trebuchet MS', 'Segoe UI', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(subtitle, canvas.width - PAD, HEADER / 2 + 4, canvas.width * 0.34);
    ctx.textAlign = "left";

    media.forEach((m, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        const x = PAD + c * (TW + GAP);
        const y = HEADER + r * (TH + GAP);
        ctx.fillStyle = "#171717";
        ctx.fillRect(x, y, TW, TH);
        const s = Math.min(TW / m.w, TH / m.h);
        const dw = m.w * s, dh = m.h * s;
        ctx.drawImage(m.el, x + (TW - dw) / 2, y + (TH - dh) / 2, dw, dh);
        ctx.strokeStyle = ER.border;
        ctx.strokeRect(x + 0.5, y + 0.5, TW - 1, TH - 1);
        // etiqueta en amarillo oscuro con sombra, superpuesta abajo
        ctx.save();
        ctx.font = "600 14px 'Trebuchet MS', 'Segoe UI', sans-serif";
        ctx.shadowColor = "rgba(0,0,0,.95)";
        ctx.shadowBlur = 5;
        ctx.shadowOffsetY = 1;
        ctx.fillStyle = LABEL_YELLOW;
        ctx.fillText(m.label, x + 8, y + TH - 13, TW - 16);
        ctx.restore();
    });
    return canvas;
}

function sheetFilename(title, ext = "png") {
    const d = new Date();
    const pad2 = (x) => String(x).padStart(2, "0");
    const slug = (title || "er_wedges")
        .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "er_wedges";
    return `${slug}_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}.${ext}`;
}

function downloadSheet(canvas, title) {
    canvas.toBlob((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = sheetFilename(title);
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, "image/png");
}

// exporta la hoja: con carpeta -> la guarda el servidor en esa ruta;
// sin carpeta -> descarga del navegador. Devuelve {ok, path?, error?} o null.
// Si TODOS los resultados son videos, la hoja es un .mp4 real (rejilla de
// videos reproduciendose a la vez) compuesto por el servidor.
async function exportSheet(entries, title, dir) {
    if (!entries.length) return null;
    const d = new Date();
    const subtitle = `ER Tools · ${entries.length} results · ${d.toLocaleDateString()}`;
    const allVideo = entries.every((e) => (e.kind || "image") === "video");
    if (allVideo) {
        try {
            const r = await api.fetchApi("/er_wedge/save_sheet_video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    dir, title, subtitle,
                    filename: sheetFilename(title, "mp4"),
                    // usa la version HD si el run la genero (resolucion 1080p)
                    items: entries.map((e) => ({ ...e.item, filename: e.item.hd || e.item.filename, label: e.label })),
                }),
            });
            const j = await r.json();
            if (!r.ok || j.error) return { ok: false, error: j.error || `HTTP ${r.status}` };
            if (j.path) return { ok: true, path: j.path };
            // sin carpeta: descarga desde el temp del servidor
            const a = document.createElement("a");
            a.href = viewURL(j);
            a.download = j.filename;
            a.click();
            return { ok: true, path: null };
        } catch (e) {
            return { ok: false, error: String(e) };
        }
    }
    const canvas = await buildContactSheet(entries, title, subtitle);
    if (!canvas) return null;
    if (!dir) {
        downloadSheet(canvas, title);
        return { ok: true, path: null };
    }
    try {
        const r = await api.fetchApi("/er_wedge/save_sheet", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dir, filename: sheetFilename(title), data: canvas.toDataURL("image/png") }),
        });
        const j = await r.json();
        if (!r.ok || j.error) return { ok: false, error: j.error || `HTTP ${r.status}` };
        return { ok: true, path: j.path };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

app.registerExtension({
    name: "comfy.ERBatchSequencer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!SEQ_TYPES.has(nodeData.name) && !(nodeData.name in PREVIEW_KINDS)) return;

        // logo en la barra de título
        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        // en cada redibujado, la rejilla se ajusta al tamaño actual del nodo
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFitGrid?.();
        };

        // click derecho: exportar una imagen unica con todos los resultados
        const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
            getExtraMenuOptions?.apply(this, arguments);
            options.unshift(
                {
                    content: "🖼 Save contact sheet (all results)",
                    callback: () => this.erExportSheet?.(),
                },
                null
            );
        };

        if (nodeData.name in PREVIEW_KINDS) {
            setupPreviewNode(nodeType, PREVIEW_KINDS[nodeData.name]);
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this);
            const node = this;
            let batches = [];     // {params:[{nodeId,widgetName,expr,els}], els}
            let pendingRuns = []; // {batchIdx, params:[{label,value}]}
            let results = [];     // {item, kind, batchIdx, params, label}
            let running = false;

            // widget oculto: lleva los atributos del wedge dentro del prompt
            // para que el resultado vuelva etiquetado (robusto ante recargas)
            const metaW = node.widgets.find((w) => w.name === "er_meta");
            if (metaW) {
                metaW.type = "hidden";
                metaW.hidden = true;
                metaW.computeSize = () => [0, -4];
            }

            node.properties = node.properties || {};

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:6px;font-family:${ER.font};font-size:11px;color:${ER.text};`;

            const mkBtn = (text, title) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.title = title || "";
                b.className = "er-btn";
                // solo dimensiones en linea; el color lo pone la clase
                b.style.cssText = "height:22px;font-size:11px;line-height:1;padding:0 10px;";
                return b;
            };

            const topBar = document.createElement("div");
            topBar.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
            const addBatchBtn = mkBtn("＋ Wedge", "Add a wedge: one run (or several) with its own parameter values");
            const runBtn = mkBtn("▶ Run wedges", "Run every wedge in order");
            runBtn.className = "er-btn-primary"; // accion principal en cian
            const clearBtn = mkBtn("🗑", "Clear results");
            const status = document.createElement("span");
            status.style.cssText = `color:${ER.textDim};`;
            topBar.append(addBatchBtn, runBtn, clearBtn, status);

            const batchesBox = document.createElement("div");
            batchesBox.style.cssText = "display:flex;flex-direction:column;gap:6px;";

            const grid = document.createElement("div");
            // flex:0 0 auto: el contenedor flex no puede encoger la rejilla
            grid.style.cssText = "overflow-y:auto;max-height:540px;min-height:140px;flex:0 0 auto;";
            grid.dataset.erSelf = "1"; // autoajustable: el fitter generico la excluye
            erFitCells(grid, 7);

            root.append(topBar, batchesBox, grid);
            const widget = node.addDOMWidget("er_batch_ui", "ER_BATCH", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima: cabecera + filas de wedges + un poco de rejilla;
            // el usuario escala libremente y la rejilla ocupa el espacio extra
            widget.computeSize = function (width) {
                let batchesH = 0;
                for (const b of batches) batchesH += 30 + b.params.length * 30 + 26;
                return [width, 34 + batchesH + 180];
            };
            const resize = () => {
                const min = node.computeSize();
                node.setSize([
                    Math.max(node.size[0], 380),
                    Math.max(node.size[1], min[1]),
                ]);
                app.graph.setDirtyCanvas(true, true);
            };
            // la rejilla llena el espacio que el usuario de al nodo
            node._erFitGrid = () => {
                const wy = widget.y || 0;
                const avail = node.size[1] - wy - grid.offsetTop - 14;
                const h = Math.max(140, avail);
                const hpx = `${h}px`;
                if (grid.style.height !== hpx) {
                    grid.style.height = hpx;
                    grid.style.maxHeight = hpx;
                }
            };
            // ademas del redibujado del canvas, un tick ligero de respaldo
            const fitTimer = setInterval(() => node._erFitGrid(), 500);
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemoved?.apply(this, arguments);
            };

            // ---------- helpers de nodos ----------
            const graphNodes = () =>
                (app.graph._nodes || []).filter((n) => n !== node && (n.widgets || []).length);
            const SAMPLER_WIDGETS = ["seed", "noise_seed", "cfg", "steps", "denoise", "sampler_name"];
            const isSamplerish = (n) => (n.widgets || []).some((w) => SAMPLER_WIDGETS.includes(w.name));
            const upstreamIds = () => {
                const seen = new Set();
                const getLink = (id) => (app.graph.links?.get ? app.graph.links.get(id) : app.graph.links?.[id]);
                const stack = [node];
                while (stack.length) {
                    const n = stack.pop();
                    for (const inp of n.inputs || []) {
                        if (inp.link == null) continue;
                        const link = getLink(inp.link);
                        if (!link) continue;
                        const src = app.graph.getNodeById(link.origin_id);
                        if (src && !seen.has(src.id)) {
                            seen.add(src.id);
                            stack.push(src);
                        }
                    }
                }
                return seen;
            };
            const groupedNodes = () => {
                const up = upstreamIds();
                const all = graphNodes();
                return {
                    samplers: all.filter((n) => up.has(n.id) && isSamplerish(n)),
                    upstream: all.filter((n) => up.has(n.id) && !isSamplerish(n)),
                    others: all.filter((n) => !up.has(n.id)),
                };
            };

            // ---------- configuracion persistente ----------
            const saveConfig = () => {
                node.properties.er_batch_groups = batches.map((b) => ({
                    params: b.params.map((p) => ({ nodeId: p.nodeId, widgetName: p.widgetName, expr: p.expr })),
                }));
            };
            // los resultados tambien se guardan para sobrevivir recargas y
            // para que ER Wedge Preview pueda mostrarlos
            const saveResults = () => {
                node.properties.er_wedge_results = results.map((r) => ({
                    item: r.item, kind: r.kind, batchIdx: r.batchIdx, params: r.params, label: r.label,
                }));
            };
            const clearResults = () => {
                results = [];
                grid.innerHTML = "";
                pendingRuns = [];
                saveResults();
            };

            // ---------- filas de parametros ----------
            const addParamRow = (batch, saved) => {
                const row = { nodeId: saved?.nodeId ?? null, widgetName: saved?.widgetName ?? "", expr: saved?.expr ?? "", els: {} };
                const line = document.createElement("div");
                line.style.cssText = "display:flex;align-items:center;gap:5px;";

                const nodeSel = document.createElement("select");
                nodeSel.className = "er-select";
                nodeSel.style.cssText = "font-size:10px;max-width:150px;padding:2px 5px;";
                const widgetSel = document.createElement("select");
                widgetSel.className = "er-select";
                widgetSel.style.cssText = nodeSel.style.cssText;
                const values = document.createElement("input");
                values.type = "text";
                values.placeholder = "values  |  7,7.5,8  |  rand3";
                values.value = row.expr;
                values.className = "er-input";
                values.style.cssText = "flex:1;font-size:10px;padding:2px 5px;min-width:50px;";
                const del = mkBtn("✕", "Remove this parameter");
                del.classList.add("er-bs-danger");
                del.style.height = "20px";

                const fillNodes = () => {
                    nodeSel.innerHTML = "";
                    const g = groupedNodes();
                    const addGroup = (label, nodes) => {
                        if (!nodes.length) return;
                        const og = document.createElement("optgroup");
                        og.label = label;
                        for (const n of nodes) {
                            const o = document.createElement("option");
                            o.value = String(n.id);
                            o.textContent = `${n.title || n.type} #${n.id}`;
                            og.appendChild(o);
                        }
                        nodeSel.appendChild(og);
                    };
                    addGroup("★ samplers (upstream)", g.samplers);
                    addGroup("upstream", g.upstream);
                    addGroup("other nodes", g.others);
                    if (row.nodeId != null && [...nodeSel.options].some((o) => o.value === String(row.nodeId))) {
                        nodeSel.value = String(row.nodeId);
                    } else if (g.samplers.length) {
                        nodeSel.value = String(g.samplers[0].id);
                    }
                    row.nodeId = Number(nodeSel.value);
                };
                const fillWidgets = () => {
                    widgetSel.innerHTML = "";
                    const n = app.graph.getNodeById(row.nodeId);
                    for (const w of n?.widgets || []) {
                        if (w.name === "er_batch_ui") continue;
                        const o = document.createElement("option");
                        o.value = o.textContent = w.name;
                        widgetSel.appendChild(o);
                    }
                    const names = [...widgetSel.options].map((o) => o.value);
                    if (row.widgetName && names.includes(row.widgetName)) {
                        widgetSel.value = row.widgetName;
                    } else {
                        const seed = names.find((x) => x === "seed" || x === "noise_seed");
                        if (seed) widgetSel.value = seed;
                    }
                    row.widgetName = widgetSel.value;
                };
                fillNodes();
                fillWidgets();

                nodeSel.addEventListener("change", () => {
                    row.nodeId = Number(nodeSel.value);
                    fillWidgets();
                    saveConfig();
                });
                widgetSel.addEventListener("change", () => {
                    row.widgetName = widgetSel.value;
                    saveConfig();
                });
                values.addEventListener("input", () => {
                    row.expr = values.value;
                    saveConfig();
                });
                del.addEventListener("click", (e) => {
                    e.stopPropagation();
                    batch.params = batch.params.filter((r) => r !== row);
                    line.remove();
                    saveConfig();
                    resize();
                });
                for (const el of [nodeSel, widgetSel, values, del]) {
                    el.addEventListener("pointerdown", (e) => e.stopPropagation());
                    el.addEventListener("keydown", (e) => e.stopPropagation());
                }

                line.append(nodeSel, widgetSel, values, del);
                batch.els.paramsBox.appendChild(line);
                row.els = { line };
                batch.params.push(row);
                resize();
                return row;
            };

            // ---------- wedges ----------
            const renumber = () => {
                batches.forEach((b, i) => (b.els.title.textContent = `Wedge ${i + 1}`));
            };

            const addBatch = (saved) => {
                const batch = { params: [], els: {} };
                const box = document.createElement("div");
                box.className = "er-panel";
                box.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:5px 7px;";
                const head = document.createElement("div");
                head.style.cssText = "display:flex;align-items:center;gap:6px;";
                const title = document.createElement("span");
                title.className = "er-title";
                const addP = mkBtn("＋ param", "Add a parameter to this wedge");
                addP.style.height = "20px";
                const dup = mkBtn("⧉", "Duplicate this wedge");
                dup.style.height = "20px";
                const delB = mkBtn("✕", "Remove this wedge");
                delB.classList.add("er-bs-danger");
                delB.style.height = "20px";
                head.append(title, addP, dup, delB);
                const paramsBox = document.createElement("div");
                paramsBox.style.cssText = "display:flex;flex-direction:column;gap:4px;";
                box.append(head, paramsBox);
                batchesBox.appendChild(box);
                batch.els = { box, title, paramsBox };
                batches.push(batch);
                renumber();

                addP.addEventListener("click", (e) => {
                    e.stopPropagation();
                    addParamRow(batch);
                    saveConfig();
                });
                dup.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const copy = addBatch();
                    for (const p of batch.params) {
                        addParamRow(copy, { nodeId: p.nodeId, widgetName: p.widgetName, expr: p.expr });
                    }
                    saveConfig();
                });
                delB.addEventListener("click", (e) => {
                    e.stopPropagation();
                    batches = batches.filter((b) => b !== batch);
                    box.remove();
                    renumber();
                    saveConfig();
                    resize();
                });
                for (const el of [addP, dup, delB]) {
                    el.addEventListener("pointerdown", (e) => e.stopPropagation());
                }

                if (saved?.params) {
                    for (const p of saved.params) addParamRow(batch, p);
                } else if (!saved) {
                    addParamRow(batch); // fila inicial por comodidad
                }
                resize();
                return batch;
            };

            addBatchBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                addBatch();
                saveConfig();
            });

            // ---------- ejecucion ----------
            const runBatches = async () => {
                if (running) return;
                // cada wedge = un run; si algun valor es una lista, ese wedge
                // se expande en varias ejecuciones (producto dentro del wedge)
                const runs = [];
                batches.forEach((b, bi) => {
                    // dentro de un wedge, filas sobre el MISMO nodo+widget se
                    // fusionan como lista de valores (2 filas de seed = 2 runs)
                    const byKey = new Map();
                    for (const r of b.params) {
                        const n = app.graph.getNodeById(r.nodeId);
                        const values = expandValues(r.expr);
                        if (!n || !r.widgetName || !values.length) continue;
                        const key = `${r.nodeId}::${r.widgetName}`;
                        if (byKey.has(key)) byKey.get(key).values.push(...values);
                        else byKey.set(key, { node: n, widgetName: r.widgetName, values: [...values] });
                    }
                    const specs = [...byKey.values()];
                    if (!specs.length) return;
                    let combos = [[]];
                    for (const s of specs) {
                        const next = [];
                        for (const c of combos) for (const v of s.values) next.push([...c, v]);
                        combos = next;
                    }
                    for (const c of combos) {
                        runs.push({
                            batchIdx: bi,
                            sets: c.map((v, k) => ({ node: specs[k].node, widgetName: specs[k].widgetName, value: v })),
                        });
                    }
                });
                if (!runs.length) {
                    status.style.color = ER.error; // semantico: aviso en rojo
                    status.textContent = "add at least one wedge with a param and values";
                    return;
                }
                if (runs.length > MAX_RUNS) {
                    status.style.color = ER.error;
                    status.textContent = `too many runs (${runs.length}), max ${MAX_RUNS}`;
                    return;
                }
                // limpia los resultados del run anterior para no acumular
                clearResults();
                running = true;
                runBtn.textContent = "⏳ queueing...";
                status.style.color = ER.accent; // progreso en cian mientras corre
                const originals = new Map(); // "id::widget" -> valor original
                try {
                    for (let i = 0; i < runs.length; i++) {
                        const params = [];
                        for (const s of runs[i].sets) {
                            const w = s.node.widgets.find((w) => w.name === s.widgetName);
                            const key = `${s.node.id}::${s.widgetName}`;
                            if (w && !originals.has(key)) originals.set(key, { node: s.node, name: s.widgetName, value: w.value });
                            if (w) w.value = s.value;
                            params.push({ label: s.widgetName, value: s.value });
                        }
                        pendingRuns.push({ batchIdx: runs[i].batchIdx, params });
                        if (metaW) metaW.value = JSON.stringify({ batchIdx: runs[i].batchIdx, params });
                        await app.queuePrompt(0, 1);
                        status.textContent = `queued ${i + 1}/${runs.length}`;
                    }
                } finally {
                    for (const o of originals.values()) {
                        const w = o.node.widgets.find((w) => w.name === o.name);
                        if (w) w.value = o.value;
                    }
                    if (metaW) metaW.value = "";
                    running = false;
                    runBtn.textContent = "▶ Run wedges";
                }
            };
            runBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                runBatches();
            });

            clearBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                clearResults();
                status.style.color = ER.textDim;
                status.textContent = "";
                resize();
            });

            // ---------- rejilla de resultados ----------
            const renderResult = (entry) => {
                grid.appendChild(mkResultCell(entry));
                grid._erLayout?.();
                grid.scrollTop = grid.scrollHeight;
            };

            node.erAddResult = (item) => {
                // preferimos los metadatos que viajaron con el prompt (fiables
                // incluso tras recargar la pagina); el FIFO queda de respaldo
                let run = null;
                if (item.meta) {
                    try {
                        const m = JSON.parse(item.meta);
                        if (m && Array.isArray(m.params)) run = m; // solo meta valido
                    } catch (e) { /* meta invalido */ }
                }
                const pending = pendingRuns.shift();
                run = run || pending;
                const label = run
                    ? `W${run.batchIdx + 1} · ` + run.params.map((p) => `${p.label}: ${p.value}`).join(" · ")
                    : "(manual run)";
                const entry = {
                    // hd: version 1080p que solo se usa al exportar el sheet
                    item: { filename: item.filename, hd: item.hd || "", subfolder: item.subfolder || "", type: item.type || "temp" },
                    kind: item.kind || "image",
                    batchIdx: run ? run.batchIdx : null,
                    params: run ? run.params : [],
                    label,
                };
                results.push(entry);
                saveResults();
                renderResult(entry);
                // cian mientras quedan runs; al terminar vuelve al gris por defecto
                status.style.color = pendingRuns.length ? ER.accent : ER.textDim;
                status.textContent = pendingRuns.length
                    ? `results: ${results.length} · waiting: ${pendingRuns.length}`
                    : `results: ${results.length}`;
            };

            // exportacion de contact sheet (menu de click derecho):
            // pide un titulo para la hoja (p. ej. "Anime characters")
            node.erGetResults = () => results.slice();
            const askTitle = () =>
                new Promise((res) => {
                    const prevTitle = node.properties.er_title || "";
                    if (app.canvas?.prompt) {
                        app.canvas.prompt("Contact sheet title", prevTitle, (v) => res(v ?? prevTitle), null);
                    } else {
                        res(window.prompt("Contact sheet title", prevTitle));
                    }
                });
            node.erExportSheet = async () => {
                const title = await askTitle();
                if (title === null) return; // cancelado
                node.properties.er_title = title;
                status.style.color = ER.accent;
                status.textContent = "building contact sheet...";
                // el sequencer siempre descarga; el guardado a carpeta vive
                // en los nodos ER Wedge Preview
                const res = await exportSheet(results, String(title).trim(), "");
                if (!res) {
                    status.style.color = ER.error;
                    status.textContent = "no results to export";
                } else if (!res.ok) {
                    status.style.color = ER.error;
                    status.textContent = `save failed: ${res.error}`;
                } else {
                    status.style.color = ER.textDim;
                    if (res.path) {
                        status.textContent = `saved: ${res.path}`;
                        status.title = "click: copy path";
                        status.style.cursor = "pointer";
                        status.onclick = () => navigator.clipboard?.writeText(res.path);
                    } else {
                        status.textContent = `results: ${results.length}`;
                    }
                }
            };

            // restaura configuracion y resultados guardados
            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                setTimeout(() => {
                    // limpia el meta transitorio (workflows antiguos podian
                    // desplazar aqui el valor del extinto widget fps)
                    if (metaW) metaW.value = "";
                    if (!batches.length) {
                        const groups = node.properties?.er_batch_groups;
                        const legacy = node.properties?.er_batch_params;
                        if (Array.isArray(groups) && groups.length) {
                            for (const g of groups) addBatch(g);
                        } else if (Array.isArray(legacy) && legacy.length) {
                            addBatch({ params: legacy });
                            saveConfig();
                        }
                    }
                    if (!results.length && Array.isArray(node.properties?.er_wedge_results)) {
                        results = node.properties.er_wedge_results.slice();
                        for (const r of results) renderResult(r);
                        if (results.length) status.textContent = `results: ${results.length}`;
                    }
                }, 300);
            };

            resize();
        };

        // entrega cada resultado ejecutado a la rejilla del nodo
        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const item = message?.er_batch?.[0];
            if (item && this.erAddResult) this.erAddResult(item);
        };
    },
});

// ---------- ER Wedge Preview: galeria de presentacion para cliente ----------
// kind: "image" o "video" — cada variante muestra solo ese tipo de resultado
function setupPreviewNode(nodeType, kind) {
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        onNodeCreated?.apply(this, arguments);
        erBrandNode(this);
        const node = this;
        node.properties = node.properties || {};
        let lastHash = "";

        const root = document.createElement("div");
        root.className = "er-ui";
        root.style.cssText =
            `width:100%;display:flex;flex-direction:column;gap:6px;font-family:${ER.font};font-size:11px;color:${ER.text};`;

        const topBar = document.createElement("div");
        topBar.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";
        const srcSel = document.createElement("select");
        srcSel.className = "er-select";
        srcSel.style.cssText = "font-size:10px;max-width:190px;padding:2px 5px;";
        const titleInp = document.createElement("input");
        titleInp.type = "text";
        titleInp.placeholder = "Sheet title (e.g. Anime characters)";
        titleInp.className = "er-input";
        titleInp.style.cssText = "flex:1;min-width:90px;font-size:11px;padding:3px 7px;";
        titleInp.value = node.properties.er_title || "";
        // carpeta de destino del contact sheet (vacio = descarga navegador)
        const dirInp = document.createElement("input");
        dirInp.type = "text";
        dirInp.placeholder = "Sheet folder (empty = download)";
        dirInp.title = "Where to save the contact sheet. Empty = browser download.";
        dirInp.className = "er-input";
        dirInp.style.cssText = "flex:1;min-width:80px;font-size:11px;padding:3px 7px;";
        dirInp.value = node.properties.er_sheet_dir || "";
        const sheetBtn = document.createElement("button");
        sheetBtn.textContent = "🖼 Contact sheet";
        sheetBtn.title = "Save one PNG with every result and its values";
        sheetBtn.className = "er-btn";
        sheetBtn.style.cssText = "height:22px;font-size:11px;line-height:1;padding:0 10px;";
        const status = document.createElement("span");
        status.style.cssText = `color:${ER.textDim};`;
        topBar.append(srcSel, titleInp, dirInp, sheetBtn, status);

        const gallery = document.createElement("div");
        // flex:0 0 auto: el contenedor flex no puede encoger la galeria
        gallery.style.cssText = "overflow-y:auto;height:300px;min-height:140px;flex:0 0 auto;";
        gallery.dataset.erSelf = "1"; // autoajustable: el fitter generico la excluye
        // mismo layout fit que el sequencer: todo visible a la vez, sin huecos
        erFitCells(gallery, 8);

        root.append(topBar, gallery);
        const widget = node.addDOMWidget("er_wedge_preview_ui", "ER_WEDGE_PREVIEW", root, {
            serialize: false,
            hideOnZoom: false,
        });
        widget.computeSize = (width) => [width, 300];
        node._erFitGrid = () => {
            const wy = widget.y || 0;
            const avail = node.size[1] - wy - gallery.offsetTop - 14;
            const h = Math.max(200, avail);
            const hpx = `${h}px`;
            if (gallery.style.height !== hpx) {
                gallery.style.height = hpx;
                gallery.style.maxHeight = hpx;
                gallery._erLayout();
            }
        };

        const sequencers = () =>
            (app.graph._nodes || []).filter((n) => SEQ_TYPES.has(n.type));

        const readEntries = (seq) =>
            (seq.erGetResults ? seq.erGetResults() : seq.properties?.er_wedge_results) || [];

        // solo los resultados del tipo de esta variante (imagen o video)
        const selectedEntries = () => {
            const v = node.properties.er_src ?? "all";
            let out = [];
            for (const s of sequencers()) {
                if (v === "all" || String(s.id) === String(v)) out = out.concat(readEntries(s));
            }
            return out.filter((e) => (e.kind || "image") === kind);
        };

        const fillSources = () => {
            const seqs = sequencers();
            const want = ["all", ...seqs.map((s) => String(s.id))].join("|");
            if (srcSel.dataset.want === want) return;
            srcSel.dataset.want = want;
            srcSel.innerHTML = "";
            const all = document.createElement("option");
            all.value = "all";
            all.textContent = "All wedge sequencers";
            srcSel.appendChild(all);
            for (const s of seqs) {
                const o = document.createElement("option");
                o.value = String(s.id);
                o.textContent = `${s.title || s.type} #${s.id}`;
                srcSel.appendChild(o);
            }
            const v = String(node.properties.er_src ?? "all");
            srcSel.value = [...srcSel.options].some((o) => o.value === v) ? v : "all";
        };

        const render = () => {
            fillSources();
            const entries = selectedEntries();
            const hash = JSON.stringify(entries.map((e) => [e.item?.filename, e.label]));
            if (hash === lastHash) return;
            lastHash = hash;
            gallery.innerHTML = "";
            if (!entries.length) {
                const empty = document.createElement("div");
                empty.className = "er-dim";
                empty.style.cssText = "padding:18px;text-align:center;";
                empty.textContent = `No ${kind} results yet — run a wedge sequencer to populate this preview.`;
                gallery.appendChild(empty);
                status.textContent = "";
                return;
            }
            // flujo continuo en orden de wedge; cada imagen ya lleva su
            // etiqueta W1/W2... superpuesta
            for (const e of entries) gallery.appendChild(mkResultCell(e, 12));
            gallery._erLayout();
            status.textContent = `${entries.length} results`;
        };

        srcSel.addEventListener("change", () => {
            node.properties.er_src = srcSel.value;
            lastHash = "";
            render();
        });
        titleInp.addEventListener("input", () => {
            node.properties.er_title = titleInp.value;
        });
        dirInp.addEventListener("input", () => {
            node.properties.er_sheet_dir = dirInp.value;
        });
        for (const el of [srcSel, titleInp, dirInp, sheetBtn]) {
            el.addEventListener("pointerdown", (e) => e.stopPropagation());
            el.addEventListener("keydown", (e) => e.stopPropagation());
        }

        // al cargar un workflow guardado, refleja el titulo y la carpeta
        const onConfigure = node.onConfigure;
        node.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            setTimeout(() => {
                titleInp.value = node.properties?.er_title || "";
                dirInp.value = node.properties?.er_sheet_dir || "";
            }, 300);
        };

        node.erExportSheet = async () => {
            status.style.color = ER.accent;
            status.textContent = "building contact sheet...";
            const res = await exportSheet(
                selectedEntries(),
                (titleInp.value || "").trim(),
                (dirInp.value || "").trim()
            );
            if (!res) {
                status.style.color = ER.error;
                status.textContent = "no results to export";
            } else if (!res.ok) {
                status.style.color = ER.error;
                status.textContent = `save failed: ${res.error}`;
            } else {
                status.style.color = ER.textDim;
                if (res.path) {
                    status.textContent = `saved: ${res.path}`;
                    status.title = "click: copy path";
                    status.style.cursor = "pointer";
                    status.onclick = () => navigator.clipboard?.writeText(res.path);
                } else {
                    status.textContent = `${selectedEntries().length} results`;
                }
            }
        };
        sheetBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            node.erExportSheet();
        });

        // refresco periodico: refleja en vivo lo que van produciendo los
        // sequencers; el tick corto mantiene la galeria ajustada al nodo
        const timer = setInterval(render, 1000);
        const fitTimer = setInterval(() => node._erFitGrid?.(), 500);
        const onRemoved = node.onRemoved;
        node.onRemoved = function () {
            clearInterval(timer);
            clearInterval(fitTimer);
            onRemoved?.apply(this, arguments);
        };

        const min = node.computeSize();
        node.setSize([Math.max(node.size[0], 460), Math.max(node.size[1], min[1])]);
        render();
    };
}
