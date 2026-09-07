import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const NODE_TYPE = "ERCombine";
const MAX_LAYERS = 4;
const MODES = ["normal", "add", "screen", "multiply", "overlay",
    "soft light", "difference", "lighten", "darken"];
// mapa 1:1 a los modos del lienzo 2D — el preview usa EXACTAMENTE las
// mismas operaciones que el render final en Python
const GCO = {
    "normal": "source-over", "add": "lighter", "screen": "screen",
    "multiply": "multiply", "overlay": "overlay", "soft light": "soft-light",
    "difference": "difference", "lighten": "lighten", "darken": "darken",
};

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

app.registerExtension({
    name: "comfy.ERCombine",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this);
            const node = this;
            let aspect = 16 / 9;
            let stageOn = false;

            // ---------- ranuras dinamicas: layer_2 aparece al conectar la 1 ----------
            const LAY = (i) => `layer_${i}`;
            const syncLayerInputs = () => {
                let last = 0;
                for (let i = 1; i <= MAX_LAYERS; i++) {
                    const s = node.findInputSlot(LAY(i));
                    if (s >= 0 && node.inputs[s].link != null) last = i;
                }
                const want = Math.min(MAX_LAYERS, last + 1);
                for (let i = MAX_LAYERS; i > want; i--) {
                    const s = node.findInputSlot(LAY(i));
                    if (s >= 0 && node.inputs[s].link == null) node.removeInput(s);
                }
                for (let i = 1; i <= want; i++) {
                    if (node.findInputSlot(LAY(i)) < 0) node.addInput(LAY(i), "IMAGE");
                }
            };

            // ---------- parametros por capa (JSON oculto) ----------
            const paramsW = node.widgets?.find((w) => w.name === "params");
            if (paramsW) {
                paramsW.type = "hidden";
                paramsW.hidden = true;
                paramsW.computeSize = () => [0, -4];
            }
            const getLayers = () => {
                try {
                    const d = JSON.parse(paramsW?.value || "{}");
                    const arr = Array.isArray(d.layers) ? d.layers : [];
                    return Array.from({ length: MAX_LAYERS }, (_, i) => ({
                        mode: MODES.includes(arr[i]?.mode) ? arr[i].mode : "add",
                        opacity: typeof arr[i]?.opacity === "number"
                            ? Math.min(1, Math.max(0, arr[i].opacity)) : 1.0,
                    }));
                } catch (e) {
                    return Array.from({ length: MAX_LAYERS }, () => ({ mode: "add", opacity: 1.0 }));
                }
            };
            const saveLayers = (list) => {
                if (paramsW) paramsW.value = JSON.stringify({ layers: list });
            };

            // ---------- interfaz ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText = "width:100%;display:flex;flex-direction:column;gap:5px;";

            const panel = document.createElement("div");
            panel.className = "er-panel";
            panel.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:6px 8px;flex:0 0 auto;";
            root.appendChild(panel);

            let rowCount = 0;
            const rebuildRows = () => {
                const list = getLayers();
                panel.innerHTML = "";
                rowCount = 0;
                for (let i = 1; i <= MAX_LAYERS; i++) {
                    if (node.findInputSlot(LAY(i)) < 0) continue;
                    const linked = node.inputs[node.findInputSlot(LAY(i))].link != null;
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;align-items:center;gap:6px;";
                    const chip = document.createElement("span");
                    chip.textContent = String(i);
                    chip.style.cssText =
                        "width:15px;height:15px;border-radius:3px;display:inline-flex;flex:0 0 auto;" +
                        "align-items:center;justify-content:center;font-size:9px;font-weight:bold;" +
                        (linked ? `background:${ER.accent};color:#111;` : `border:1px solid ${ER.border};color:#888;`);
                    const sel = document.createElement("select");
                    sel.className = "er-select";
                    sel.style.cssText = "flex:0 0 auto;width:96px;font-size:10px;padding:2px 4px;";
                    for (const m of MODES) {
                        const o = document.createElement("option");
                        o.value = m;
                        o.textContent = m;
                        sel.appendChild(o);
                    }
                    sel.value = list[i - 1].mode;
                    const rng = document.createElement("input");
                    rng.type = "range";
                    rng.className = "er-range";
                    rng.min = "0"; rng.max = "1"; rng.step = "0.01";
                    rng.value = String(list[i - 1].opacity);
                    rng.style.cssText = "flex:1;height:14px;";
                    const val = document.createElement("span");
                    val.className = "er-dim";
                    val.style.cssText = "font-size:10px;width:30px;text-align:right;flex:0 0 auto;";
                    val.textContent = list[i - 1].opacity.toFixed(2);
                    for (const el of [sel, rng]) {
                        el.addEventListener("pointerdown", (e) => e.stopPropagation());
                    }
                    sel.addEventListener("change", () => {
                        const l2 = getLayers();
                        l2[i - 1].mode = sel.value;
                        saveLayers(l2);
                        draw();
                    });
                    rng.addEventListener("input", () => {
                        const l2 = getLayers();
                        l2[i - 1].opacity = Number(rng.value);
                        val.textContent = l2[i - 1].opacity.toFixed(2);
                        saveLayers(l2);
                        draw();
                    });
                    row.append(chip, sel, rng, val);
                    panel.appendChild(row);
                    rowCount++;
                }
                if (!rowCount) {
                    const empty = document.createElement("span");
                    empty.className = "er-dim";
                    empty.style.cssText = "font-size:10px;";
                    empty.textContent = "Connect layers to stack them over the base.";
                    panel.appendChild(empty);
                    rowCount = 1;
                }
            };

            // visor: composicion en vivo sobre lienzo 2D
            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText = "position:relative;width:100%;flex:0 0 auto;overflow:hidden;display:none;";
            const cnv = document.createElement("canvas");
            cnv.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;display:block;";
            stage.appendChild(cnv);
            let abOn = false;
            const abBtn = document.createElement("button");
            abBtn.className = "er-btn";
            abBtn.textContent = "A|B";
            abBtn.title = "Toggle composite / base";
            abBtn.style.cssText =
                "position:absolute;top:6px;right:6px;height:22px;font-size:11px;line-height:1;padding:0 8px;opacity:.85;";
            abBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            abBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                abOn = !abOn;
                abBtn.classList.toggle("er-active", abOn);
                draw();
            });
            stage.appendChild(abBtn);
            root.appendChild(stage);

            const widget = node.addDOMWidget("er_combine_ui", "ER_COMBINE", root, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = function (width) {
                let h = 16 + rowCount * 26;
                if (stageOn) h += Math.min(Math.round((width - 22) / aspect), 340) + 6;
                return [width, h];
            };
            const sizeStage = () => {
                if (!stageOn) return;
                const w = root.clientWidth || node.size[0] - 22;
                stage.style.height = `${Math.min(Math.round(w / aspect), 340)}px`;
            };
            new ResizeObserver(sizeStage).observe(root);
            const fitNode = () => {
                node.setSize([node.size[0], node.computeSize()[1]]);
                app.graph.setDirtyCanvas(true, true);
            };

            // ---------- fuentes de imagen (cache de upstream / LoadImage) ----------
            const srcURLFor = (slotName) => {
                const idx = node.findInputSlot?.(slotName);
                if (idx < 0 || node.inputs?.[idx]?.link == null) return null;
                const link = app.graph.links?.get
                    ? app.graph.links.get(node.inputs[idx].link)
                    : app.graph.links?.[node.inputs[idx].link];
                const src = link ? app.graph.getNodeById(link.origin_id) : null;
                if (!src) return null;
                const cached = app.nodeOutputs?.[String(src.id)];
                for (const key of ["images", "er_lens", "er_glow", "er_grain", "er_cc",
                                   "er_editgen", "er_combine", "er_img", "er_res"]) {
                    if (cached?.[key]?.length && cached[key][0].filename) {
                        return viewURL(cached[key][0]);
                    }
                }
                if (src.type === "LoadImage") {
                    const w = src.widgets?.find((x) => x.name === "image");
                    if (w?.value) {
                        let name = String(w.value).replace(/ \[\w+\]$/, "");
                        let subfolder = "";
                        const slash = name.lastIndexOf("/");
                        if (slash >= 0) {
                            subfolder = name.slice(0, slash);
                            name = name.slice(slash + 1);
                        }
                        return viewURL({ filename: name, subfolder, type: "input" });
                    }
                }
                if (src.imgs?.length && src.imgs[0].src) return src.imgs[0].src;
                return null;
            };
            const texCache = new Map();
            const loadTex = (url) =>
                new Promise((res) => {
                    if (!url) return res(null);
                    const key = url.split("rand=")[0];
                    if (texCache.has(key)) return res(texCache.get(key));
                    const im = new Image();
                    im.onload = () => { texCache.set(key, im); res(im); };
                    im.onerror = () => res(null);
                    im.src = url;
                });

            let drawing = false;
            const draw = async () => {
                if (drawing) return;
                drawing = true;
                try {
                    const baseIm = await loadTex(srcURLFor("base"));
                    if (!baseIm) { drawing = false; return; }
                    aspect = baseIm.naturalWidth / Math.max(1, baseIm.naturalHeight);
                    if (!stageOn) {
                        stageOn = true;
                        stage.style.display = "block";
                        sizeStage();
                        fitNode();
                    }
                    const W = Math.min(baseIm.naturalWidth, 1024);
                    const H = Math.round(W / aspect);
                    cnv.width = W; cnv.height = H;
                    const ctx = cnv.getContext("2d");
                    ctx.globalCompositeOperation = "source-over";
                    ctx.globalAlpha = 1;
                    ctx.drawImage(baseIm, 0, 0, W, H);
                    if (!abOn) {
                        const list = getLayers();
                        for (let i = 1; i <= MAX_LAYERS; i++) {
                            const im = await loadTex(srcURLFor(LAY(i)));
                            if (!im) continue;
                            ctx.globalCompositeOperation = GCO[list[i - 1].mode] || "source-over";
                            ctx.globalAlpha = list[i - 1].opacity;
                            ctx.drawImage(im, 0, 0, W, H);
                        }
                        ctx.globalCompositeOperation = "source-over";
                        ctx.globalAlpha = 1;
                    }
                } finally {
                    drawing = false;
                }
            };
            node.erRefreshTex = () => { texCache.clear(); draw(); };

            // ---------- ciclo de vida ----------
            let lastKey = "";
            const timer = setInterval(() => {
                const urls = ["base", ...Array.from({ length: MAX_LAYERS }, (_, i) => LAY(i + 1))]
                    .map((s) => (srcURLFor(s) || "").split("rand=")[0]).join("|");
                if (urls !== lastKey) {
                    lastKey = urls;
                    rebuildRows();
                    fitNode();
                    draw();
                }
            }, 700);
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(timer);
                onRemoved?.apply(this, arguments);
            };
            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function () {
                onConnectionsChange?.apply(this, arguments);
                setTimeout(() => {
                    syncLayerInputs();
                    rebuildRows();
                    fitNode();
                    draw();
                }, 60);
            };
            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                setTimeout(() => {
                    syncLayerInputs();
                    rebuildRows();
                    fitNode();
                }, 300);
            };
            setTimeout(() => {
                syncLayerInputs();
                rebuildRows();
                fitNode();
            }, 140);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            // tras ejecutar, las caches de upstream ya estan frescas
            this.erRefreshTex?.();
        };
    },
});
