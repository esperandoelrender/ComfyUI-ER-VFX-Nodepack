import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme(); // inyecta la hoja de estilos ER Academy

const NODE_TYPE = "ERGrade";
const PARAMS = ["multiply", "offset", "gamma"];
const DEFAULTS = { multiply: 1, offset: 0, gamma: 1 };
const DEFAULT_POINTS = { bp: [0, 0, 0], wp: [1, 1, 1], lift: [0, 0, 0], gain: [1, 1, 1] };
const MAX_PREVIEW = 768;

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

// misma matemática que apply_grade en Python
function gradePixels(src, dst, A, B, invGamma) {
    for (let i = 0; i < src.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            let v = src[i + c] / 255;
            v = v * A[c] + B[c];
            v = Math.pow(Math.max(v, 0), invGamma);
            dst[i + c] = Math.min(Math.max(v, 0), 1) * 255;
        }
        dst[i + 3] = src[i + 3];
    }
}

function gradeCoeffs(points, multiply, offset) {
    const A = [0, 0, 0];
    const B = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        let denom = points.wp[c] - points.bp[c];
        if (Math.abs(denom) < 1e-4) denom = 1e-4;
        A[c] = (multiply * (points.gain[c] - points.lift[c])) / denom;
        B[c] = offset + points.lift[c] - A[c] * points.bp[c];
    }
    return [A, B];
}

app.registerExtension({
    name: "comfy.ERGrade",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // logo en la barra de título
        // en cada redibujado, el visor se ajusta al tamano actual del nodo
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFitCC?.();
        };

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
            let srcImage = null;    // ImageData de la imagen actual (original)
            let refImage = null;    // ImageData de la referencia (o null)
            let outImage = null;
            let rafId = null;
            let lastApplied = null;
            let viewMode = "result"; // "result" | "input" | "ref"
            let pickMode = null;     // "bp" | "wp" | "lift" | "gain" | null

            // el widget "points" (STRING) guarda los 4 colores; va oculto
            const pointsWidget = node.widgets?.find((w) => w.name === "points");
            if (pointsWidget) {
                pointsWidget.type = "hidden";
                pointsWidget.computeSize = () => [0, -4];
                pointsWidget.hidden = true;
            }
            const getPoints = () => {
                try {
                    const d = JSON.parse(pointsWidget?.value || "{}");
                    const out = {};
                    for (const k of Object.keys(DEFAULT_POINTS)) {
                        out[k] = Array.isArray(d[k]) && d[k].length === 3 ? d[k].map(Number) : [...DEFAULT_POINTS[k]];
                    }
                    return out;
                } catch (e) {
                    return JSON.parse(JSON.stringify(DEFAULT_POINTS));
                }
            };
            const setPoint = (key, rgb) => {
                const p = getPoints();
                p[key] = rgb.map((v) => Math.round(v * 1000) / 1000);
                if (pointsWidget) pointsWidget.value = JSON.stringify(p);
                updateSwatches();
            };

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:5px;font-family:${ER.font};`;

            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText =
                "position:relative;width:100%;flex:0 0 auto;overflow:hidden;display:none;";
            const canvas = document.createElement("canvas");
            canvas.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
            stage.appendChild(canvas);
            const pickHint = document.createElement("div");
            pickHint.style.cssText =
                "position:absolute;top:6px;left:8px;padding:2px 8px;border-radius:4px;display:none;" +
                `background:rgba(0,0,0,.7);color:${ER.text};font-size:11px;pointer-events:none;` +
                `font-family:${ER.font};`;
            stage.appendChild(pickHint);

            // pickers: negros/blancos de la imagen y de la referencia
            const pickerRow = document.createElement("div");
            pickerRow.style.cssText = "display:none;align-items:center;gap:4px;flex-wrap:wrap;flex:0 0 auto;";
            const mkBtn = (text, title) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.title = title;
                // colores/borde base via clase er-btn; inline solo layout + franja swatch
                b.className = "er-btn";
                b.style.cssText =
                    "height:22px;border-radius:4px;" +
                    "cursor:pointer;font-size:10px;line-height:1;padding:0 8px;border-bottom:3px solid #000;";
                return b;
            };
            const pickBtns = {
                bp: mkBtn("⚫ In black", "Pick the blackpoint on YOUR image"),
                wp: mkBtn("⚪ In white", "Pick the whitepoint on YOUR image"),
                lift: mkBtn("⚫ Ref black", "Pick the target black on the REFERENCE image"),
                gain: mkBtn("⚪ Ref white", "Pick the target white on the REFERENCE image"),
            };
            pickerRow.append(pickBtns.bp, pickBtns.wp, pickBtns.lift, pickBtns.gain);

            // selector de vista: Result (imagen nueva) / Input (intacta) / Ref
            const controls = document.createElement("div");
            controls.style.cssText = "display:none;align-items:center;gap:6px;flex:0 0 auto;";
            const viewBtns = {
                result: mkBtn("Result", "The graded output image"),
                input: mkBtn("Input", "Your ORIGINAL image, untouched (where In black/white pick)"),
                ref: mkBtn("Ref", "The reference image (where Ref black/white pick)"),
            };
            const resetBtn = mkBtn("Reset", "Reset points and parameters");
            // los tabs y Reset no llevan franja swatch: borde uniforme de er-btn
            for (const b of Object.values(viewBtns)) b.style.borderBottom = "";
            resetBtn.style.borderBottom = "";
            resetBtn.style.marginLeft = "auto";
            viewBtns.ref.style.display = "none";
            const setView = (mode) => {
                if (mode === "ref" && !refImage) mode = "result";
                viewMode = mode;
                for (const [k, b] of Object.entries(viewBtns)) {
                    b.classList.toggle("er-active", k === viewMode);
                }
                lastApplied = null;
            };
            for (const [k, b] of Object.entries(viewBtns)) {
                b.addEventListener("click", (e) => {
                    e.stopPropagation();
                    setView(k);
                });
            }
            controls.append(viewBtns.result, viewBtns.input, viewBtns.ref, resetBtn);

            root.append(stage, pickerRow, controls);

            const widget = node.addDOMWidget("er_grade_preview", "ER_GRADE", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima; el contenido se adapta luego al tamano real del
            // nodo (el layout de widgets DOM del frontend nuevo no reserva el
            // alto pedido y el visor desbordaba el nodo, robando los clics
            // del lienzo alrededor)
            const EXTRA_H = 62; // tabs + pickers + botones + separaciones
            widget.computeSize = function (width) {
                if (stage.style.display === "none") return [width, -4];
                return [width, EXTRA_H + 120];
            };

            // el visor ocupa exactamente el espacio que el nodo le da; el
            // canvas interior mantiene el aspecto via object-fit:contain.
            // Ajuste con realimentacion: mide el desborde REAL del contenido
            // respecto al borde inferior del nodo y corrige la altura del
            // visor (los margenes internos del frontend no son deducibles)
            const updateStageHeight = () => {
                if (stage.style.display === "none") return;
                if (!root.getBoundingClientRect().width) return; // sin layout aun
                const ds = app.canvas.ds;
                const scale = ds.scale || 1;
                const nodeBottom = (node.pos[1] + node.size[1] + ds.offset[1]) * scale;
                let mx = -Infinity;
                for (const c of root.children) {
                    if (getComputedStyle(c).display === "none") continue;
                    mx = Math.max(mx, c.getBoundingClientRect().bottom);
                }
                if (!isFinite(mx)) return;
                const delta = (mx - nodeBottom) / scale + 10; // margen inferior
                if (Math.abs(delta) < 3) return;
                const cur = parseFloat(stage.style.height) || stage.clientHeight || 200;
                stage.style.height = `${Math.max(90, cur - delta)}px`;
            };
            node._erFitCC = updateStageHeight;
            new ResizeObserver(updateStageHeight).observe(root);
            const fitTimer = setInterval(updateStageHeight, 500);
            const onRemovedGr = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemovedGr?.apply(this, arguments);
            };

            const rgbCss = (rgb) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`;
            const updateSwatches = () => {
                const p = getPoints();
                pickBtns.bp.style.borderBottomColor = rgbCss(p.bp);
                pickBtns.wp.style.borderBottomColor = rgbCss(p.wp);
                pickBtns.lift.style.borderBottomColor = rgbCss(p.lift);
                pickBtns.gain.style.borderBottomColor = rgbCss(p.gain);
            };

            // ---------- render ----------
            const ctx2d = canvas.getContext("2d");
            const getParams = () => {
                const p = {};
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    p[name] = w ? Number(w.value) : DEFAULTS[name];
                }
                return p;
            };

            const drawRefFit = () => {
                if (!refImage) return;
                const t = document.createElement("canvas");
                t.width = refImage.width;
                t.height = refImage.height;
                t.getContext("2d").putImageData(refImage, 0, 0);
                ctx2d.fillStyle = ER.inset;
                ctx2d.fillRect(0, 0, canvas.width, canvas.height);
                ctx2d.drawImage(t, 0, 0, canvas.width, canvas.height);
            };

            const render = () => {
                if (!srcImage) return;
                if (viewMode === "ref" && refImage) {
                    drawRefFit();
                    return;
                }
                if (viewMode === "input") {
                    ctx2d.putImageData(srcImage, 0, 0);
                    return;
                }
                const p = getParams();
                const [A, B] = gradeCoeffs(getPoints(), p.multiply, p.offset);
                gradePixels(srcImage.data, outImage.data, A, B, 1 / Math.max(p.gamma, 1e-6));
                ctx2d.putImageData(outImage, 0, 0);
            };

            const loop = () => {
                if (srcImage) {
                    const p = getParams();
                    const key = PARAMS.map((n) => p[n]).join(",") + "|" + (pointsWidget?.value || "") + "|" + viewMode;
                    if (key !== lastApplied) {
                        lastApplied = key;
                        render();
                    }
                }
                rafId = requestAnimationFrame(loop);
            };
            rafId = requestAnimationFrame(loop);

            // ---------- pickers ----------
            const HINTS = {
                bp: "Click the DARKEST area of your ORIGINAL image (shown untouched)",
                wp: "Click the BRIGHTEST area of your ORIGINAL image (shown untouched)",
                lift: "Click the DARKEST area of the reference",
                gain: "Click the BRIGHTEST area of the reference",
            };
            let hintTimer = null;
            const flashHint = (text) => {
                pickHint.style.color = ER.warn; // aviso: naranja semántico
                pickHint.textContent = text;
                pickHint.style.display = "block";
                clearTimeout(hintTimer);
                hintTimer = setTimeout(() => {
                    if (!pickMode) pickHint.style.display = "none";
                }, 3500);
            };

            const armPick = (key) => {
                // los pickers de referencia necesitan una referencia cargada
                if ((key === "lift" || key === "gain") && !refImage && pickMode !== key) {
                    flashHint("No reference loaded: connect an image to the 'reference' input (it loads instantly from a Load Image) or run the workflow once.");
                    return;
                }
                pickMode = pickMode === key ? null : key;
                for (const [k, b] of Object.entries(pickBtns)) {
                    b.classList.toggle("er-active", k === pickMode);
                }
                // el visor salta a la vista donde se pica: Input intacta para
                // bp/wp, referencia para lift/gain; al desarmar vuelve a Result
                if (pickMode === "bp" || pickMode === "wp") setView("input");
                else if (pickMode === "lift" || pickMode === "gain") setView("ref");
                else setView("result");
                stage.style.cursor = pickMode ? "crosshair" : "default";
                pickHint.style.display = pickMode ? "block" : "none";
                pickHint.style.color = ER.text; // restaura color tras un aviso
                if (pickMode) pickHint.textContent = HINTS[pickMode];
                lastApplied = null;
            };
            for (const [k, b] of Object.entries(pickBtns)) {
                b.addEventListener("click", (e) => {
                    e.stopPropagation();
                    armPick(k);
                });
            }

            // media 3x3 del pixel clicado, sobre los datos ORIGINALES
            const sampleAt = (img, px, py) => {
                const acc = [0, 0, 0];
                let n = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const x = Math.min(Math.max(px + dx, 0), img.width - 1);
                        const y = Math.min(Math.max(py + dy, 0), img.height - 1);
                        const i = (y * img.width + x) * 4;
                        acc[0] += img.data[i];
                        acc[1] += img.data[i + 1];
                        acc[2] += img.data[i + 2];
                        n++;
                    }
                }
                return acc.map((v) => v / n / 255);
            };

            stage.addEventListener("pointerdown", (e) => {
                if (!pickMode || !srcImage) return;
                e.stopPropagation();
                e.preventDefault();
                const r = stage.getBoundingClientRect();
                const u = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
                const v = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
                const usesRef = (pickMode === "lift" || pickMode === "gain") && refImage;
                const img = usesRef ? refImage : srcImage;
                const px = Math.min(Math.floor(u * img.width), img.width - 1);
                const py = Math.min(Math.floor(v * img.height), img.height - 1);
                setPoint(pickMode, sampleAt(img, px, py));
                armPick(pickMode); // desarma
            });

            // ---------- botones ----------
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    if (w) w.value = DEFAULTS[name];
                }
                if (pointsWidget) pointsWidget.value = JSON.stringify(DEFAULT_POINTS);
                updateSwatches();
                setView("result");
                node.setDirtyCanvas(true, true);
            });
            // ---------- carga de imagenes ----------
            const loadImageEl = (url) =>
                new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = url;
                });

            const toImageData = (imgEl) => {
                const scale = Math.min(1, MAX_PREVIEW / Math.max(imgEl.naturalWidth, imgEl.naturalHeight));
                const w = Math.max(1, Math.round(imgEl.naturalWidth * scale));
                const h = Math.max(1, Math.round(imgEl.naturalHeight * scale));
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const cx = c.getContext("2d");
                cx.drawImage(imgEl, 0, 0, w, h);
                return cx.getImageData(0, 0, w, h);
            };

            node.erSetMain = async (imgFile) => {
                try {
                    const imgEl = await loadImageEl(viewURL(imgFile));
                    srcImage = toImageData(imgEl);
                    canvas.width = srcImage.width;
                    canvas.height = srcImage.height;
                    aspect = srcImage.width / srcImage.height;
                    outImage = ctx2d.createImageData(srcImage.width, srcImage.height);
                    lastApplied = null;
                    stage.style.display = "block";
                    pickerRow.style.display = "flex";
                    controls.style.display = "flex";
                    updateSwatches();
                    setView(viewMode);
                    // tamano por defecto agradable (respeta el aspecto); a
                    // partir de aqui el usuario escala libre y el contenido
                    // se ajusta via updateStageHeight
                    const wy = widget.y || 220;
                    const w = Math.max(node.size[0], 300);
                    node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + EXTRA_H + 24)]);
                    updateStageHeight();
                    app.graph.setDirtyCanvas(true, true);
                } catch (e) {
                    console.error("[ERGrade]", e);
                }
            };

            node.erSetRef = async (refFile) => {
                try {
                    refImage = refFile ? toImageData(await loadImageEl(viewURL(refFile))) : null;
                } catch (e) {
                    console.error("[ERGrade]", e);
                    refImage = null;
                }
                viewBtns.ref.style.display = refImage ? "" : "none";
                if (!refImage && viewMode === "ref") setView("result");
                lastApplied = null;
            };

            node.erSetImages = async (imgFile, refFile) => {
                await node.erSetMain(imgFile);
                await node.erSetRef(refFile);
            };

            // resuelve la imagen mostrable de un nodo origen sin ejecutar:
            // 1) outputs cacheados de una ejecución anterior  2) LoadImage
            const resolveNodeFile = (src) => {
                if (!src) return null;
                const cached = app.nodeOutputs?.[String(src.id)];
                if (cached?.images?.length) return cached.images[0];
                if (src.type === "LoadImage") {
                    const w = src.widgets?.find((w) => w.name === "image");
                    if (w?.value) {
                        let name = String(w.value).replace(/ \[\w+\]$/, "");
                        let subfolder = "";
                        const slash = name.lastIndexOf("/");
                        if (slash >= 0) {
                            subfolder = name.slice(0, slash);
                            name = name.slice(slash + 1);
                        }
                        return { filename: name, subfolder, type: "input" };
                    }
                }
                return null;
            };

            // carga automática al conectar (imagen y referencia, en tiempo real)
            node.erTryAutoLoad = (slot) => {
                if (slot === 0 || slot === undefined) {
                    const f = resolveNodeFile(node.getInputNode?.(0));
                    if (f) node.erSetMain(f);
                }
                if (slot === 1 || slot === undefined) {
                    const f = resolveNodeFile(node.getInputNode?.(1));
                    if (f) node.erSetRef(f);
                }
            };

            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, index, connected, linkInfo) {
                onConnectionsChange?.apply(this, arguments);
                if (type !== LiteGraph.INPUT) return;
                if (connected) {
                    setTimeout(() => node.erTryAutoLoad(index), 50);
                } else if (index === 1) {
                    node.erSetRef(null);
                }
            };

            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                if (pointsWidget && (typeof pointsWidget.value !== "string" || !pointsWidget.value.trim().startsWith("{"))) {
                    pointsWidget.value = JSON.stringify(DEFAULT_POINTS);
                }
                updateSwatches();
            };

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const img = message?.er_img?.[0];
            const ref = message?.er_ref?.[0];
            if (img && this.erSetImages) this.erSetImages(img, ref || null);
        };
    },
});
