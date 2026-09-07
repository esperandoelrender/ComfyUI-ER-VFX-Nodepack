import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme(); // inyecta la hoja de estilos ER una sola vez

const NODE_TYPE = "ERVideoColorCorrect";
const PARAMS = ["temperature", "hue", "saturation", "contrast", "gamma", "gain", "offset"];
const DEFAULTS = { temperature: 6500, hue: 0, saturation: 1, contrast: 1, gamma: 1, gain: 1, offset: 0 };
const WHEELS = ["Shadows", "Midtones", "Highlights"];
const WHEEL_SIZE = 76;
const VIDEO_EXTS = /\.(mp4|webm|mov|m4v)( \[\w+\])?$/i;

const logo = new Image();
logo.src = new URL("./logo.png", import.meta.url).href;
logo.onload = () => app.graph?.setDirtyCanvas(true, true);

const toast = (severity, detail) => {
    try {
        app.extensionManager.toast.add({
            severity,
            summary: "ER Video Color Correct",
            detail,
            life: 5000,
        });
    } catch (e) {
        console.warn("[ERVideoColorCorrect]", detail);
    }
};

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

function fmtTime(t) {
    if (!isFinite(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

function hueMatrix(deg) {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // filas de la matriz (v' = M . v); espejo de _hue_matrix en Python
    return [
        [0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.787 * s],
        [0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s],
        [0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s],
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

// espejo de tint_gains en Python
function tintToGains(angle, radius) {
    const [r, g, b] = hsvToRgb(angle);
    const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const k = radius * 0.8;
    return [1 + k * (r - luma), 1 + k * (g - luma), 1 + k * (b - luma)];
}

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// misma matemática que apply_color_correct en Python
const FRAG_SRC = `
precision highp float;
uniform sampler2D u_tex;
uniform mat3 u_hue;
uniform vec3 u_temp;
uniform float u_sat;
uniform float u_con;
uniform float u_invGamma;
uniform float u_gain;
uniform float u_off;
uniform vec3 u_gs;
uniform vec3 u_gm;
uniform vec3 u_gh;
varying vec2 v_uv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
    vec3 c = texture2D(u_tex, v_uv).rgb;
    c = u_hue * c;
    c *= u_temp;
    float l = dot(c, LUMA);
    c = vec3(l) + (c - vec3(l)) * u_sat;
    c = (c - 0.18) * u_con + 0.18;
    c = pow(max(c, vec3(0.0)), vec3(u_invGamma));
    float l2 = clamp(dot(c, LUMA), 0.0, 1.0);
    float ws = (1.0 - l2) * (1.0 - l2);
    float wh = l2 * l2;
    float wm = 1.0 - ws - wh;
    vec3 factor = vec3(1.0) + ws * (u_gs - vec3(1.0)) + wm * (u_gm - vec3(1.0)) + wh * (u_gh - vec3(1.0));
    c = c * factor * u_gain + u_off;
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

function initGL(canvas) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true }) ||
               canvas.getContext("experimental-webgl", { preserveDrawingBuffer: true });
    if (!gl) return null;

    const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error("[ERVideoColorCorrect] shader:", gl.getShaderInfoLog(sh));
            return null;
        }
        return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error("[ERVideoColorCorrect] link:", gl.getProgramInfoLog(prog));
        return null;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const u = {};
    for (const name of ["u_hue", "u_temp", "u_sat", "u_con", "u_invGamma", "u_gain", "u_off", "u_gs", "u_gm", "u_gh"]) {
        u[name] = gl.getUniformLocation(prog, name);
    }
    return { gl, u };
}

app.registerExtension({
    name: "comfy.ERVideoColorCorrect",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // logo en la barra de título
        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        // en cada redibujado, el visor se ajusta al tamaño actual del nodo
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFitCC?.();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this); // colores de marca ER en el nodo
            const node = this;

            let aspect = 16 / 9;
            let rafId = null;
            let showOriginal = false;
            let scrubbing = false;
            let glCtx = null;

            // el widget "wheels" (STRING) guarda las tres ruedas; va oculto
            const wheelsWidget = node.widgets?.find((w) => w.name === "wheels");
            if (wheelsWidget) {
                wheelsWidget.type = "hidden";
                wheelsWidget.computeSize = () => [0, -4];
                wheelsWidget.hidden = true;
            }
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
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:6px;font-family:${ER.font};`;

            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText =
                "position:relative;width:100%;flex:0 0 auto;overflow:hidden;" +
                "display:none;";
            const glCanvas = document.createElement("canvas");
            glCanvas.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
            stage.appendChild(glCanvas);

            // decodificador: vive oculto en el DOM, el shader lee sus frames
            const video = document.createElement("video");
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = "auto";
            video.style.display = "none";
            stage.appendChild(video);

            // fila de reproducción
            const playback = document.createElement("div");
            playback.style.cssText = "display:none;align-items:center;gap:6px;flex:0 0 auto;";
            const playBtn = document.createElement("button");
            playBtn.textContent = "⏸";
            playBtn.className = "er-btn";
            playBtn.style.cssText =
                "width:28px;height:22px;padding:0;" +
                "cursor:pointer;font-size:11px;line-height:1;";
            const timeline = document.createElement("input");
            timeline.type = "range";
            timeline.min = "0";
            timeline.max = "1000";
            timeline.value = "0";
            timeline.className = "er-range";
            timeline.style.cssText = "flex:1;height:14px;cursor:pointer;";
            const timeLabel = document.createElement("span");
            timeLabel.className = "er-dim";
            timeLabel.style.cssText = "font-size:10px;min-width:62px;text-align:right;";
            timeLabel.textContent = "0:00 / 0:00";
            playback.append(playBtn, timeline, timeLabel);

            // fila de wheels con etiquetas
            const wheelsRow = document.createElement("div");
            wheelsRow.style.cssText =
                "display:none;justify-content:space-evenly;align-items:flex-start;gap:6px;flex:0 0 auto;";
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
                tag.className = "er-title"; // etiqueta con estilo de titulo ER
                tag.style.cssText = "font-size:10px;user-select:none;";
                col.append(wheel, tag);
                wheelsRow.appendChild(col);

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
                b.className = "er-btn";
                b.style.cssText =
                    "height:20px;" +
                    "cursor:pointer;font-size:10px;line-height:1;padding:0 10px;";
                return b;
            };
            const resetBtn = mkBtn("Reset", "Reset all parameters and wheels");
            const origBtn = mkBtn("👁 Original", "Hold to see the original video");
            controls.append(resetBtn, origBtn);

            root.append(stage, playback, wheelsRow, controls);

            const widget = node.addDOMWidget("er_vcc_preview", "ER_VCC", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima; el contenido se adapta luego al tamano real del
            // nodo (ver updateStageHeight)
            const EXTRA_H = WHEEL_SIZE + 112; // playbar + ruedas + botones
            widget.computeSize = function (width) {
                if (stage.style.display === "none") return [width, -4];
                return [width, EXTRA_H + 120];
            };

            // Ajuste con realimentacion: mide el desborde REAL del contenido
            // respecto al borde inferior del nodo y corrige la altura del
            // visor (el layout de widgets DOM del frontend nuevo no reserva
            // el alto pedido y el contenido desbordaba, robando los clics
            // del lienzo alrededor)
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
            const onRemovedFit = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(fitTimer);
                onRemovedFit?.apply(this, arguments);
            };

            // ---------- render WebGL ----------
            const getParams = () => {
                const p = {};
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    p[name] = w ? Number(w.value) : DEFAULTS[name];
                }
                return p;
            };

            const render = () => {
                if (!glCtx || video.readyState < 2) return;
                const { gl, u } = glCtx;
                const p = showOriginal ? { ...DEFAULTS } : getParams();
                const wheelG = showOriginal
                    ? [[1, 1, 1], [1, 1, 1], [1, 1, 1]]
                    : getWheels().map(([a, r]) => tintToGains(a, r));

                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

                const m = hueMatrix(p.hue);
                // column-major para uniformMatrix3fv
                gl.uniformMatrix3fv(u.u_hue, false, [
                    m[0][0], m[1][0], m[2][0],
                    m[0][1], m[1][1], m[2][1],
                    m[0][2], m[1][2], m[2][2],
                ]);
                const tg = Math.abs(p.temperature - 6500) > 1 ? temperatureGains(p.temperature) : [1, 1, 1];
                gl.uniform3fv(u.u_temp, tg);
                gl.uniform1f(u.u_sat, p.saturation);
                gl.uniform1f(u.u_con, p.contrast);
                gl.uniform1f(u.u_invGamma, 1 / Math.max(p.gamma, 1e-6));
                gl.uniform1f(u.u_gain, p.gain);
                gl.uniform1f(u.u_off, p.offset);
                gl.uniform3fv(u.u_gs, wheelG[0]);
                gl.uniform3fv(u.u_gm, wheelG[1]);
                gl.uniform3fv(u.u_gh, wheelG[2]);

                gl.viewport(0, 0, glCanvas.width, glCanvas.height);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            };

            const loop = () => {
                render();
                const dur = video.duration;
                if (isFinite(dur) && dur > 0) {
                    if (!scrubbing) timeline.value = String((video.currentTime / dur) * 1000);
                    timeLabel.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(dur)}`;
                }
                rafId = requestAnimationFrame(loop);
            };

            // ---------- reproducción ----------
            playBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (video.paused) {
                    video.play();
                    playBtn.textContent = "⏸";
                } else {
                    video.pause();
                    playBtn.textContent = "▶";
                }
            });
            timeline.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                scrubbing = true;
            });
            timeline.addEventListener("input", () => {
                const dur = video.duration;
                if (isFinite(dur) && dur > 0) {
                    video.currentTime = (Number(timeline.value) / 1000) * dur;
                }
            });
            timeline.addEventListener("change", () => (scrubbing = false));

            // ---------- botones ----------
            resetBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                for (const name of PARAMS) {
                    const w = node.widgets?.find((w) => w.name === name);
                    if (w) w.value = DEFAULTS[name];
                }
                if (wheelsWidget) wheelsWidget.value = "[[0,0],[0,0],[0,0]]";
                drawAllWheels();
                node.setDirtyCanvas(true, true);
            });
            const setOriginal = (v) => {
                showOriginal = v;
                origBtn.classList.toggle("er-active", v); // resaltado cian al mantener pulsado
            };
            origBtn.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                setOriginal(true);
            });
            origBtn.addEventListener("pointerup", () => setOriginal(false));
            origBtn.addEventListener("pointerleave", () => setOriginal(false));

            // ---------- carga de video ----------
            video.addEventListener("loadedmetadata", () => {
                if (!video.videoWidth || !video.videoHeight) return;
                aspect = video.videoWidth / video.videoHeight;
                glCanvas.width = video.videoWidth;
                glCanvas.height = video.videoHeight;
                if (!glCtx) {
                    glCtx = initGL(glCanvas);
                    if (!glCtx) toast("error", "WebGL is not available; the live preview cannot run.");
                }
                stage.style.display = "block";
                playback.style.display = "flex";
                wheelsRow.style.display = "flex";
                controls.style.display = "flex";
                drawAllWheels();
                // tamano por defecto agradable (respeta el aspecto); a partir
                // de aqui el usuario escala libre y el visor se ajusta
                const wy = widget.y || 220;
                const w = Math.max(node.size[0], 3 * WHEEL_SIZE + 60);
                node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + EXTRA_H + 24)]);
                updateStageHeight();
                app.graph.setDirtyCanvas(true, true);
            });

            node.erSetVideoURL = (url) => {
                video.src = url;
                video.play().catch(() => {});
                playBtn.textContent = "⏸";
                if (rafId === null) rafId = requestAnimationFrame(loop);
            };
            node.erSetVideo = (file) => node.erSetVideoURL(viewURL(file));

            // carga automática al conectar, sin necesidad de ejecutar:
            // 1) outputs cacheados de una ejecución anterior del nodo origen
            // 2) Load Video (VHS o core): el archivo está en la carpeta input
            node.erTryAutoLoad = () => {
                const src = node.getInputNode?.(0);
                if (!src) return;
                const cached = app.nodeOutputs?.[String(src.id)];
                const cachedVid = (cached?.gifs || cached?.images || []).find((f) => VIDEO_EXTS.test(f.filename || ""));
                if (cachedVid) {
                    node.erSetVideo(cachedVid);
                    return;
                }
                const w = src.widgets?.find((w) => ["video", "file"].includes(w.name));
                if (w?.value && VIDEO_EXTS.test(String(w.value))) {
                    let name = String(w.value).replace(/ \[\w+\]$/, "");
                    let subfolder = "";
                    const slash = name.lastIndexOf("/");
                    if (slash >= 0) {
                        subfolder = name.slice(0, slash);
                        name = name.slice(slash + 1);
                    }
                    node.erSetVideo({ filename: name, subfolder, type: "input" });
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
            node.onConfigure = function () {
                onConfigure?.apply(this, arguments);
                drawAllWheels();
            };

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                video.pause();
                video.src = "";
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const file = message?.er_vcc?.[0];
            if (file && this.erSetVideo) this.erSetVideo(file);
        };
    },
});
