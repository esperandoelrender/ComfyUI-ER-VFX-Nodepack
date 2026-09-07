import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme(); // inyecta la hoja de estilos ER Academy una sola vez

const NODE_TYPE = "ERRelighting";
const PARAMS = ["ambient", "normal_strength", "normal_smooth", "invert_depth"];
const DEFAULTS = { ambient: 1, normal_strength: 1, normal_smooth: 3, invert_depth: false };
const MAX_LIGHTS = 4;
const VIEWS = ["Result", "Lights", "Depth", "Normals"];
const VIEW_UNIFORM = { Result: 0, Lights: 4, Depth: 1, Normals: 2 };

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

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// relight (misma matemática que apply_relight en Python).
// las normales llegan precalculadas en una textura (CPU: suavizado + clamp)
const FRAG_RELIGHT = `
precision highp float;
uniform sampler2D u_img;
uniform sampler2D u_depth;
uniform sampler2D u_normal;
uniform float u_aspect;
uniform float u_ambient;
uniform float u_invert;
uniform int u_view;
uniform int u_numLights;
uniform vec4 u_lightPos[4];
uniform vec4 u_lightCol[4];
varying vec2 v_uv;
const float DEPTH_Z = 0.25;

float getD(vec2 uv) {
    float d = texture2D(u_depth, uv).r;
    return u_invert > 0.5 ? 1.0 - d : d;
}

void main() {
    vec3 albedo = texture2D(u_img, v_uv).rgb;
    if (u_view == 3) { gl_FragColor = vec4(albedo, 1.0); return; }
    float d = getD(v_uv);
    if (u_view == 1) { gl_FragColor = vec4(vec3(d), 1.0); return; }

    vec3 n = normalize(texture2D(u_normal, v_uv).rgb * 2.0 - 1.0);
    if (u_view == 2) { gl_FragColor = vec4(n * 0.5 + 0.5, 1.0); return; }

    vec3 p = vec3(v_uv.x * u_aspect, v_uv.y, d * DEPTH_Z);
    vec3 total = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        if (i >= u_numLights) break;
        vec3 lp = vec3(u_lightPos[i].x * u_aspect, u_lightPos[i].y, u_lightPos[i].z);
        vec3 L = lp - p;
        float dist = max(length(L), 1e-6);
        float ndotl = max(dot(n, L / dist), 0.0);
        float atten = 1.0 / (1.0 + pow(dist / max(u_lightPos[i].w, 1e-3), 2.0));
        total += u_lightCol[i].rgb * (ndotl * atten * u_lightCol[i].a);
    }
    // vista "Lights": contribucion pura de las luces sobre fondo neutro
    if (u_view == 4) { gl_FragColor = vec4(clamp(total, 0.0, 1.0), 1.0); return; }

    vec3 outc = albedo * (u_ambient + total);
    gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
}`;

function buildProgram(gl, fragSrc) {
    const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("[ERRelighting] shader:", gl.getShaderInfoLog(sh));
            return null;
        }
        return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("[ERRelighting] link:", gl.getProgramInfoLog(prog));
        return null;
    }
    return prog;
}

// triple box blur separable con bordes replicados; espejo de box_blur en Python
function boxBlur3(src, W, H, radius) {
    const r = Math.round(radius);
    if (r <= 0) return src.slice();
    const k = 2 * r + 1;
    let a = src.slice();
    const b = new Float32Array(W * H);
    const clampX = (x) => Math.min(Math.max(x, 0), W - 1);
    const clampY = (y) => Math.min(Math.max(y, 0), H - 1);
    for (let pass = 0; pass < 3; pass++) {
        for (let y = 0; y < H; y++) {
            const row = y * W;
            let sum = 0;
            for (let i = -r; i <= r; i++) sum += a[row + clampX(i)];
            b[row] = sum / k;
            for (let x = 1; x < W; x++) {
                sum += a[row + clampX(x + r)] - a[row + clampX(x - r - 1)];
                b[row + x] = sum / k;
            }
        }
        for (let x = 0; x < W; x++) {
            let sum = 0;
            for (let i = -r; i <= r; i++) sum += b[clampY(i) * W + x];
            a[x] = sum / k;
            for (let y = 1; y < H; y++) {
                sum += b[clampY(y + r) * W + x] - b[clampY(y - r - 1) * W + x];
                a[y * W + x] = sum / k;
            }
        }
    }
    return a;
}

// normales desde el depth: suavizado -> gradientes centrales -> clamp;
// espejo de derive_normals en Python. Devuelve RGBA uint8 (n*0.5+0.5)
function computeNormals(depthF32, W, H, strength, smooth, invert) {
    const GRAD_K = 2;
    const GRAD_CLAMP = 8.0;
    let d = depthF32;
    if (invert) {
        d = new Float32Array(W * H);
        for (let i = 0; i < d.length; i++) d[i] = 1.0 - depthF32[i];
    }
    const ds = boxBlur3(d, W, H, smooth);
    const out = new Uint8Array(W * H * 4);
    const cl = (v) => Math.min(Math.max(v, -GRAD_CLAMP), GRAD_CLAMP);
    const clampX = (x) => Math.min(Math.max(x, 0), W - 1);
    const clampY = (y) => Math.min(Math.max(y, 0), H - 1);
    const sx = W / (2 * GRAD_K);
    const sy = H / (2 * GRAD_K);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const gx = (ds[y * W + clampX(x + GRAD_K)] - ds[y * W + clampX(x - GRAD_K)]) * sx;
            const gy = (ds[clampY(y + GRAD_K) * W + x] - ds[clampY(y - GRAD_K) * W + x]) * sy;
            const nx = cl(-gx * strength);
            const ny = cl(-gy * strength);
            const len = Math.sqrt(nx * nx + ny * ny + 1);
            const i = (y * W + x) * 4;
            out[i] = (nx / len * 0.5 + 0.5) * 255;
            out[i + 1] = (ny / len * 0.5 + 0.5) * 255;
            out[i + 2] = (1 / len * 0.5 + 0.5) * 255;
            out[i + 3] = 255;
        }
    }
    return out;
}

function makeTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
}

app.registerExtension({
    name: "comfy.ERRelighting",

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
            erBrandNode(this); // colores de marca en titulo y cuerpo del nodo
            const node = this;

            let aspect = 16 / 9;
            let rafId = null;
            let dirty = true;
            let showOriginal = false;
            let viewMode = 0;
            let selected = -1;
            let glState = null; // { gl, progs, textures, fbo... }

            // el widget "lights" (STRING) guarda las luces; va oculto
            const lightsWidget = node.widgets?.find((w) => w.name === "lights");
            if (lightsWidget) {
                lightsWidget.type = "hidden";
                lightsWidget.computeSize = () => [0, -4];
                lightsWidget.hidden = true;
            }
            const getLights = () => {
                try {
                    const d = JSON.parse(lightsWidget?.value || "[]");
                    return Array.isArray(d) ? d.slice(0, MAX_LIGHTS) : [];
                } catch (e) {
                    return [];
                }
            };
            const setLights = (lights) => {
                if (lightsWidget) lightsWidget.value = JSON.stringify(lights);
                dirty = true;
                syncLightUI();
            };

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:5px;font-family:${ER.font};`;

            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText =
                `position:relative;width:100%;flex:0 0 auto;overflow:hidden;background:${ER.inset};` +
                "border-radius:6px;display:none;";
            const glCanvas = document.createElement("canvas");
            glCanvas.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;display:block;";
            const overlay = document.createElement("div");
            overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;";
            stage.append(glCanvas, overlay);

            // fila de luces: añadir + chips + vista
            const lightsBar = document.createElement("div");
            lightsBar.style.cssText = "display:none;align-items:center;gap:5px;flex-wrap:wrap;flex:0 0 auto;";
            const mkBtn = (text, title) => {
                const b = document.createElement("button");
                b.textContent = text;
                b.title = title;
                // colores/bordes via clase er-btn; el inline solo fija el layout
                b.className = "er-btn";
                b.style.cssText =
                    "height:20px;border-radius:4px;cursor:pointer;font-size:10px;line-height:1;padding:0 8px;";
                return b;
            };
            const addBtn = mkBtn("＋ Light", "Add a point light");
            addBtn.className = "er-btn-primary"; // accion principal en cyan
            const viewBtn = mkBtn("View: Result", "Cycle view: result / depth / normals");
            const chipsBox = document.createElement("div");
            chipsBox.style.cssText = "display:flex;gap:4px;align-items:center;";
            lightsBar.append(addBtn, chipsBox, viewBtn);

            // controles de la luz seleccionada
            const lightCtl = document.createElement("div");
            lightCtl.style.cssText = "display:none;align-items:center;gap:6px;flex:0 0 auto;";
            const colorIn = document.createElement("input");
            colorIn.type = "color";
            colorIn.value = "#ffffff";
            colorIn.title = "Light color";
            colorIn.style.cssText = "width:26px;height:20px;border:none;padding:0;background:none;cursor:pointer;";
            const mkSlider = (label, min, max, step, title) => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "display:flex;align-items:center;gap:3px;flex:1;";
                const tag = document.createElement("span");
                tag.textContent = label;
                tag.className = "er-dim";
                tag.style.cssText = "font-size:9px;user-select:none;";
                const inp = document.createElement("input");
                inp.type = "range";
                inp.className = "er-range"; // acento cyan en el slider
                inp.min = String(min);
                inp.max = String(max);
                inp.step = String(step);
                inp.title = title;
                inp.style.cssText = "flex:1;height:12px;cursor:pointer;min-width:30px;";
                wrap.append(tag, inp);
                return { wrap, inp };
            };
            const intS = mkSlider("Int", 0, 3, 0.01, "Intensity");
            const radS = mkSlider("Rad", 0.1, 2, 0.01, "Attenuation radius");
            const zS = mkSlider("Z", 0.05, 1.5, 0.01, "Light height above the image");
            const delBtn = mkBtn("✕", "Delete this light");
            delBtn.style.color = ER.error; // rojo semantico: borrar
            lightCtl.append(colorIn, intS.wrap, radS.wrap, zS.wrap, delBtn);

            // botones generales
            const controls = document.createElement("div");
            controls.style.cssText = "display:none;align-items:center;gap:6px;flex:0 0 auto;";
            const resetBtn = mkBtn("Reset", "Reset lights and parameters");
            const origBtn = mkBtn("👁 Original", "Hold to see the original image");
            controls.append(resetBtn, origBtn);

            root.append(stage, lightsBar, lightCtl, controls);

            const widget = node.addDOMWidget("er_relight_preview", "ER_RELIGHT", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima; el contenido se adapta luego al tamano real del
            // nodo (el layout de widgets DOM del frontend nuevo no reserva el
            // alto pedido y el visor desbordaba el nodo, robando los clics
            // del lienzo alrededor)
            const EXTRA_H = 92; // chips + controles de luz + botones
            widget.computeSize = function (width) {
                if (stage.style.display === "none") return [width, -4];
                return [width, EXTRA_H + 120];
            };

            // el visor conserva SIEMPRE el aspecto de la imagen (los
            // marcadores de luz se posicionan en % del stage): se encaja en
            // el hueco disponible limitando por ancho y por alto, centrado
            const updateStageHeight = () => {
                if (stage.style.display === "none") return;
                const wy = widget.y || 0;
                const rootW = root.clientWidth || node.size[0] - 20;
                const avail = Math.max(90, node.size[1] - wy - EXTRA_H - 24);
                const w = Math.max(60, Math.min(rootW, avail * aspect));
                const wpx = `${w}px`;
                const hpx = `${w / aspect}px`;
                if (stage.style.width !== wpx) stage.style.width = wpx;
                if (stage.style.height !== hpx) stage.style.height = hpx;
                stage.style.alignSelf = "center";
            };
            node._erFitCC = updateStageHeight;
            new ResizeObserver(updateStageHeight).observe(root);
            const fitTimer = setInterval(updateStageHeight, 500);
            const onRemovedRl = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemovedRl?.apply(this, arguments);
            };

            // ---------- marcadores de luces ----------
            const markers = [];
            const chips = [];

            // restyle ligero de seleccion: NO reconstruye los elementos (un
            // rebuild en pleno pointerdown rompe el gesto de arrastre)
            const updateSelection = () => {
                const lights = getLights();
                chips.forEach((chip, i) => {
                    // chip seleccionado en cyan; el borde inferior conserva el color de la luz
                    chip.classList.toggle("er-active", i === selected);
                });
                markers.forEach((m, i) => {
                    m.style.border = `2px solid ${i === selected ? "#fff" : "rgba(255,255,255,0.45)"}`;
                });
                const l = lights[selected];
                lightCtl.style.display = l && stage.style.display !== "none" ? "flex" : "none";
                if (l) {
                    colorIn.value = l.color || "#ffffff";
                    intS.inp.value = String(l.intensity ?? 1.2);
                    radS.inp.value = String(l.radius ?? 0.8);
                    zS.inp.value = String(l.z ?? 0.6);
                }
            };

            const syncLightUI = () => {
                const lights = getLights();
                if (selected >= lights.length) selected = lights.length - 1;
                // chips
                chipsBox.innerHTML = "";
                chips.length = 0;
                lights.forEach((l, i) => {
                    const chip = mkBtn(`L${i + 1}`, "Select this light");
                    chip.style.borderBottom = `2px solid ${l.color || "#fff"}`;
                    chip.addEventListener("click", (e) => {
                        e.stopPropagation();
                        selected = i;
                        updateSelection();
                    });
                    chipsBox.appendChild(chip);
                    chips.push(chip);
                });
                addBtn.style.display = lights.length >= MAX_LIGHTS ? "none" : "";
                // marcadores
                markers.forEach((m) => m.remove());
                markers.length = 0;
                lights.forEach((l, i) => {
                    const m = document.createElement("div");
                    m.style.cssText =
                        `position:absolute;width:14px;height:14px;border-radius:50%;` +
                        `background:${l.color || "#fff"};border:2px solid rgba(255,255,255,0.45);` +
                        `box-shadow:0 0 6px rgba(0,0,0,0.8);cursor:grab;transform:translate(-50%,-50%);` +
                        `left:${l.x * 100}%;top:${l.y * 100}%;`;
                    m.title = `Light ${i + 1} (drag to move)`;
                    overlay.appendChild(m);
                    markers.push(m);
                });
                updateSelection();
            };

            // arrastre por delegación en el overlay (un listener persistente:
            // inmune a reconstrucciones de los marcadores a mitad de gesto)
            let dragIdx = -1;
            overlay.addEventListener("pointerdown", (e) => {
                const idx = markers.indexOf(e.target);
                if (idx < 0) return;
                e.stopPropagation();
                e.preventDefault();
                selected = idx;
                updateSelection();
                dragIdx = idx;
                try {
                    overlay.setPointerCapture(e.pointerId);
                } catch (err) {}
            });
            overlay.addEventListener("pointermove", (e) => {
                if (dragIdx < 0 || !markers[dragIdx]) return;
                const r = stage.getBoundingClientRect();
                const x = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1);
                const y = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1);
                const ls = getLights();
                if (!ls[dragIdx]) return;
                ls[dragIdx].x = Math.round(x * 1000) / 1000;
                ls[dragIdx].y = Math.round(y * 1000) / 1000;
                if (lightsWidget) lightsWidget.value = JSON.stringify(ls);
                markers[dragIdx].style.left = `${x * 100}%`;
                markers[dragIdx].style.top = `${y * 100}%`;
                dirty = true;
            });
            const endDrag = (e) => {
                try {
                    overlay.releasePointerCapture(e.pointerId);
                } catch (err) {}
                dragIdx = -1;
            };
            overlay.addEventListener("pointerup", endDrag);
            overlay.addEventListener("pointercancel", endDrag);

            const editSelected = (fn) => {
                const ls = getLights();
                if (!ls[selected]) return;
                fn(ls[selected]);
                setLights(ls);
            };
            addBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const ls = getLights();
                if (ls.length >= MAX_LIGHTS) return;
                ls.push({ x: 0.3 + 0.15 * ls.length, y: 0.35, z: 0.6, color: "#ffffff", intensity: 1.2, radius: 0.8 });
                selected = ls.length - 1;
                setLights(ls);
            });
            delBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                const ls = getLights();
                if (selected < 0 || selected >= ls.length) return;
                ls.splice(selected, 1);
                selected = ls.length - 1;
                setLights(ls);
            });
            colorIn.addEventListener("input", () => editSelected((l) => (l.color = colorIn.value)));
            intS.inp.addEventListener("input", () => editSelected((l) => (l.intensity = Number(intS.inp.value))));
            radS.inp.addEventListener("input", () => editSelected((l) => (l.radius = Number(radS.inp.value))));
            zS.inp.addEventListener("input", () => editSelected((l) => (l.z = Number(zS.inp.value))));
            for (const el of [colorIn, intS.inp, radS.inp, zS.inp]) {
                el.addEventListener("pointerdown", (e) => e.stopPropagation());
            }
            viewBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                viewMode = (viewMode + 1) % VIEWS.length;
                viewBtn.textContent = `View: ${VIEWS[viewMode]}`;
                // cyan cuando la vista activa no es la de resultado
                viewBtn.classList.toggle("er-active", viewMode !== 0);
                dirty = true;
            });

            // ---------- WebGL ----------
            const initGL = () => {
                const gl = glCanvas.getContext("webgl", { preserveDrawingBuffer: true });
                if (!gl) return null;
                const progRelight = buildProgram(gl, FRAG_RELIGHT);
                if (!progRelight) return null;
                const buf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
                const bindAttribs = (prog) => {
                    const loc = gl.getAttribLocation(prog, "a_pos");
                    gl.enableVertexAttribArray(loc);
                    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
                };
                const texImg = makeTexture(gl);
                const texDepth = makeTexture(gl);
                const texNormal = makeTexture(gl);
                const uniforms = (prog) => {
                    const u = {};
                    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
                    for (let i = 0; i < n; i++) {
                        const info = gl.getActiveUniform(prog, i);
                        u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(prog, info.name);
                    }
                    return u;
                };
                return {
                    gl, progRelight, bindAttribs,
                    texImg, texDepth, texNormal,
                    uR: uniforms(progRelight),
                };
            };

            const getParams = () => {
                const p = {};
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    p[name] = w ? (name === "invert_depth" ? !!w.value : Number(w.value)) : DEFAULTS[name];
                }
                return p;
            };

            const hexRgb = (hex) => {
                const h = (hex || "#ffffff").replace("#", "");
                return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
            };

            const render = () => {
                if (!glState) return;
                const { gl } = glState;
                const W = glCanvas.width;
                const H = glCanvas.height;
                const p = getParams();
                const view = showOriginal ? 3 : VIEW_UNIFORM[VIEWS[viewMode]];
                const lights = showOriginal ? [] : getLights();

                gl.viewport(0, 0, W, H);
                gl.useProgram(glState.progRelight);
                glState.bindAttribs(glState.progRelight);
                const uR = glState.uR;
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, glState.texImg);
                gl.uniform1i(uR.u_img, 0);
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, glState.texDepth);
                gl.uniform1i(uR.u_depth, 1);
                gl.activeTexture(gl.TEXTURE2);
                gl.bindTexture(gl.TEXTURE_2D, glState.texNormal);
                gl.uniform1i(uR.u_normal, 2);
                gl.uniform1f(uR.u_aspect, W / H);
                gl.uniform1f(uR.u_ambient, showOriginal ? 1 : p.ambient);
                gl.uniform1f(uR.u_invert, p.invert_depth ? 1 : 0);
                gl.uniform1i(uR.u_view, view);
                gl.uniform1i(uR.u_numLights, lights.length);
                const pos = new Float32Array(16);
                const col = new Float32Array(16);
                lights.forEach((l, i) => {
                    pos.set([l.x, l.y, l.z, l.radius], i * 4);
                    const c = hexRgb(l.color);
                    col.set([c[0], c[1], c[2], l.intensity], i * 4);
                });
                gl.uniform4fv(uR.u_lightPos, pos);
                gl.uniform4fv(uR.u_lightCol, col);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            };

            // recalcula la textura de normales cuando cambian sus parámetros
            let depthData = null; // { f32, W, H }
            let externalNormals = false;
            let lastNormKey = null;
            const refreshNormals = (p) => {
                if (externalNormals || !depthData || !glState) return;
                const nKey = `${p.normal_strength},${p.normal_smooth},${p.invert_depth}`;
                if (nKey === lastNormKey) return;
                lastNormKey = nKey;
                const { gl } = glState;
                const { f32, W, H } = depthData;
                const rgba = computeNormals(f32, W, H, p.normal_strength, p.normal_smooth, p.invert_depth);
                gl.bindTexture(gl.TEXTURE_2D, glState.texNormal);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                dirty = true;
            };

            let lastKey = null;
            const loop = () => {
                const p = getParams();
                refreshNormals(p);
                const key = PARAMS.map((n) => p[n]).join(",") + "|" + (lightsWidget?.value || "") + "|" + viewMode + (showOriginal ? "|o" : "");
                if (dirty || key !== lastKey) {
                    lastKey = key;
                    dirty = false;
                    render();
                }
                rafId = requestAnimationFrame(loop);
            };

            // ---------- botones ----------
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    if (w) w.value = DEFAULTS[name];
                }
                selected = -1;
                setLights([]);
                node.setDirtyCanvas(true, true);
            });
            const setOriginal = (v) => {
                showOriginal = v;
                origBtn.classList.toggle("er-active", v); // resaltado cyan mientras se mantiene pulsado
                dirty = true;
            };
            origBtn.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                setOriginal(true);
            });
            origBtn.addEventListener("pointerup", () => setOriginal(false));
            origBtn.addEventListener("pointerleave", () => setOriginal(false));

            // ---------- carga de texturas ----------
            const loadImageEl = (url) =>
                new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = url;
                });

            const uploadTex = (tex, source) => {
                const { gl } = glState;
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            };

            const showAll = () => {
                stage.style.display = "block";
                lightsBar.style.display = "flex";
                controls.style.display = "flex";
                syncLightUI();
                // tamano por defecto agradable (respeta el aspecto); a partir
                // de aqui el usuario escala libre y el visor se ajusta
                const wy = widget.y || 220;
                const w = Math.max(node.size[0], 300);
                node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + EXTRA_H + 24)]);
                updateStageHeight();
                app.graph.setDirtyCanvas(true, true);
                if (rafId === null) rafId = requestAnimationFrame(loop);
            };

            // luminancia como pseudo-depth (espejo de luminance_depth en Python)
            const luminanceDepth = (imgEl, w, h) => {
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                const ctx = c.getContext("2d");
                ctx.drawImage(imgEl, 0, 0, w, h);
                const id = ctx.getImageData(0, 0, w, h);
                const d = id.data;
                for (let i = 0; i < d.length; i += 4) {
                    const l = d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722;
                    d[i] = d[i + 1] = d[i + 2] = l;
                }
                ctx.putImageData(id, 0, 0);
                return c;
            };

            node.erSetImages = async (imgFile, depthFile, normFile) => {
                try {
                    const imgEl = await loadImageEl(viewURL(imgFile));
                    const W = imgEl.naturalWidth;
                    const H = imgEl.naturalHeight;
                    glCanvas.width = W;
                    glCanvas.height = H;
                    aspect = W / H;
                    if (!glState) {
                        glState = initGL();
                        if (!glState) {
                            console.error("[ERRelighting] WebGL not available");
                            return;
                        }
                    }
                    const { gl } = glState;
                    uploadTex(glState.texImg, imgEl);
                    let depthSource;
                    if (depthFile) {
                        depthSource = await loadImageEl(viewURL(depthFile));
                    } else {
                        depthSource = luminanceDepth(imgEl, W, H);
                    }
                    uploadTex(glState.texDepth, depthSource);

                    // depth como float para derivar normales en CPU
                    const dc = document.createElement("canvas");
                    dc.width = W;
                    dc.height = H;
                    const dctx = dc.getContext("2d");
                    dctx.drawImage(depthSource, 0, 0, W, H);
                    const dpix = dctx.getImageData(0, 0, W, H).data;
                    const f32 = new Float32Array(W * H);
                    for (let i = 0; i < f32.length; i++) f32[i] = dpix[i * 4] / 255;
                    depthData = { f32, W, H };
                    lastNormKey = null;

                    if (normFile) {
                        // normal map externo (OpenGL, G arriba): voltea G a y-abajo
                        externalNormals = true;
                        const nEl = await loadImageEl(viewURL(normFile));
                        const nc = document.createElement("canvas");
                        nc.width = W;
                        nc.height = H;
                        const nctx = nc.getContext("2d");
                        nctx.drawImage(nEl, 0, 0, W, H);
                        const nid = nctx.getImageData(0, 0, W, H);
                        for (let i = 0; i < nid.data.length; i += 4) {
                            nid.data[i + 1] = 255 - nid.data[i + 1];
                        }
                        nctx.putImageData(nid, 0, 0);
                        uploadTex(glState.texNormal, nc);
                    } else {
                        externalNormals = false;
                    }

                    dirty = true;
                    showAll();
                } catch (e) {
                    console.error("[ERRelighting]", e);
                }
            };

            // carga automática al conectar (depth por luminancia hasta ejecutar)
            node.erTryAutoLoad = () => {
                const src = node.getInputNode?.(0);
                if (!src) return;
                const cached = app.nodeOutputs?.[String(src.id)];
                if (cached?.images?.length) {
                    node.erSetImages(cached.images[0], null);
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
                        node.erSetImages({ filename: name, subfolder, type: "input" }, null);
                    }
                }
            };

            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function (type, index, connected, linkInfo) {
                onConnectionsChange?.apply(this, arguments);
                if (type === LiteGraph.INPUT && index === 0 && connected) {
                    setTimeout(() => node.erTryAutoLoad(), 50);
                }
            };

            // red de seguridad: tipos imposibles (p. ej. workflows guardados
            // con una version anterior del nodo) -> valores por defecto
            const sanitizeWidgets = () => {
                for (const name of ["ambient", "normal_strength", "normal_smooth"]) {
                    const w = node.widgets?.find((w) => w.name === name);
                    if (w && !isFinite(Number(w.value))) w.value = DEFAULTS[name] ?? 0;
                    else if (w) w.value = Number(w.value);
                }
                if (lightsWidget && (typeof lightsWidget.value !== "string" || !lightsWidget.value.trim().startsWith("["))) {
                    lightsWidget.value = "[]";
                }
            };

            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                sanitizeWidgets();
                syncLightUI();
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
            const depth = message?.er_depth?.[0];
            const normals = message?.er_normals?.[0];
            if (img && this.erSetImages) this.erSetImages(img, depth || null, normals || null);
        };
    },
});
