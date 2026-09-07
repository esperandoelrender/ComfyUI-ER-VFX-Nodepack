import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const NODE_TYPE = "ERGlow";
const MAX_PREVIEW = 640;

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

// ---------------------------------------------------------------- parametros
// must stay in sync with DEFAULT_GLOW in Python
const DEFAULT_GLOW = {
    threshold: 0.7, knee: 0.25, highlight_gain: 1.0, luma_mode: 0,
    size: 1.5, octaves: 5, falloff: 0.6, aspect: 1.0,
    gain: 1.0, gamma: 1.0, saturation: 1.0,
    tint_hue: 40.0, tint_sat: 0.0, dispersion: 0.0,
    blend: 0, mix: 1.0, view: 0,
};

const LUMA_MODES = ["Rec709 luma", "Max RGB", "Average", "Per channel"];
const BLEND_MODES = ["Add", "Screen", "Max"];
const VIEW_MODES = ["Result", "Glow only", "Highlights"];

// [key, label, min, max, step] para sliders · [key, label, [opciones]] para selects
const GROUPS = [
    ["Highlights", [
        ["threshold", "Threshold", 0, 1, 0.005],
        ["knee", "Knee", 0, 1, 0.005],
        ["highlight_gain", "Boost", 0, 4, 0.01],
        ["luma_mode", "Extract", LUMA_MODES],
    ]],
    ["Shape", [
        ["size", "Size %", 0.05, 15, 0.05],
        ["octaves", "Octaves", 1, 8, 1],
        ["falloff", "Falloff", 0.1, 1.5, 0.01],
        ["aspect", "Anamorphic", 0.25, 4, 0.01],
    ]],
    ["Color", [
        ["gain", "Gain", 0, 4, 0.01],
        ["gamma", "Gamma", 0.2, 4, 0.01],
        ["saturation", "Saturation", 0, 2, 0.01],
        ["tint_hue", "Tint hue", 0, 360, 1],
        ["tint_sat", "Tint amount", 0, 1, 0.01],
        ["dispersion", "Dispersion", 0, 1, 0.01],
    ]],
    ["Composite", [
        ["blend", "Blend", BLEND_MODES],
        ["mix", "Mix", 0, 1, 0.01],
        ["view", "View", VIEW_MODES],
    ]],
];

// constantes de la piramide: sync with the Python constants
const SIGMA_LOCAL = 2.0;
const MAX_LEVEL = 8;

function levelFor(sigma) {
    if (sigma <= SIGMA_LOCAL) return 0;
    return Math.min(MAX_LEVEL, Math.round(Math.log2(sigma / SIGMA_LOCAL)));
}

function hsv(hDeg, s) {
    let h = ((((hDeg % 360) + 360) % 360) / 60);
    const x = 1 - Math.abs((h % 2) - 1);
    let c;
    if (h < 1) c = [1, x, 0];
    else if (h < 2) c = [x, 1, 0];
    else if (h < 3) c = [0, 1, x];
    else if (h < 4) c = [0, x, 1];
    else if (h < 5) c = [x, 0, 1];
    else c = [1, 0, x];
    return c.map((v) => 1 - s * (1 - v));
}

// ------------------------------------------------------------------- shaders

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// espejo de _highlights en Python (umbral con rodilla suave)
const FRAG_EXTRACT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_thr, u_knee, u_gain, u_wscale;
uniform int u_mode;
void main() {
    vec3 img = texture2D(u_tex, v_uv).rgb;
    vec3 v;
    if (u_mode == 1) v = vec3(max(img.r, max(img.g, img.b)));
    else if (u_mode == 2) v = vec3((img.r + img.g + img.b) / 3.0);
    else if (u_mode == 3) v = img;
    else v = vec3(dot(img, vec3(0.2126, 0.7152, 0.0722)));
    float kn = max(u_knee, 1e-4);
    vec3 soft = clamp(v - u_thr + kn, 0.0, 2.0 * kn);
    soft = soft * soft / (4.0 * kn);
    vec3 contrib = max(max(soft, v - u_thr) / max(v, vec3(1e-4)), 0.0);
    gl_FragColor = vec4(img * contrib * u_gain * u_wscale, 1.0);
}`;

// downsample 2x por media de 4 texeles (= avg_pool2d(2) en Python)
const FRAG_DOWN = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
void main() {
    vec2 o = u_texel * 0.5;
    gl_FragColor = 0.25 * (
        texture2D(u_tex, v_uv + vec2(-o.x, -o.y)) +
        texture2D(u_tex, v_uv + vec2( o.x, -o.y)) +
        texture2D(u_tex, v_uv + vec2(-o.x,  o.y)) +
        texture2D(u_tex, v_uv + vec2( o.x,  o.y)));
}`;

// gaussiana 1D separable; u_mul = tinte * peso de la octava (pase vertical)
const FRAG_BLUR = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
uniform float u_sigma;
uniform vec3 u_mul;
void main() {
    float s = max(u_sigma, 0.35);
    float lim = 3.0 * s + 0.5;
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -16; i <= 16; i++) {
        float x = float(i);
        if (abs(x) > lim) continue;
        float w = exp(-(x * x) / (2.0 * s * s));
        acc += w * texture2D(u_tex, v_uv + u_dir * x).rgb;
        wsum += w;
    }
    gl_FragColor = vec4(acc / wsum * u_mul, 1.0);
}`;

// espejo de _grade + mezcla en Python
const FRAG_COMP = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_src, u_acc, u_hl;
uniform float u_gamma, u_sat, u_gain, u_mix, u_rscale, u_ab;
uniform int u_blend, u_view;
void main() {
    vec3 img = texture2D(u_src, v_uv).rgb;
    // comparador A/B: original intacto
    if (u_ab > 0.5) {
        gl_FragColor = vec4(img, 1.0);
        return;
    }
    if (u_view == 2) {
        gl_FragColor = vec4(clamp(texture2D(u_hl, v_uv).rgb * u_rscale, 0.0, 1.0), 1.0);
        return;
    }
    vec3 g = max(texture2D(u_acc, v_uv).rgb * u_rscale, 0.0);
    if (abs(u_gamma - 1.0) > 1e-4) g = pow(g, vec3(1.0 / max(u_gamma, 0.05)));
    float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = max(vec3(l) + (g - vec3(l)) * u_sat, 0.0) * u_gain;
    if (u_view == 1) {
        gl_FragColor = vec4(clamp(g * u_mix, 0.0, 1.0), 1.0);
        return;
    }
    vec3 res;
    if (u_blend == 1) res = 1.0 - (1.0 - img) * (1.0 - clamp(g, 0.0, 1.0));
    else if (u_blend == 2) res = max(img, g);
    else res = img + g;
    gl_FragColor = vec4(clamp(mix(img, res, u_mix), 0.0, 1.0), 1.0);
}`;

// ------------------------------------------------------------ pipeline WebGL

function initGL(canvas) {
    // se prefiere WebGL2 + coma flotante: el glow acumula por encima de 1.0
    let gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
    let internal = null;
    let type = null;
    if (gl) {
        if (gl.getExtension("EXT_color_buffer_float")) {
            internal = gl.RGBA16F;
            type = gl.HALF_FLOAT;
        }
    } else {
        // ojo: una vez pedido webgl2 no se puede pedir webgl en el mismo canvas
        gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
        if (!gl) return null;
        const half = gl.getExtension("OES_texture_half_float");
        if (half && gl.getExtension("EXT_color_buffer_half_float") &&
            gl.getExtension("OES_texture_half_float_linear")) {
            internal = gl.RGBA;
            type = half.HALF_FLOAT_OES;
        }
    }
    // sin coma flotante: RGBA8 con margen (se escribe /4 y se lee *4)
    const isFloat = internal !== null;
    if (!isFloat) {
        internal = gl.RGBA;
        type = gl.UNSIGNED_BYTE;
    }
    const wscale = isFloat ? 1.0 : 0.25;

    const compile = (kind, src) => {
        const s = gl.createShader(kind);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error("[ERGlow]", gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT);
    const program = (fragSrc) => {
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error("[ERGlow]", gl.getProgramInfoLog(prog));
            return null;
        }
        const u = {};
        const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const info = gl.getActiveUniform(prog, i);
            u[info.name.replace("[0]", "")] = gl.getUniformLocation(prog, info.name);
        }
        return { prog, u, loc: gl.getAttribLocation(prog, "a_pos") };
    };

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const newTex = (w, h, src) => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        for (const [k, v] of [
            [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
            [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
            [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
            [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
        ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
        if (src) {
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
        }
        return t;
    };
    const newTarget = (w, h) => {
        const tex = newTex(w, h, null);
        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return { tex, fbo, w, h };
    };

    const G = {
        gl,
        wscale,
        srcTex: null,
        levels: [],   // piramide de luces altas (0 = resolucion completa)
        tmps: [],     // temporales del pase horizontal, uno por nivel
        acc: null,
        size: [0, 0],
        pExtract: program(FRAG_EXTRACT),
        pDown: program(FRAG_DOWN),
        pBlur: program(FRAG_BLUR),
        pComp: program(FRAG_COMP),
    };
    if (!G.pExtract || !G.pDown || !G.pBlur || !G.pComp) return null;

    G.use = (p, target) => {
        gl.useProgram(p.prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.enableVertexAttribArray(p.loc);
        gl.vertexAttribPointer(p.loc, 2, gl.FLOAT, false, 0, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
        const w = target ? target.w : canvas.width;
        const h = target ? target.h : canvas.height;
        gl.viewport(0, 0, w, h);
    };
    G.bindTex = (unit, tex, loc) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc, unit);
    };
    G.draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

    // piramide + acumulador al tamano actual del canvas
    G.ensure = () => {
        const W = canvas.width, H = canvas.height;
        if (G.size[0] === W && G.size[1] === H) return;
        for (const t of [...G.levels, ...G.tmps, G.acc]) {
            if (!t) continue;
            gl.deleteTexture(t.tex);
            gl.deleteFramebuffer(t.fbo);
        }
        G.levels = [];
        G.tmps = [];
        let w = W, h = H;
        for (let i = 0; i <= MAX_LEVEL; i++) {
            G.levels.push(newTarget(w, h));
            G.tmps.push(newTarget(w, h));
            if (Math.min(w, h) < 4) break;   // igual que el corte en Python
            w = Math.max(1, w >> 1);
            h = Math.max(1, h >> 1);
        }
        G.acc = newTarget(W, H);
        G.size = [W, H];
    };

    G.setImage = (im) => {
        if (G.srcTex) gl.deleteTexture(G.srcTex);
        G.srcTex = newTex(0, 0, im);
    };

    G.render = (p) => {
        if (!G.srcTex) return;
        G.ensure();
        const W = canvas.width;
        const octaves = Math.max(1, Math.min(8, Math.round(p.octaves)));
        const sigmaMax = Math.max(0.3, (p.size / 100) * W);
        const a = Math.sqrt(Math.max(0.05, p.aspect));
        const maxLvl = G.levels.length - 1;

        // 1) luces altas
        G.use(G.pExtract, G.levels[0]);
        G.bindTex(0, G.srcTex, G.pExtract.u.u_tex);
        gl.uniform1f(G.pExtract.u.u_thr, p.threshold);
        gl.uniform1f(G.pExtract.u.u_knee, p.knee);
        gl.uniform1f(G.pExtract.u.u_gain, p.highlight_gain);
        gl.uniform1f(G.pExtract.u.u_wscale, G.wscale);
        gl.uniform1i(G.pExtract.u.u_mode, Math.round(p.luma_mode));
        G.draw();

        // 2) niveles necesarios de la piramide
        const sigmas = [];
        let need = 0;
        for (let i = 0; i < octaves; i++) {
            const up = octaves - 1 - i;                    // 0 = octava mas grande
            const sigma = sigmaMax / Math.pow(2, up);
            const lvl = Math.min(levelFor(sigma), maxLvl);
            need = Math.max(need, lvl);
            sigmas.push([lvl, sigma / Math.pow(2, lvl), up]);
        }
        for (let i = 1; i <= need; i++) {
            const src = G.levels[i - 1];
            G.use(G.pDown, G.levels[i]);
            G.bindTex(0, src.tex, G.pDown.u.u_tex);
            gl.uniform2f(G.pDown.u.u_texel, 1 / src.w, 1 / src.h);
            G.draw();
        }

        // 3) octavas acumuladas (aditivo, ya con peso y tinte)
        let wsum = 0;
        for (const [, , up] of sigmas) wsum += Math.pow(p.falloff, up);
        gl.bindFramebuffer(gl.FRAMEBUFFER, G.acc.fbo);
        gl.viewport(0, 0, G.acc.w, G.acc.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        for (const [lvl, slocal, up] of sigmas) {
            const lv = G.levels[lvl];
            const tmp = G.tmps[lvl];
            // horizontal, en la resolucion del nivel
            G.use(G.pBlur, tmp);
            gl.disable(gl.BLEND);
            G.bindTex(0, lv.tex, G.pBlur.u.u_tex);
            gl.uniform2f(G.pBlur.u.u_dir, 1 / lv.w, 0);
            gl.uniform1f(G.pBlur.u.u_sigma, slocal * a);
            gl.uniform3f(G.pBlur.u.u_mul, 1, 1, 1);
            G.draw();
            // vertical + subida a resolucion completa, sumando al acumulador
            const w = Math.pow(p.falloff, up) / Math.max(wsum, 1e-6);
            const col = hsv(p.tint_hue + p.dispersion * 55 * up,
                            Math.min(1, p.tint_sat + p.dispersion * 0.45));
            G.use(G.pBlur, G.acc);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            G.bindTex(0, tmp.tex, G.pBlur.u.u_tex);
            gl.uniform2f(G.pBlur.u.u_dir, 0, 1 / tmp.h);
            gl.uniform1f(G.pBlur.u.u_sigma, slocal / a);
            gl.uniform3f(G.pBlur.u.u_mul, col[0] * w, col[1] * w, col[2] * w);
            G.draw();
        }
        gl.disable(gl.BLEND);

        // 4) grade + mezcla a pantalla
        G.use(G.pComp, null);
        G.bindTex(0, G.srcTex, G.pComp.u.u_src);
        G.bindTex(1, G.acc.tex, G.pComp.u.u_acc);
        G.bindTex(2, G.levels[0].tex, G.pComp.u.u_hl);
        gl.uniform1f(G.pComp.u.u_gamma, p.gamma);
        gl.uniform1f(G.pComp.u.u_sat, p.saturation);
        gl.uniform1f(G.pComp.u.u_gain, p.gain);
        gl.uniform1f(G.pComp.u.u_mix, p.mix);
        gl.uniform1f(G.pComp.u.u_rscale, 1 / G.wscale);
        gl.uniform1f(G.pComp.u.u_ab, p._ab || 0);
        gl.uniform1i(G.pComp.u.u_blend, Math.round(p.blend));
        gl.uniform1i(G.pComp.u.u_view, Math.round(p.view));
        G.draw();
    };

    return G;
}

// ---------------------------------------------------------------- extension

app.registerExtension({
    name: "comfy.ERGlow",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

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
            erBrandNode(this);
            const node = this;
            let G = null;
            let imgLoaded = false;
            let lastKey = null;

            // widget oculto con los parametros en JSON
            const paramsW = node.widgets?.find((w) => w.name === "params");
            if (paramsW) {
                paramsW.type = "hidden";
                paramsW.computeSize = () => [0, -4];
                paramsW.hidden = true;
            }
            const getP = () => {
                try {
                    const d = JSON.parse(paramsW?.value || "{}");
                    if (d && typeof d === "object" && !Array.isArray(d)) return { ...DEFAULT_GLOW, ...d };
                } catch (e) {}
                return { ...DEFAULT_GLOW };
            };
            const saveP = (p) => {
                if (paramsW) paramsW.value = JSON.stringify(p);
            };

            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText = "width:100%;display:flex;flex-direction:column;gap:6px;";
            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText = "position:relative;width:100%;flex:0 0 auto;overflow:hidden;display:none;";
            const glCanvas = document.createElement("canvas");
            glCanvas.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
            stage.appendChild(glCanvas);
            root.appendChild(stage);

            // comparador antes/despues: UN clic alterna original / procesado
            let abOn = false;
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
                abOn = !abOn;
                abBtn.classList.toggle("er-active", abOn);
            });

            // aviso del modo de vista, sobre el visor
            const viewTag = document.createElement("div");
            viewTag.style.cssText =
                "position:absolute;top:6px;left:6px;font-size:9px;letter-spacing:1px;text-transform:uppercase;" +
                `padding:2px 7px;border-radius:5px;background:rgba(0,0,0,.55);color:${ER.accent};display:none;`;
            stage.appendChild(viewTag);

            // ---------- paneles plegables ----------
            const groupsBox = document.createElement("div");
            groupsBox.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;";
            root.appendChild(groupsBox);

            const stop = (el) => el.addEventListener("pointerdown", (e) => e.stopPropagation());

            const rebuildUI = () => {
                groupsBox.innerHTML = "";
                const p = getP();
                viewTag.style.display = Math.round(p.view) ? "block" : "none";
                viewTag.textContent = VIEW_MODES[Math.round(p.view)] || "";

                GROUPS.forEach(([gtitle, rows], gi) => {
                    const open = p._open?.[gi] !== false;  // abierto por defecto
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
                    const reset = document.createElement("button");
                    reset.className = "er-btn";
                    reset.textContent = "⟲";
                    reset.title = "Reset this group";
                    reset.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
                    head.append(fold, title, reset);

                    const body = document.createElement("div");
                    body.style.cssText =
                        `display:${open ? "grid" : "none"};` +
                        "grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:3px 12px;";

                    for (const row of rows) {
                        const [key, label] = row;
                        const isSelect = Array.isArray(row[2]);
                        const wrap = document.createElement("div");
                        wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
                        const tag = document.createElement("span");
                        tag.className = "er-dim";
                        tag.textContent = label;
                        tag.style.cssText = "font-size:9px;width:64px;flex:0 0 auto;user-select:none;";
                        wrap.appendChild(tag);

                        if (isSelect) {
                            const sel = document.createElement("select");
                            sel.className = "er-select";
                            sel.style.cssText = "flex:1;font-size:10px;padding:1px 4px;min-width:60px;";
                            row[2].forEach((name, idx) => {
                                const o = document.createElement("option");
                                o.value = String(idx);
                                o.textContent = name;
                                sel.appendChild(o);
                            });
                            sel.value = String(Math.round(p[key]));
                            stop(sel);
                            sel.addEventListener("change", () => {
                                const p2 = getP();
                                p2[key] = Number(sel.value);
                                saveP(p2);
                                if (key === "view") rebuildUI();
                            });
                            wrap.appendChild(sel);
                        } else {
                            const [, , min, max, step] = row;
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
                            num.style.cssText =
                                "width:44px;flex:0 0 auto;font-size:9px;padding:1px 3px;text-align:right;";
                            stop(inp);
                            stop(num);
                            num.addEventListener("keydown", (e) => e.stopPropagation());
                            const push = (v, syncNum, syncRange) => {
                                const val = Math.min(max, Math.max(min, Number(v)));
                                const p2 = getP();
                                p2[key] = val;
                                saveP(p2);
                                if (syncNum) num.value = String(val);
                                if (syncRange) inp.value = String(val);
                            };
                            inp.addEventListener("input", () => push(inp.value, true, false));
                            num.addEventListener("input", () => push(num.value, false, true));
                            inp.addEventListener("dblclick", (e) => {
                                e.stopPropagation();
                                push(DEFAULT_GLOW[key], true, true);
                            });
                            wrap.append(inp, num);
                        }
                        body.appendChild(wrap);
                    }

                    box.append(head, body);
                    groupsBox.appendChild(box);

                    stop(fold);
                    stop(reset);
                    stop(head);
                    const toggle = (e) => {
                        e.stopPropagation();
                        const p2 = getP();
                        p2._open = p2._open || {};
                        p2._open[gi] = !(p2._open[gi] !== false);
                        saveP(p2);
                        rebuildUI();
                    };
                    fold.addEventListener("click", toggle);
                    title.addEventListener("click", toggle);
                    reset.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const p2 = getP();
                        for (const row of rows) p2[row[0]] = DEFAULT_GLOW[row[0]];
                        saveP(p2);
                        rebuildUI();
                    });
                });
            };
            rebuildUI();

            const onConfigureG = node.onConfigure;
            node.onConfigure = function (info) {
                onConfigureG?.apply(this, arguments);
                node._erConfigured = true;
                setTimeout(() => {
                    let ok = false;
                    try {
                        const d = JSON.parse(paramsW?.value || "");
                        ok = d && typeof d === "object" && !Array.isArray(d);
                    } catch (e) {}
                    if (!ok) saveP({ ...DEFAULT_GLOW });
                    rebuildUI();
                }, 300);
            };
            setTimeout(() => {
                if (!node._erConfigured && !paramsW?.value?.startsWith("{")) saveP({ ...DEFAULT_GLOW });
            }, 400);

            const widget = node.addDOMWidget("er_glow_preview", "ER_GLOW", root, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = function (width) {
                return [width, 160];
            };

            // ajuste con realimentacion + aspecto bloqueado (sin bandas negras)
            const updateStageHeight = () => {
                if (stage.style.display === "none") return;
                const rootW = root.clientWidth || root.getBoundingClientRect().width;
                if (!rootW) return;
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
                const cur = parseFloat(stage.style.height) || stage.clientHeight || 200;
                const avail = Math.abs(delta) < 3 ? cur : Math.max(60, cur - delta);
                const aspect = glCanvas.width / Math.max(1, glCanvas.height);
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

            const render = () => {
                if (!G || !imgLoaded) return;
                G.render({ ...getP(), _ab: abOn ? 1 : 0 });
            };

            let rafId = null;
            const loop = () => {
                const key = JSON.stringify(getP()) + (abOn ? "|ab" : "");
                if (key !== lastKey) {
                    lastKey = key;
                    render();
                }
                rafId = requestAnimationFrame(loop);
            };

            node.erSetImageURL = (url) => {
                const im = new Image();
                im.onload = () => {
                    const s = Math.min(1, MAX_PREVIEW / Math.max(im.naturalWidth, im.naturalHeight));
                    glCanvas.width = Math.max(1, Math.round(im.naturalWidth * s));
                    glCanvas.height = Math.max(1, Math.round(im.naturalHeight * s));
                    if (!G) G = initGL(glCanvas);
                    if (!G) return;
                    G.setImage(im);
                    imgLoaded = true;
                    stage.style.display = "block";
                    lastKey = null;
                    const wy = widget.y || 220;
                    const w = Math.max(node.size[0], 340);
                    const aspect = glCanvas.width / glCanvas.height;
                    node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + 24)]);
                    updateStageHeight();
                    if (rafId === null) rafId = requestAnimationFrame(loop);
                    app.graph.setDirtyCanvas(true, true);
                };
                im.src = url;
            };
            node.erSetImage = (file) => node.erSetImageURL(viewURL(file));

            // carga automatica al conectar, sin necesidad de ejecutar
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
            node.onConnectionsChange = function (type, index, connected) {
                onConnectionsChange?.apply(this, arguments);
                if (connected) setTimeout(() => node.erTryAutoLoad(), 120);
            };
            setTimeout(() => node.erTryAutoLoad(), 800);

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (rafId !== null) cancelAnimationFrame(rafId);
                clearInterval(fitTimer);
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const file = message?.er_glow?.[0];
            if (file && this.erSetImage) this.erSetImage(file);
        };
    },
});
