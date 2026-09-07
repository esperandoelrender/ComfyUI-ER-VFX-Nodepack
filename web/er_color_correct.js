import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

// inyecta la hoja de estilos ER Academy una sola vez
erTheme();

const NODE_TYPE = "ERColorCorrect";
const PARAMS = ["temperature", "hue", "saturation", "contrast", "gamma", "gain", "offset"];
const DEFAULTS = { temperature: 6500, hue: 0, saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 };

// paneles plegables de la interfaz (sliders con campo numerico y reset)
const CC_GROUPS = [
    ["Balance", [
        ["temperature", "Temp (K)", 1500, 15000, 50],
        ["hue", "Hue", -180, 180, 0.5],
        ["saturation", "Saturation", 0, 4, 0.01],
    ]],
    ["Tone", [
        ["contrast", "Contrast", 0, 4, 0.01],
        ["gamma", "Gamma", 0.2, 5, 0.01],
        ["gain", "Gain", 0, 4, 0.01],
        ["offset", "Offset", -1, 1, 0.005],
    ]],
];
const WHEELS = ["Shadows", "Midtones", "Highlights"];
const MAX_PREVIEW = 768;
const WHEEL_SIZE = 76;
// secundarias por bandas de tono (six-vector), sync con SEC_CENTERS en Python
const SEC_CENTERS = [0, 60, 120, 180, 240, 300];
const SEC_NAMES = ["R", "Yl", "G", "Cy", "B", "Mg"];
const SEC_SLIDERS = [
    ["Hue shift", -60, 60, 1, 0, 0],
    ["Saturation", 0, 2, 0.01, 1, 1],
    ["Luminance", 0, 2, 0.01, 2, 1],
];

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

function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [
        0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.787 * s,
        0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s,
        0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s,
    ];
}

// color de cuerpo negro (Tanner-Helland), espejo de _kelvin_rgb en Python
function kelvinRGB(kelvin) {
    const k = Math.max(1000, Math.min(40000, kelvin)) / 100;
    let r, g, b;
    if (k <= 66) {
        r = 255;
        g = 99.4708025861 * Math.log(k) - 161.1195681661;
    } else {
        r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
        g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    }
    if (k >= 66) b = 255;
    else if (k <= 19) b = 0;
    else b = 138.5177312231 * Math.log(k - 10) - 305.0447927307;
    const cl = (v) => Math.min(Math.max(v, 0), 255) / 255;
    return [cl(r), cl(g), cl(b)];
}

function temperatureGains(kelvin) {
    const rgb = kelvinRGB(kelvin);
    const ref = kelvinRGB(6500);
    const g = [rgb[0] / Math.max(ref[0], 1e-6), rgb[1] / Math.max(ref[1], 1e-6), rgb[2] / Math.max(ref[2], 1e-6)];
    const luma = g[0] * 0.2126 + g[1] * 0.7152 + g[2] * 0.0722;
    return [g[0] / luma, g[1] / luma, g[2] / luma];
}

function hsvToRgb(hDeg) {
    const h = (((hDeg % 360) + 360) % 360) / 60;
    const x = 1 - Math.abs((h % 2) - 1);
    if (h < 1) return [1, x, 0];
    if (h < 2) return [x, 1, 0];
    if (h < 3) return [0, 1, x];
    if (h < 4) return [0, x, 1];
    if (h < 5) return [x, 0, 1];
    return [1, 0, x];
}

// posición de un wheel (ángulo, radio 0..1) -> gains RGB (luma-neutral),
// espejo de tint_gains en Python
function tintToGains(angle, radius) {
    const [r, g, b] = hsvToRgb(angle);
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const k = radius * 0.8;
    return [1 + k * (r - luma), 1 + k * (g - luma), 1 + k * (b - luma)];
}

// misma matemática que apply_color_correct en Python
function correctPixels(src, dst, p, mat, tempG, wheelG, sec, maskBand) {
    const invGamma = 1 / Math.max(p.gamma, 1e-6);
    const useHue = Math.abs(p.hue) > 1e-6;
    const [gs, gm, gh] = wheelG;
    const secList = sec
        ? Object.entries(sec).map(([k, v]) => [SEC_CENTERS[+k], v[0], v[1], v[2]])
        : null;
    const doSec = (secList && secList.length) || maskBand >= 0;
    for (let i = 0; i < src.length; i += 4) {
        let r = src[i] / 255;
        let g = src[i + 1] / 255;
        let b = src[i + 2] / 255;

        if (useHue) {
            const r0 = r, g0 = g, b0 = b;
            r = mat[0] * r0 + mat[1] * g0 + mat[2] * b0;
            g = mat[3] * r0 + mat[4] * g0 + mat[5] * b0;
            b = mat[6] * r0 + mat[7] * g0 + mat[8] * b0;
        }

        if (tempG) {
            r *= tempG[0];
            g *= tempG[1];
            b *= tempG[2];
        }

        let luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
        r = luma + (r - luma) * p.saturation;
        g = luma + (g - luma) * p.saturation;
        b = luma + (b - luma) * p.saturation;

        r = (r - 0.18) * p.contrast + 0.18;
        g = (g - 0.18) * p.contrast + 0.18;
        b = (b - 0.18) * p.contrast + 0.18;

        r = Math.pow(Math.max(r, 0), invGamma);
        g = Math.pow(Math.max(g, 0), invGamma);
        b = Math.pow(Math.max(b, 0), invGamma);

        const l = Math.min(Math.max(r * 0.2126 + g * 0.7152 + b * 0.0722, 0), 1);
        const ws = (1 - l) * (1 - l);
        const wh = l * l;
        const wm = 1 - ws - wh;
        r = r * (1 + ws * (gs[0] - 1) + wm * (gm[0] - 1) + wh * (gh[0] - 1)) * p.gain + p.offset;
        g = g * (1 + ws * (gs[1] - 1) + wm * (gm[1] - 1) + wh * (gh[1] - 1)) * p.gain + p.offset;
        b = b * (1 + ws * (gs[2] - 1) + wm * (gm[2] - 1) + wh * (gh[2] - 1)) * p.gain + p.offset;

        // secundarias por banda de tono (espejo de _apply_secondaries)
        if (doSec) {
            r = Math.min(Math.max(r, 0), 1);
            g = Math.min(Math.max(g, 0), 1);
            b = Math.min(Math.max(b, 0), 1);
            const maxc = Math.max(r, g, b);
            const minc = Math.min(r, g, b);
            const delta = maxc - minc;
            let h = 0;
            if (delta > 1e-6) {
                if (maxc === r) h = (((g - b) / delta) % 6 + 6) % 6;
                else if (maxc === g) h = (b - r) / delta + 2;
                else h = (r - g) / delta + 4;
                h *= 60;
            }
            const s = maxc > 1e-6 ? delta / maxc : 0;
            const v = maxc;
            let sq = Math.min(Math.max((s - 0.05) / 0.2, 0), 1);
            sq = sq * sq * (3 - 2 * sq);
            const conf = sq * Math.min(Math.max(v / 0.06, 0), 1);
            if (maskBand >= 0) {
                // vista de mascara: blanco = zona aislada de la banda
                const dd = Math.abs(((h - SEC_CENTERS[maskBand] + 540) % 360) - 180);
                let t = Math.min(Math.max(1 - dd / 60, 0), 1);
                const w = t * t * (3 - 2 * t) * conf;
                dst[i] = dst[i + 1] = dst[i + 2] = w * 255;
                dst[i + 3] = src[i + 3];
                continue;
            }
            let hshift = 0, smul = 1, vmul = 1;
            for (const [c, hs2, sm2, lm2] of secList) {
                const dd = Math.abs(((h - c + 540) % 360) - 180);
                let t = Math.min(Math.max(1 - dd / 60, 0), 1);
                const w = t * t * (3 - 2 * t) * conf;
                hshift += w * hs2;
                smul *= 1 + w * (sm2 - 1);
                vmul *= 1 + w * (lm2 - 1);
            }
            let h2 = (h + hshift) % 360;
            if (h2 < 0) h2 += 360;
            const s2 = Math.min(Math.max(s * smul, 0), 1);
            const v2 = Math.min(Math.max(v * vmul, 0), 1);
            const hh = h2 / 60;
            const i6 = Math.floor(hh) % 6;
            const f = hh - Math.floor(hh);
            const pp = v2 * (1 - s2), qq = v2 * (1 - s2 * f), tt = v2 * (1 - s2 * (1 - f));
            if (i6 === 0) { r = v2; g = tt; b = pp; }
            else if (i6 === 1) { r = qq; g = v2; b = pp; }
            else if (i6 === 2) { r = pp; g = v2; b = tt; }
            else if (i6 === 3) { r = pp; g = qq; b = v2; }
            else if (i6 === 4) { r = tt; g = pp; b = v2; }
            else { r = v2; g = pp; b = qq; }
        }

        dst[i] = r * 255;
        dst[i + 1] = g * 255;
        dst[i + 2] = b * 255;
        dst[i + 3] = src[i + 3];
    }
}

app.registerExtension({
    name: "comfy.ERColorCorrect",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // logo en la barra de título
        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        // en cada redibujado, el visor se ajusta al tamano actual del nodo
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFitCC?.();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this); // colores de marca en barra de título y cuerpo
            const node = this;

            let aspect = 16 / 9;
            let srcImage = null;
            let outImage = null;
            let rafId = null;
            let lastApplied = null;
            let showOriginal = false;

            // el widget "wheels" (STRING) guarda las tres ruedas; va oculto
            const wheelsWidget = node.widgets?.find((w) => w.name === "wheels");
            if (wheelsWidget) {
                wheelsWidget.type = "hidden";
                wheelsWidget.computeSize = () => [0, -4];
                wheelsWidget.hidden = true;
            }
            // widget oculto con los parametros en JSON (UI de paneles)
            const paramsW = node.widgets?.find((w) => w.name === "params");
            if (paramsW) {
                paramsW.type = "hidden";
                paramsW.computeSize = () => [0, -4];
                paramsW.hidden = true;
            }
            const getP = () => {
                try {
                    const d = JSON.parse(paramsW?.value || "{}");
                    if (d && typeof d === "object" && !Array.isArray(d)) return { ...DEFAULTS, ...d };
                } catch (e) {}
                return { ...DEFAULTS };
            };
            const saveP = (p) => {
                if (paramsW) paramsW.value = JSON.stringify(p);
            };
            const getWheels = () => {
                try {
                    const d = JSON.parse(wheelsWidget?.value || "[[0,0],[0,0],[0,0]]");
                    if (Array.isArray(d) && d.length === 3) return d.map((w) => [Number(w[0]) || 0, Number(w[1]) || 0]);
                } catch (e) {}
                return [[0, 0], [0, 0], [0, 0]];
            };
            const setWheel = (i, angle, radius) => {
                const d = getWheels();
                d[i] = [Math.round(angle), Math.round(radius * 1000) / 1000];
                if (wheelsWidget) wheelsWidget.value = JSON.stringify(d);
            };

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui"; // fuente y color de texto de la marca
            root.style.cssText =
                "width:100%;display:flex;flex-direction:column;gap:6px;";

            const stage = document.createElement("div");
            stage.className = "er-viewer"; // pozo oscuro del visor
            stage.style.cssText =
                "position:relative;width:100%;flex:0 0 auto;overflow:hidden;" +
                "display:none;";
            const canvas = document.createElement("canvas");
            canvas.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
            stage.appendChild(canvas);

            // panel plegable con la fila de wheels (ocupan mucho: plegables)
            const wheelsPanel = document.createElement("div");
            wheelsPanel.className = "er-panel";
            wheelsPanel.style.cssText =
                "display:none;flex-direction:column;gap:4px;padding:5px 7px;flex:0 0 auto;";
            const wHead = document.createElement("div");
            wHead.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
            const wFold = document.createElement("button");
            wFold.className = "er-btn";
            wFold.title = "Expand/collapse";
            wFold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
            const wTitle = document.createElement("span");
            wTitle.className = "er-title";
            wTitle.textContent = "Wheels";
            wTitle.style.cssText = "flex:1;";
            wHead.append(wFold, wTitle);
            const wheelsRow = document.createElement("div");
            wheelsRow.style.cssText =
                "display:flex;justify-content:space-evenly;align-items:flex-start;gap:6px;";
            wheelsPanel.append(wHead, wheelsRow);
            const applyWheelsFold = () => {
                const open = getP()._wheels !== false; // abiertas por defecto
                wFold.textContent = open ? "▾" : "▸";
                wheelsRow.style.display = open ? "flex" : "none";
            };
            const wToggle = (e) => {
                e.stopPropagation();
                const p = getP();
                p._wheels = !(p._wheels !== false);
                saveP(p);
                applyWheelsFold();
            };
            wHead.addEventListener("pointerdown", (e) => e.stopPropagation());
            wFold.addEventListener("pointerdown", (e) => e.stopPropagation());
            wFold.addEventListener("click", wToggle);
            wTitle.addEventListener("click", wToggle);
            applyWheelsFold();

            const wheelCanvases = [];
            const drawWheelFns = [];
            WHEELS.forEach((label, wi) => {
                const col = document.createElement("div");
                col.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px;";
                const wheel = document.createElement("canvas");
                wheel.width = WHEEL_SIZE;
                wheel.height = WHEEL_SIZE;
                wheel.title = `${label}: drag to tint, double click to reset`;
                wheel.style.cssText = `width:${WHEEL_SIZE}px;height:${WHEEL_SIZE}px;display:block;cursor:crosshair;`;
                const tag = document.createElement("div");
                tag.textContent = label;
                tag.className = "er-title"; // etiqueta cian en mayúsculas
                tag.style.cssText = "font-size:10px;user-select:none;";
                col.append(wheel, tag);
                wheelsRow.appendChild(col);
                wheelCanvases.push(wheel);

                const wctx = wheel.getContext("2d");
                const drawWheel = () => {
                    const S = WHEEL_SIZE;
                    const cx = S / 2;
                    const R = S / 2 - 2;
                    const img = wctx.createImageData(S, S);
                    const d = img.data;
                    for (let y = 0; y < S; y++) {
                        for (let x = 0; x < S; x++) {
                            const dx = x - cx;
                            const dy = y - cx;
                            const dist = Math.sqrt(dx * dx + dy * dy);
                            const i = (y * S + x) * 4;
                            if (dist > R) continue;
                            const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
                            const [r, g, b] = hsvToRgb(ang);
                            const sat = Math.min(dist / R, 1);
                            d[i] = (1 - sat + sat * r) * 255;
                            d[i + 1] = (1 - sat + sat * g) * 255;
                            d[i + 2] = (1 - sat + sat * b) * 255;
                            d[i + 3] = dist > R - 1.5 ? 255 * (R - dist + 0.5) : 255;
                        }
                    }
                    wctx.putImageData(img, 0, 0);
                    const [angle, radius] = getWheels()[wi];
                    const a = (angle * Math.PI) / 180;
                    const px = cx + Math.cos(a) * radius * R;
                    const py = cx + Math.sin(a) * radius * R;
                    wctx.beginPath();
                    wctx.arc(px, py, 4.5, 0, Math.PI * 2);
                    wctx.fillStyle = radius > 0.01 ? "#222" : "rgba(34,34,34,0.35)";
                    wctx.fill();
                    wctx.lineWidth = 1.5;
                    wctx.strokeStyle = "#fff";
                    wctx.stroke();
                };
                drawWheelFns.push(drawWheel);

                const fromEvent = (e) => {
                    const r = wheel.getBoundingClientRect();
                    const cx2 = r.width / 2;
                    const dx = e.clientX - r.left - cx2;
                    const dy = e.clientY - r.top - cx2;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    const radius = Math.min(dist / (r.width / 2 - 2), 1);
                    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
                    setWheel(wi, angle, radius);
                    drawWheel();
                };
                wheel.addEventListener("pointerdown", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    wheel._dragging = true;
                    fromEvent(e);
                    try {
                        wheel.setPointerCapture(e.pointerId);
                    } catch (err) {}
                });
                wheel.addEventListener("pointermove", (e) => {
                    if (wheel._dragging) fromEvent(e);
                });
                wheel.addEventListener("pointerup", (e) => {
                    try {
                        wheel.releasePointerCapture(e.pointerId);
                    } catch (err) {}
                    wheel._dragging = false;
                });
                wheel.addEventListener("dblclick", (e) => {
                    e.stopPropagation();
                    setWheel(wi, 0, 0);
                    drawWheel();
                });
            });
            const drawAllWheels = () => drawWheelFns.forEach((f) => f());

            // botones
            const controls = document.createElement("div");
            controls.style.cssText = "display:none;align-items:center;gap:6px;flex:0 0 auto;";
            const mkBtn = (text, title) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.title = title;
                b.className = "er-btn"; // botón de marca; se conserva el tamaño original
                b.style.cssText =
                    "height:20px;font-size:10px;line-height:1;padding:0 10px;";
                return b;
            };
            const resetBtn = mkBtn("Reset", "Reset all parameters and wheels");
            const origBtn = mkBtn("👁 Original", "Hold to see the original image");
            controls.append(resetBtn, origBtn);

            // ---------- vectorscopio (traza en vivo + linea de piel) ----------
            const SCOPE_S = 240;
            const scopePanel = document.createElement("div");
            scopePanel.className = "er-panel";
            scopePanel.style.cssText =
                "display:none;flex-direction:column;gap:4px;padding:5px 7px;flex:0 0 auto;";
            const sHead = document.createElement("div");
            sHead.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
            const sFold = document.createElement("button");
            sFold.className = "er-btn";
            sFold.title = "Expand/collapse";
            sFold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
            const sTitle = document.createElement("span");
            sTitle.className = "er-title";
            sTitle.textContent = "Vectorscope";
            sTitle.style.cssText = "flex:1;";
            const sNote = document.createElement("span");
            sNote.className = "er-dim";
            sNote.style.cssText = "font-size:9px;";
            sNote.textContent = "corrected trace · skin tone line";
            sHead.append(sFold, sTitle, sNote);
            const sBody = document.createElement("div");
            sBody.style.cssText = "display:none;justify-content:center;";
            const scope = document.createElement("canvas");
            scope.width = SCOPE_S;
            scope.height = SCOPE_S;
            scope.style.cssText = `width:${SCOPE_S}px;height:${SCOPE_S}px;display:block;`;
            sBody.appendChild(scope);
            scopePanel.append(sHead, sBody);
            const sctx = scope.getContext("2d");
            const scopeTmp = document.createElement("canvas");
            scopeTmp.width = SCOPE_S;
            scopeTmp.height = SCOPE_S;
            const scopeTmpCtx = scopeTmp.getContext("2d");

            const scopeOpen = () => getP()._scope === true;
            const applyScopeFold = () => {
                const open = scopeOpen();
                sFold.textContent = open ? "▾" : "▸";
                sBody.style.display = open ? "flex" : "none";
            };
            // Cb/Cr (BT.601), espejo del vectorscopio clasico
            const cbcr = (r, g, b) => [
                -0.168736 * r - 0.331264 * g + 0.5 * b,
                0.5 * r - 0.418688 * g - 0.081312 * b,
            ];
            // retícula con diseño propio ER (el vectorscopio es un
            // instrumento estandar SMPTE; la estetica aqui es nuestra):
            // cian de marca, dianas circulares tintadas por banda, hexagono
            // de referencia y linea de piel discontinua
            const scopeGrid = () => {
                const S = SCOPE_S, cx = S / 2, R = S / 2 - 10;
                sctx.globalCompositeOperation = "source-over";
                sctx.fillStyle = "#141414";
                sctx.fillRect(0, 0, S, S);
                // pozo circular
                sctx.fillStyle = "#0d0d0d";
                sctx.beginPath();
                sctx.arc(cx, cx, R + 6, 0, Math.PI * 2);
                sctx.fill();
                // anillos discontinuos al 50/75 + circulo exterior cian tenue
                sctx.strokeStyle = "rgba(92,225,230,.14)";
                sctx.lineWidth = 1;
                sctx.setLineDash([3, 5]);
                for (const f of [0.5, 0.75]) {
                    sctx.beginPath();
                    sctx.arc(cx, cx, R * f, 0, Math.PI * 2);
                    sctx.stroke();
                }
                sctx.setLineDash([]);
                sctx.strokeStyle = "rgba(92,225,230,.30)";
                sctx.beginPath();
                sctx.arc(cx, cx, R, 0, Math.PI * 2);
                sctx.stroke();
                // cruz central corta (no de borde a borde)
                sctx.strokeStyle = "rgba(92,225,230,.18)";
                sctx.beginPath();
                sctx.moveTo(cx - 8, cx); sctx.lineTo(cx + 8, cx);
                sctx.moveTo(cx, cx - 8); sctx.lineTo(cx, cx + 8);
                sctx.stroke();
                // dianas al 75%: posiciones Cb/Cr reales, cada una tintada
                // con su propio color de banda, y hexagono de referencia
                const targets = [
                    ["R", 0.75, 0, 0, 0], ["Mg", 0.75, 0, 0.75, 300], ["B", 0, 0, 0.75, 240],
                    ["Cy", 0, 0.75, 0.75, 180], ["G", 0, 0.75, 0, 120], ["Yl", 0.75, 0.75, 0, 60],
                ];
                const pts = targets.map(([name, r, g, b, hdeg]) => {
                    const [cb, cr] = cbcr(r, g, b);
                    return [name, cx + cb * 2 * R, cx - cr * 2 * R, hdeg];
                });
                // hexagono tenue conectando las dianas (guia de gamut 75%)
                sctx.strokeStyle = "rgba(92,225,230,.10)";
                sctx.beginPath();
                pts.forEach(([, x, y], i2) => (i2 ? sctx.lineTo(x, y) : sctx.moveTo(x, y)));
                sctx.closePath();
                sctx.stroke();
                sctx.font = "9px 'Trebuchet MS',sans-serif";
                for (const [name, x, y, hdeg] of pts) {
                    // anillo doble tintado con el color de la banda
                    sctx.strokeStyle = `hsla(${hdeg},70%,60%,.75)`;
                    sctx.beginPath();
                    sctx.arc(x, y, 4.5, 0, Math.PI * 2);
                    sctx.stroke();
                    sctx.strokeStyle = `hsla(${hdeg},70%,60%,.28)`;
                    sctx.beginPath();
                    sctx.arc(x, y, 8, 0, Math.PI * 2);
                    sctx.stroke();
                    sctx.fillStyle = `hsla(${hdeg},70%,65%,.8)`;
                    const ox = x > cx ? 11 : -11 - sctx.measureText(name).width;
                    sctx.fillText(name, x + ox, y + 3);
                }
                // linea del tono de piel (I-line, 123 grados): discontinua,
                // en cian de marca, con rombo en la punta
                const a = (123 * Math.PI) / 180;
                const ex = cx + Math.cos(a) * R;
                const ey = cx - Math.sin(a) * R;
                sctx.strokeStyle = "rgba(92,225,230,.6)";
                sctx.setLineDash([5, 4]);
                sctx.beginPath();
                sctx.moveTo(cx, cx);
                sctx.lineTo(ex, ey);
                sctx.stroke();
                sctx.setLineDash([]);
                sctx.fillStyle = "rgba(92,225,230,.85)";
                sctx.save();
                sctx.translate(ex, ey);
                sctx.rotate(Math.PI / 4);
                sctx.fillRect(-3, -3, 6, 6);
                sctx.restore();
                sctx.fillText("skin", cx + Math.cos(a) * R * 0.8 + 5, cx - Math.sin(a) * R * 0.8);
            };
            const drawScope = () => {
                if (!scopeOpen() || !srcImage) return;
                const buf = showOriginal || !outImage ? srcImage : outImage;
                scopeGrid();
                const S = SCOPE_S, cx = S / 2, R = S / 2 - 10;
                const img = scopeTmpCtx.createImageData(S, S);
                const d = img.data;
                const data = buf.data;
                // muestreo limitado (~45k px) para mantenerlo fluido
                const stride = Math.max(1, Math.round(data.length / 4 / 45000)) * 4;
                for (let i = 0; i < data.length; i += stride) {
                    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
                    const [cb, cr] = cbcr(r, g, b);
                    const x = Math.round(cx + cb * 2 * R);
                    const y = Math.round(cx - cr * 2 * R);
                    if (x < 0 || y < 0 || x >= S || y >= S) continue;
                    const j = (y * S + x) * 4;
                    d[j] = Math.min(255, d[j] + 34 + r * 70);
                    d[j + 1] = Math.min(255, d[j + 1] + 34 + g * 70);
                    d[j + 2] = Math.min(255, d[j + 2] + 34 + b * 70);
                    d[j + 3] = 255;
                }
                scopeTmpCtx.putImageData(img, 0, 0);
                sctx.globalCompositeOperation = "lighter";
                sctx.drawImage(scopeTmp, 0, 0);
                sctx.globalCompositeOperation = "source-over";
            };
            const sToggle = (e) => {
                e.stopPropagation();
                const p = getP();
                p._scope = !(p._scope === true);
                saveP(p);
                applyScopeFold();
                drawScope();
            };
            sHead.addEventListener("pointerdown", (e) => e.stopPropagation());
            sFold.addEventListener("pointerdown", (e) => e.stopPropagation());
            sFold.addEventListener("click", sToggle);
            sTitle.addEventListener("click", sToggle);
            applyScopeFold();

            // ---------- secundarias: aislar y corregir bandas de color ----------
            let selBand = 0;
            let maskOn = false;
            let maskBand = -1;
            const getSec = () => {
                const s = getP().sec;
                return s && typeof s === "object" && !Array.isArray(s) ? s : {};
            };
            const secPanel = document.createElement("div");
            secPanel.className = "er-panel";
            secPanel.style.cssText =
                "display:flex;flex-direction:column;gap:4px;padding:5px 7px;flex:0 0 auto;";
            const cHead = document.createElement("div");
            cHead.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
            const cFold = document.createElement("button");
            cFold.className = "er-btn";
            cFold.title = "Expand/collapse";
            cFold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
            const cTitle = document.createElement("span");
            cTitle.className = "er-title";
            cTitle.textContent = "Secondaries";
            const cNote = document.createElement("span");
            cNote.className = "er-dim";
            cNote.style.cssText = "font-size:9px;flex:1;";
            cNote.textContent = "isolate reds, blues…";
            const maskBtn = document.createElement("button");
            maskBtn.className = "er-btn";
            maskBtn.textContent = "👁 Mask";
            maskBtn.title = "Preview the isolated band as a mask (white = affected)";
            maskBtn.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 8px;";
            const cReset = document.createElement("button");
            cReset.className = "er-btn";
            cReset.textContent = "⟲";
            cReset.title = "Reset every band";
            cReset.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
            cHead.append(cFold, cTitle, cNote, maskBtn, cReset);
            const cBody = document.createElement("div");
            cBody.style.cssText = "display:none;flex-direction:column;gap:5px;";
            // chips de banda (R Yl G Cy B Mg)
            const chipRow = document.createElement("div");
            chipRow.style.cssText = "display:flex;align-items:center;gap:6px;justify-content:center;";
            const chips = [];
            SEC_CENTERS.forEach((c, i) => {
                const chip = document.createElement("button");
                chip.title = `${SEC_NAMES[i]} band (${c}°)`;
                chip.textContent = SEC_NAMES[i];
                chip.style.cssText =
                    "width:30px;height:22px;font-size:9px;font-weight:bold;color:#111;" +
                    `background:hsl(${c},75%,55%);border:2px solid transparent;border-radius:4px;cursor:pointer;`;
                chip.addEventListener("pointerdown", (e) => e.stopPropagation());
                chip.addEventListener("click", (e) => {
                    e.stopPropagation();
                    selBand = i;
                    if (maskOn) maskBand = i;
                    refreshSecUI();
                });
                chipRow.appendChild(chip);
                chips.push(chip);
            });
            const secRows = document.createElement("div");
            secRows.style.cssText =
                "display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:3px 12px;";
            cBody.append(chipRow, secRows);
            secPanel.append(cHead, cBody);

            const bandVals = (i) => {
                const v = getSec()[String(i)];
                return Array.isArray(v) ? [Number(v[0]) || 0, v[1] ?? 1, v[2] ?? 1] : [0, 1, 1];
            };
            const setBandVal = (band, idx, val) => {
                const p = getP();
                const sec = { ...getSec() };
                const cur = bandVals(band);
                cur[idx] = val;
                // banda neutra: fuera del JSON (Python solo recibe lo tocado)
                if (Math.abs(cur[0]) < 1e-4 && Math.abs(cur[1] - 1) < 1e-4 && Math.abs(cur[2] - 1) < 1e-4) {
                    delete sec[String(band)];
                } else {
                    sec[String(band)] = cur;
                }
                p.sec = sec;
                saveP(p);
                refreshChipMarks();
            };
            const secRowEls = [];
            SEC_SLIDERS.forEach(([label, min, max, step, idx, dflt]) => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
                const tag = document.createElement("span");
                tag.className = "er-dim";
                tag.textContent = label;
                tag.style.cssText = "font-size:9px;width:56px;flex:0 0 auto;user-select:none;";
                const inp = document.createElement("input");
                inp.type = "range";
                inp.className = "er-range";
                inp.min = String(min);
                inp.max = String(max);
                inp.step = String(step);
                inp.title = label + " of the selected band (double click: reset)";
                inp.style.cssText = "flex:1;height:12px;cursor:pointer;min-width:30px;";
                const num = document.createElement("input");
                num.type = "number";
                num.className = "er-input";
                num.min = String(min);
                num.max = String(max);
                num.step = String(step);
                num.style.cssText = "width:48px;flex:0 0 auto;font-size:9px;padding:1px 3px;text-align:right;";
                const rst = document.createElement("button");
                rst.className = "er-btn";
                rst.textContent = "⟲";
                rst.title = "Reset " + label;
                rst.style.cssText = "height:16px;font-size:9px;line-height:1;padding:0 4px;flex:0 0 auto;";
                const push = (v, syncNum, syncRange) => {
                    const val = Math.min(max, Math.max(min, Number(v)));
                    setBandVal(selBand, idx, val);
                    if (syncNum) num.value = String(val);
                    if (syncRange) inp.value = String(val);
                };
                for (const el of [inp, num, rst]) {
                    el.addEventListener("pointerdown", (e) => e.stopPropagation());
                }
                num.addEventListener("keydown", (e) => e.stopPropagation());
                inp.addEventListener("input", () => push(inp.value, true, false));
                num.addEventListener("input", () => push(num.value, false, true));
                inp.addEventListener("dblclick", (e) => {
                    e.stopPropagation();
                    push(dflt, true, true);
                });
                rst.addEventListener("click", (e) => {
                    e.stopPropagation();
                    push(dflt, true, true);
                });
                wrap.append(tag, inp, num, rst);
                secRows.appendChild(wrap);
                secRowEls.push([inp, num]);
            });
            const refreshChipMarks = () => {
                chips.forEach((chip, i) => {
                    const touched = !!getSec()[String(i)];
                    chip.style.border = i === selBand ? "2px solid #fff" : "2px solid transparent";
                    chip.style.boxShadow = touched ? "0 0 6px hsl(" + SEC_CENTERS[i] + ",90%,60%)" : "none";
                    chip.style.opacity = i === selBand || touched ? "1" : "0.65";
                });
            };
            const refreshSecUI = () => {
                const vals = bandVals(selBand);
                SEC_SLIDERS.forEach(([, , , , idx], ri) => {
                    secRowEls[ri][0].value = String(vals[idx]);
                    secRowEls[ri][1].value = String(vals[idx]);
                });
                maskBtn.classList.toggle("er-active", maskOn);
                refreshChipMarks();
            };
            const applySecFold = () => {
                const open = getP()._sec === true; // cerrado por defecto
                cFold.textContent = open ? "▾" : "▸";
                cBody.style.display = open ? "flex" : "none";
            };
            const cToggle = (e) => {
                e.stopPropagation();
                const p = getP();
                p._sec = !(p._sec === true);
                saveP(p);
                applySecFold();
            };
            cHead.addEventListener("pointerdown", (e) => e.stopPropagation());
            cFold.addEventListener("pointerdown", (e) => e.stopPropagation());
            maskBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            cReset.addEventListener("pointerdown", (e) => e.stopPropagation());
            cFold.addEventListener("click", cToggle);
            cTitle.addEventListener("click", cToggle);
            cNote.addEventListener("click", cToggle);
            maskBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                maskOn = !maskOn;
                maskBand = maskOn ? selBand : -1;
                refreshSecUI();
            });
            cReset.addEventListener("click", (e) => {
                e.stopPropagation();
                const p = getP();
                p.sec = {};
                saveP(p);
                refreshSecUI();
            });
            applySecFold();
            refreshSecUI();

            // ---------- paneles plegables ----------
            const groupsBox = document.createElement("div");
            groupsBox.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;";
            const stopEv = (el) => el.addEventListener("pointerdown", (e) => e.stopPropagation());

            const rebuildPanels = () => {
                groupsBox.innerHTML = "";
                const p = getP();
                CC_GROUPS.forEach(([gtitle, sliders], gi) => {
                    const open = p._open?.[gi] !== false;
                    const box = document.createElement("div");
                    box.className = "er-panel";
                    box.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:5px 7px;";
                    const head = document.createElement("div");
                    head.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
                    const fold = document.createElement("button");
                    fold.className = "er-btn";
                    fold.textContent = open ? "▾" : "▸";
                    fold.title = "Expand/collapse";
                    fold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
                    const title = document.createElement("span");
                    title.className = "er-title";
                    title.textContent = gtitle;
                    title.style.cssText = "flex:1;";
                    const greset = document.createElement("button");
                    greset.className = "er-btn";
                    greset.textContent = "⟲";
                    greset.title = "Reset this group";
                    greset.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
                    head.append(fold, title, greset);
                    const body = document.createElement("div");
                    body.style.cssText =
                        `display:${open ? "grid" : "none"};grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:3px 12px;`;
                    for (const [key, label, min, max, step] of sliders) {
                        const wrap = document.createElement("div");
                        wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
                        const tag = document.createElement("span");
                        tag.className = "er-dim";
                        tag.textContent = label;
                        tag.style.cssText = "font-size:9px;width:56px;flex:0 0 auto;user-select:none;";
                        const inp = document.createElement("input");
                        inp.type = "range";
                        inp.className = "er-range";
                        inp.min = String(min);
                        inp.max = String(max);
                        inp.step = String(step);
                        inp.value = String(p[key]);
                        inp.title = label + " (double click: reset)";
                        inp.style.cssText = "flex:1;height:12px;cursor:pointer;min-width:30px;";
                        const num = document.createElement("input");
                        num.type = "number";
                        num.className = "er-input";
                        num.min = String(min);
                        num.max = String(max);
                        num.step = String(step);
                        num.value = String(p[key]);
                        num.style.cssText = "width:48px;flex:0 0 auto;font-size:9px;padding:1px 3px;text-align:right;";
                        const rst = document.createElement("button");
                        rst.className = "er-btn";
                        rst.textContent = "⟲";
                        rst.title = "Reset " + label;
                        rst.style.cssText = "height:16px;font-size:9px;line-height:1;padding:0 4px;flex:0 0 auto;";
                        const push = (v, syncNum, syncRange) => {
                            const val = Math.min(max, Math.max(min, Number(v)));
                            const p2 = getP();
                            p2[key] = val;
                            saveP(p2);
                            if (syncNum) num.value = String(val);
                            if (syncRange) inp.value = String(val);
                        };
                        stopEv(inp);
                        stopEv(num);
                        stopEv(rst);
                        num.addEventListener("keydown", (e) => e.stopPropagation());
                        inp.addEventListener("input", () => push(inp.value, true, false));
                        num.addEventListener("input", () => push(num.value, false, true));
                        inp.addEventListener("dblclick", (e) => {
                            e.stopPropagation();
                            push(DEFAULTS[key], true, true);
                        });
                        rst.addEventListener("click", (e) => {
                            e.stopPropagation();
                            push(DEFAULTS[key], true, true);
                        });
                        wrap.append(tag, inp, num, rst);
                        body.appendChild(wrap);
                    }
                    box.append(head, body);
                    groupsBox.appendChild(box);
                    stopEv(fold);
                    stopEv(greset);
                    stopEv(head);
                    const toggle = (e) => {
                        e.stopPropagation();
                        const p2 = getP();
                        p2._open = p2._open || {};
                        p2._open[gi] = !(p2._open[gi] !== false);
                        saveP(p2);
                        rebuildPanels();
                    };
                    fold.addEventListener("click", toggle);
                    title.addEventListener("click", toggle);
                    greset.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const p2 = getP();
                        for (const [key] of sliders) p2[key] = DEFAULTS[key];
                        saveP(p2);
                        rebuildPanels();
                    });
                });
            };
            rebuildPanels();

            root.append(stage, scopePanel, groupsBox, secPanel, wheelsPanel, controls);

            const widget = node.addDOMWidget("er_cc_preview", "ER_CC", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima; el contenido se adapta luego al tamano real del
            // nodo (el layout de widgets DOM del frontend nuevo no reserva el
            // alto pedido y el contenido desbordaba el nodo, robando los
            // clics del lienzo alrededor)
            const EXTRA_H = WHEEL_SIZE + 52; // ruedas + botones + separaciones
            widget.computeSize = function (width) {
                if (stage.style.display === "none") return [width, -4];
                return [width, EXTRA_H + 120];
            };

            // Ajuste con realimentacion + aspecto bloqueado: el visor mide el
            // desborde real respecto al borde inferior del nodo Y ademas
            // conserva SIEMPRE el aspecto de la imagen (sin bandas negras),
            // centrado si sobra anchura
            const updateStageHeight = () => {
                const rootW = root.clientWidth || root.getBoundingClientRect().width;
                if (!rootW) return; // sin layout aun
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
                if (stage.style.display === "none") {
                    // sin visor: la altura minima ya la garantiza el ajuste
                    // generico del tema (erMinFit) con medidas de layout;
                    // crecer aqui con rects de pantalla se disparaba cuando
                    // el overlay DOM iba un frame por detras del canvas
                    return;
                }
                const cur = parseFloat(stage.style.height) || stage.clientHeight || 200;
                const avail = Math.abs(delta) < 3 ? cur : Math.max(60, cur - delta);
                const h = Math.max(60, Math.min(avail, rootW / aspect));
                const hpx = `${Math.round(h)}px`;
                const wpx = `${Math.round(h * aspect)}px`;
                if (stage.style.height !== hpx) stage.style.height = hpx;
                if (stage.style.width !== wpx) stage.style.width = wpx;
                stage.style.alignSelf = "center";
            };
            node._erFitCC = updateStageHeight;
            new ResizeObserver(updateStageHeight).observe(root);
            const fitTimer = setInterval(updateStageHeight, 500);
            const onRemovedCC = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemovedCC?.apply(this, arguments);
            };

            // ---------- render ----------
            const ctx2d = canvas.getContext("2d");
            const getParams = () => {
                const p = getP();
                p.wheels = wheelsWidget?.value || "[[0,0],[0,0],[0,0]]";
                return p;
            };

            const render = () => {
                if (!srcImage) return;
                const p = getParams();
                if (showOriginal) {
                    ctx2d.putImageData(srcImage, 0, 0);
                    drawScope();
                    return;
                }
                const mat = Math.abs(p.hue) > 1e-6 ? hueMatrix(p.hue) : null;
                const tempG = Math.abs(p.temperature - 6500) > 1 ? temperatureGains(p.temperature) : null;
                const wheelG = getWheels().map(([a, r]) => tintToGains(a, r));
                correctPixels(srcImage.data, outImage.data, p, mat, tempG, wheelG, getSec(), maskBand);
                ctx2d.putImageData(outImage, 0, 0);
                drawScope();
            };

            const loop = () => {
                if (srcImage) {
                    const p = getParams();
                    const key =
                        PARAMS.map((n) => p[n]).join(",") + "|" + p.wheels +
                        (showOriginal ? "|o" : "") + "|" + JSON.stringify(getSec()) + "|" + maskBand;
                    if (key !== lastApplied) {
                        lastApplied = key;
                        render();
                    }
                }
                rafId = requestAnimationFrame(loop);
            };
            rafId = requestAnimationFrame(loop);

            // ---------- botones ----------
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const p = getP();
                saveP({ ...DEFAULTS, _open: p._open || {}, _scope: p._scope, _sec: p._sec, _wheels: p._wheels });
                if (wheelsWidget) wheelsWidget.value = "[[0,0],[0,0],[0,0]]";
                rebuildPanels();
                drawAllWheels();
                refreshSecUI();
                node.setDirtyCanvas(true, true);
            });
            const setOriginal = (v) => {
                showOriginal = v;
                origBtn.classList.toggle("er-active", v); // estado activo en cian
                abBtn.classList.toggle("er-active", v);
            };
            // comparador antes/despues: UN clic alterna original / procesado
            const abBtn = document.createElement("button");
            abBtn.className = "er-btn";
            abBtn.textContent = "A|B";
            abBtn.title = "Toggle before/after";
            abBtn.style.cssText =
                "position:absolute;top:6px;right:6px;height:22px;font-size:11px;line-height:1;padding:0 8px;opacity:.85;";
            stage.appendChild(abBtn);
            abBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            abBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                setOriginal(!showOriginal);
            });
            origBtn.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                setOriginal(true);
            });
            origBtn.addEventListener("pointerup", () => setOriginal(false));
            origBtn.addEventListener("pointerleave", () => setOriginal(false));

            // ---------- carga de imagen ----------
            node.erSetImageURL = (url) => {
                const img = new Image();
                img.onload = () => {
                    const scale = Math.min(1, MAX_PREVIEW / Math.max(img.naturalWidth, img.naturalHeight));
                    const cw = Math.max(1, Math.round(img.naturalWidth * scale));
                    const ch = Math.max(1, Math.round(img.naturalHeight * scale));
                    canvas.width = cw;
                    canvas.height = ch;
                    aspect = cw / ch;
                    ctx2d.drawImage(img, 0, 0, cw, ch);
                    srcImage = ctx2d.getImageData(0, 0, cw, ch);
                    outImage = ctx2d.createImageData(cw, ch);
                    lastApplied = null;
                    stage.style.display = "block";
                    scopePanel.style.display = "flex";
                    wheelsPanel.style.display = "flex";
                    controls.style.display = "flex";
                    drawAllWheels();
                    // tamano por defecto agradable (respeta el aspecto); a
                    // partir de aqui el usuario escala libre y el contenido
                    // se ajusta via updateStageHeight
                    const wy = widget.y || 220;
                    const w = Math.max(node.size[0], 3 * WHEEL_SIZE + 60);
                    node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + EXTRA_H + 24)]);
                    updateStageHeight();
                    app.graph.setDirtyCanvas(true, true);
                };
                img.src = url;
            };
            node.erSetImage = (file) => node.erSetImageURL(viewURL(file));

            // carga automática al conectar, sin necesidad de ejecutar
            node.erTryAutoLoad = () => {
                const src = node.getInputNode?.(0);
                if (!src) return;
                const cached = app.nodeOutputs?.[String(src.id)];
                if (cached?.images?.length) {
                    node.erSetImage(cached.images[0]);
                    return;
                }
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
                        node.erSetImage({ filename: name, subfolder, type: "input" });
                        return;
                    }
                }
                if (src.imgs?.length && src.imgs[0].src) {
                    node.erSetImageURL(src.imgs[0].src);
                }
            };

            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, index, connected, linkInfo) {
                onConnectionsChange?.apply(this, arguments);
                if (type === LiteGraph.INPUT && index === 0 && connected) {
                    setTimeout(() => node.erTryAutoLoad(), 50);
                }
            };

            const onConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                onConfigure?.apply(this, arguments);
                node._erConfigured = true;
                setTimeout(() => {
                    // migracion desde el formato antiguo (7 widgets sueltos + wheels)
                    let ok = false;
                    try {
                        const d = JSON.parse(paramsW?.value || "");
                        ok = d && typeof d === "object" && !Array.isArray(d);
                    } catch (e) {}
                    if (!ok) {
                        const v = info?.widgets_values;
                        if (Array.isArray(v) && v.length >= 7 && typeof v[0] === "number") {
                            saveP({
                                ...DEFAULTS,
                                temperature: v[0], hue: v[1], saturation: v[2],
                                contrast: v[3], gamma: v[4], gain: v[5], offset: v[6],
                            });
                            if (typeof v[7] === "string" && wheelsWidget) wheelsWidget.value = v[7];
                        } else {
                            saveP({ ...DEFAULTS });
                        }
                    }
                    rebuildPanels();
                    drawAllWheels();
                    applyScopeFold();
                    applySecFold();
                    applyWheelsFold();
                    refreshSecUI();
                }, 300);
            };
            setTimeout(() => {
                if (!node._erConfigured && !paramsW?.value?.startsWith("{")) saveP({ ...DEFAULTS });
            }, 400);

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
            const file = message?.er_cc?.[0];
            if (file && this.erSetImage) this.erSetImage(file);
        };
    },
});
