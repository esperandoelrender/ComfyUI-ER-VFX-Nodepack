import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const NODE_TYPE = "ERRegrain";
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

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// espejo de apply_regrain en Python (mismo hash sin/fract y value noise)
const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_amount, u_size, u_color, u_response, u_seed, u_ab;

// permutacion estilo Ashima (mod 289): sin los artefactos de precision
// del hash clasico con sin(). Must stay in sync with Python.
float perm(float x) { return mod((x * 34.0 + 1.0) * x, 289.0); }
float hash2(float x, float y, float k) {
    float xx = mod(x + k * 31.0, 289.0);
    float yy = mod(y + k * 17.0, 289.0);
    return fract(perm(perm(xx) + yy) / 41.0);
}
float vnoise(vec2 pix, float size, float k) {
    vec2 c = floor(pix / size);
    vec2 f = pix / size - c;
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash2(c.x, c.y, k);
    float b = hash2(c.x + 1.0, c.y, k);
    float cc = hash2(c.x, c.y + 1.0, k);
    float d = hash2(c.x + 1.0, c.y + 1.0, k);
    return a + (b - a) * u.x + (cc - a) * u.y + (a - b - cc + d) * u.x * u.y - 0.5;
}
void main() {
    vec3 img = texture2D(u_tex, v_uv).rgb;
    // comparador A/B: original intacto
    if (u_ab > 0.5) {
        gl_FragColor = vec4(img, 1.0);
        return;
    }
    vec2 pix = v_uv * u_res;
    float k = u_seed;
    float mono = vnoise(pix, u_size, k * 3.0);
    vec3 noise;
    if (u_color > 0.0) {
        float nr = vnoise(pix, u_size, k * 3.0 + 1.0);
        float nb = vnoise(pix, u_size, k * 3.0 + 2.0);
        noise = vec3(mix(mono, nr, u_color), mono, mix(mono, nb, u_color));
    } else {
        noise = vec3(mono);
    }
    float luma = dot(img, vec3(0.2126, 0.7152, 0.0722));
    float w = 1.0 + u_response * (4.0 * luma * (1.0 - luma) - 1.0);
    gl_FragColor = vec4(clamp(img + u_amount * 0.6 * w * noise, 0.0, 1.0), 1.0);
}`;

function initGL(canvas) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    if (!gl) return null;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error("[ERRegrain]", gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, v] of [
        [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE],
        [gl.TEXTURE_MIN_FILTER, gl.LINEAR],
        [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
    ]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(prog, i);
        uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { gl, prog, tex, uniforms };
}

const DEFAULT_GRAIN = {
    amount: 0.25, grain_size: 1.6, color_amount: 0.3,
    response: 0.6, seed: 0, film_preset: "custom",
};
const SLIDERS = [
    ["amount", "Amount", 0, 1, 0.01],
    ["grain_size", "Grain size", 0.5, 8, 0.1],
    ["color_amount", "Color", 0, 1, 0.01],
    ["response", "Response", 0, 1, 0.01],
];

// presets de stock filmico: (tamano, color, respuesta, ganancia)
// must stay in sync with FILM_PRESETS in Python
const FILM_PRESETS = {
    "35mm fine (50D)": [1.0, 0.15, 0.7, 0.6],
    "35mm (250D)": [1.5, 0.25, 0.65, 0.9],
    "35mm high speed (500T)": [2.2, 0.4, 0.6, 1.25],
    "super 16mm": [2.8, 0.35, 0.55, 1.5],
    "16mm": [3.4, 0.45, 0.5, 1.8],
    "8mm": [5.0, 0.55, 0.45, 2.4],
};

// con preset: el stock define tamano/color/respuesta y multiplica la cantidad
function effectiveParams(p) {
    const preset = FILM_PRESETS[p.film_preset];
    if (!preset) return p;
    const [size, color, resp, gain] = preset;
    return { ...p, amount: p.amount * gain, grain_size: size, color_amount: color, response: resp };
}

app.registerExtension({
    name: "comfy.ERRegrain",

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
            let glState = null;
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
                    if (d && typeof d === "object" && !Array.isArray(d)) return { ...DEFAULT_GRAIN, ...d };
                } catch (e) {}
                return { ...DEFAULT_GRAIN };
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
            glCanvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
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

            // ---------- panel Grain (plegable, con preset filmico) ----------
            const panelBox = document.createElement("div");
            panelBox.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;";
            root.appendChild(panelBox);

            const rebuildUI = () => {
                panelBox.innerHTML = "";
                const p = getP();
                const open = p._open !== false;
                const usingPreset = !!FILM_PRESETS[p.film_preset];
                const box = document.createElement("div");
                box.className = "er-panel";
                box.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:5px 7px;";
                const head = document.createElement("div");
                head.style.cssText = "display:flex;align-items:center;gap:6px;";
                const fold = document.createElement("button");
                fold.className = "er-btn";
                fold.textContent = open ? "▾" : "▸";
                fold.title = "Expand/collapse";
                fold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
                const title = document.createElement("span");
                title.className = "er-title";
                title.textContent = "Grain";
                // preset de stock filmico
                const sel = document.createElement("select");
                sel.className = "er-select";
                sel.style.cssText = "font-size:10px;padding:1px 5px;flex:1;max-width:190px;";
                for (const name of ["custom", ...Object.keys(FILM_PRESETS)]) {
                    const o = document.createElement("option");
                    o.value = o.textContent = name;
                    sel.appendChild(o);
                }
                sel.value = p.film_preset;
                const greset = document.createElement("button");
                greset.className = "er-btn";
                greset.textContent = "⟲";
                greset.title = "Reset all grain parameters";
                greset.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
                head.append(fold, title, sel, greset);
                const body = document.createElement("div");
                body.style.cssText =
                    `display:${open ? "grid" : "none"};grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:3px 12px;`;
                for (const [key, label, min, max, step] of SLIDERS) {
                    const overridden = usingPreset && key !== "amount";
                    const wrap = document.createElement("div");
                    wrap.style.cssText = "display:flex;align-items:center;gap:4px;" + (overridden ? "opacity:.35;" : "");
                    const tag = document.createElement("span");
                    tag.className = "er-dim";
                    tag.textContent = label;
                    tag.style.cssText = "font-size:9px;width:60px;flex:0 0 auto;user-select:none;";
                    const inp = document.createElement("input");
                    inp.type = "range";
                    inp.className = "er-range";
                    inp.min = String(min);
                    inp.max = String(max);
                    inp.step = String(step);
                    inp.value = String(p[key]);
                    inp.disabled = overridden;
                    inp.title = overridden ? "Controlled by the film preset" : label + " (double click: reset)";
                    inp.style.cssText = "flex:1;height:12px;cursor:pointer;min-width:30px;";
                    const num = document.createElement("input");
                    num.type = "number";
                    num.className = "er-input";
                    num.min = String(min);
                    num.max = String(max);
                    num.step = String(step);
                    num.value = String(p[key]);
                    num.disabled = overridden;
                    num.style.cssText = "width:44px;flex:0 0 auto;font-size:9px;padding:1px 3px;text-align:right;";
                    const rst = document.createElement("button");
                    rst.className = "er-btn";
                    rst.textContent = "⟲";
                    rst.title = "Reset " + label;
                    rst.disabled = overridden;
                    rst.style.cssText = "height:16px;font-size:9px;line-height:1;padding:0 4px;flex:0 0 auto;";
                    const push = (v, syncNum, syncRange) => {
                        const val = Math.min(max, Math.max(min, Number(v)));
                        const p2 = getP();
                        p2[key] = val;
                        saveP(p2);
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
                        push(DEFAULT_GRAIN[key], true, true);
                    });
                    rst.addEventListener("click", (e) => {
                        e.stopPropagation();
                        push(DEFAULT_GRAIN[key], true, true);
                    });
                    wrap.append(tag, inp, num, rst);
                    body.appendChild(wrap);
                }
                // seed
                const seedWrap = document.createElement("div");
                seedWrap.style.cssText = "display:flex;align-items:center;gap:4px;";
                const seedTag = document.createElement("span");
                seedTag.className = "er-dim";
                seedTag.textContent = "Seed";
                seedTag.style.cssText = "font-size:9px;width:60px;flex:0 0 auto;user-select:none;";
                const seedInp = document.createElement("input");
                seedInp.type = "number";
                seedInp.min = "0";
                seedInp.step = "1";
                seedInp.value = String(p.seed);
                seedInp.className = "er-input";
                seedInp.style.cssText = "flex:1;font-size:10px;padding:1px 5px;min-width:40px;";
                seedInp.addEventListener("pointerdown", (e) => e.stopPropagation());
                seedInp.addEventListener("keydown", (e) => e.stopPropagation());
                seedInp.addEventListener("input", () => {
                    const p2 = getP();
                    p2.seed = Math.max(0, Math.floor(Number(seedInp.value) || 0));
                    saveP(p2);
                });
                seedWrap.append(seedTag, seedInp);
                body.appendChild(seedWrap);

                box.append(head, body);
                panelBox.appendChild(box);

                for (const el of [fold, sel, greset]) el.addEventListener("pointerdown", (e) => e.stopPropagation());
                greset.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const p2 = getP();
                    saveP({ ...DEFAULT_GRAIN, _open: p2._open });
                    rebuildUI();
                });
                fold.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const p2 = getP();
                    p2._open = !(p2._open !== false);
                    saveP(p2);
                    rebuildUI();
                });
                sel.addEventListener("change", () => {
                    const p2 = getP();
                    p2.film_preset = sel.value;
                    saveP(p2);
                    rebuildUI(); // refresca el atenuado de los sliders
                });
            };
            rebuildUI();

            // migracion desde el formato antiguo (widgets sueltos)
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
                    if (!ok) {
                        const v = info?.widgets_values;
                        if (Array.isArray(v) && v.length >= 5 && typeof v[0] === "number") {
                            saveP({
                                ...DEFAULT_GRAIN,
                                amount: v[0], grain_size: v[1], color_amount: v[2],
                                response: v[3], seed: v[4], film_preset: typeof v[5] === "string" ? v[5] : "custom",
                            });
                        } else {
                            saveP({ ...DEFAULT_GRAIN });
                        }
                    }
                    rebuildUI();
                }, 300);
            };
            setTimeout(() => {
                if (!node._erConfigured && !paramsW?.value?.startsWith("{")) saveP({ ...DEFAULT_GRAIN });
            }, 400);

            const widget = node.addDOMWidget("er_grain_preview", "ER_GRAIN", root, {
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

            const getParams = () => getP();
            const render = () => {
                if (!glState || !imgLoaded) return;
                const { gl, uniforms } = glState;
                const p = effectiveParams(getParams());
                gl.viewport(0, 0, glCanvas.width, glCanvas.height);
                gl.uniform2f(uniforms.u_res, glCanvas.width, glCanvas.height);
                gl.uniform1i(uniforms.u_tex, 0);
                gl.uniform1f(uniforms.u_amount, p.amount);
                gl.uniform1f(uniforms.u_size, p.grain_size);
                gl.uniform1f(uniforms.u_color, p.color_amount);
                gl.uniform1f(uniforms.u_response, p.response);
                gl.uniform1f(uniforms.u_seed, p.seed % 97); // igual que Python (frame 0)
                gl.uniform1f(uniforms.u_ab, abOn ? 1 : 0);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            };

            let rafId = null;
            const loop = () => {
                const key = JSON.stringify(getParams()) + (abOn ? "|ab" : "");
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
                    if (!glState) glState = initGL(glCanvas);
                    if (!glState) return;
                    const { gl, tex } = glState;
                    gl.bindTexture(gl.TEXTURE_2D, tex);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
                    imgLoaded = true;
                    stage.style.display = "block";
                    lastKey = null;
                    const wy = widget.y || 220;
                    const w = Math.max(node.size[0], 280);
                    const aspect = glCanvas.width / glCanvas.height;
                    node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + 24)]);
                    updateStageHeight();
                    if (rafId === null) rafId = requestAnimationFrame(loop);
                    app.graph.setDirtyCanvas(true, true);
                };
                im.src = url;
            };
            node.erSetImage = (file) => node.erSetImageURL(viewURL(file));

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
            const file = message?.er_grain?.[0];
            if (file && this.erSetImage) this.erSetImage(file);
        };
    },
});
