import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const NODE_TYPE = "VideoCompareSlider";

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

function fmtTime(t) {
    if (!isFinite(t)) return "0:00";
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

app.registerExtension({
    name: "comfy.ERVideoComparer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // dibuja el logo en la barra de título en lugar del punto estándar
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
            erBrandNode(this);
            const node = this;

            // el fps se detecta solo en el servidor (0 = auto): la barra no
            // aporta nada y se oculta; el valor usado se muestra junto a la
            // linea de tiempo tras cada ejecucion
            const fpsW = node.widgets?.find((w) => w.name === "fps");
            if (fpsW) {
                fpsW.type = "hidden";
                fpsW.hidden = true;
                fpsW.computeSize = () => [0, -4];
            }

            let aspect = 16 / 9;
            let rafId = null;
            let scrubbing = false;

            // ---------- DOM ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText =
                `width:100%;display:flex;flex-direction:column;gap:4px;font-family:${ER.font};`;

            const stage = document.createElement("div");
            // la altura se fija en píxeles via JS (updateStageHeight): el contenedor
            // .dom-widget del frontend nuevo tiene altura 0, así que no se puede
            // depender de aspect-ratio ni de alturas en porcentaje
            stage.style.cssText =
                `position:relative;width:100%;flex:0 0 auto;overflow:hidden;background:${ER.inset};` +
                `border:1px solid ${ER.borderSoft};border-radius:8px;box-sizing:border-box;` +
                "min-height:90px;cursor:ew-resize;user-select:none;touch-action:none;display:none;";
            stage.dataset.erSelf = "1"; // autoajustable: el fitter generico lo excluye

            const videoB = document.createElement("video"); // referencia: fondo (lado derecho)
            const videoA = document.createElement("video"); // generado: encima, recortado (lado izquierdo)
            for (const v of [videoA, videoB]) {
                v.muted = true;
                v.loop = true;
                v.playsInline = true;
                v.preload = "auto";
                // ambos videos ocupan exactamente la misma caja, centrados y
                // escalados con object-fit para que siempre queden alineados
                // aunque tengan resoluciones distintas
                v.style.cssText =
                    "position:absolute;top:0;left:0;width:100%;height:100%;" +
                    "object-fit:contain;display:block;pointer-events:none;";
            }

            // linea divisoria blanca, limpia (sin tirador central: se
            // arrastra desde cualquier punto del visor)
            const divider = document.createElement("div");
            divider.style.cssText =
                "position:absolute;top:0;bottom:0;width:2px;background:#fff;" +
                "box-shadow:0 0 5px rgba(0,0,0,.6);pointer-events:none;transform:translateX(-1px);";

            const mkLabel = (text, side) => {
                const el = document.createElement("div");
                el.textContent = text;
                el.style.cssText =
                    `position:absolute;top:6px;${side}:8px;padding:2px 8px;border-radius:6px;` +
                    `background:rgba(0,0,0,.6);border:1px solid ${ER.border};color:${ER.text};` +
                    `font-size:11px;font-family:${ER.font};pointer-events:none;`;
                return el;
            };
            const labelA = mkLabel("A · generated", "left");
            const labelB = mkLabel("B · reference", "right");

            stage.append(videoB, videoA, divider, labelA, labelB);

            // ---------- Controles ----------
            const controls = document.createElement("div");
            controls.style.cssText =
                "display:none;align-items:center;gap:6px;padding:0 2px;flex:0 0 auto;";

            const playBtn = document.createElement("button");
            playBtn.textContent = "⏸";
            playBtn.className = "er-btn";
            // el tamaño se mantiene inline; colores/borde los aporta .er-btn
            playBtn.style.cssText =
                "width:28px;height:22px;padding:0;box-sizing:border-box;" +
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
            timeLabel.style.cssText =
                `font-size:10px;min-width:62px;text-align:right;font-family:${ER.font};`;
            timeLabel.textContent = "0:00 / 0:00";

            const fpsTag = document.createElement("span");
            fpsTag.className = "er-dim";
            fpsTag.style.cssText = `font-size:10px;font-family:${ER.font};`;
            node._vcsFps = (f) => {
                const v = Number(f);
                fpsTag.textContent = v > 0 ? `${v % 1 ? v.toFixed(2) : v} fps` : "";
            };
            controls.append(playBtn, timeline, timeLabel, fpsTag);
            root.append(stage, controls);

            const widget = node.addDOMWidget("video_compare", "VIDEO_COMPARE", root, {
                serialize: false,
                hideOnZoom: false,
            });
            // altura minima; el contenido se adapta luego al tamano real del
            // nodo (ver updateStageHeight)
            widget.computeSize = function (width) {
                if (stage.style.display === "none") return [width, -4];
                return [width, 154];
            };

            // ---------- Slider de barrido ----------
            let wipePos = 0.5;
            const setWipe = (p) => {
                wipePos = Math.min(1, Math.max(0, p));
                videoA.style.clipPath = `inset(0 ${(1 - wipePos) * 100}% 0 0)`;
                divider.style.left = `${wipePos * 100}%`;
            };
            setWipe(0.5);

            const wipeFromEvent = (e) => {
                const rect = stage.getBoundingClientRect();
                setWipe((e.clientX - rect.left) / rect.width);
            };
            stage.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                stage.setPointerCapture(e.pointerId);
                wipeFromEvent(e);
                const move = (ev) => wipeFromEvent(ev);
                const up = (ev) => {
                    stage.releasePointerCapture(ev.pointerId);
                    stage.removeEventListener("pointermove", move);
                    stage.removeEventListener("pointerup", up);
                };
                stage.addEventListener("pointermove", move);
                stage.addEventListener("pointerup", up);
            });

            // ---------- Sincronización y timeline ----------
            const syncLoop = () => {
                const dur = videoA.duration;
                if (isFinite(dur) && dur > 0) {
                    if (isFinite(videoB.duration) && videoB.duration > 0) {
                        const target = videoA.currentTime % videoB.duration;
                        if (Math.abs(videoB.currentTime - target) > 0.08) {
                            videoB.currentTime = target;
                        }
                    }
                    if (!scrubbing) {
                        timeline.value = String((videoA.currentTime / dur) * 1000);
                    }
                    timeLabel.textContent = `${fmtTime(videoA.currentTime)} / ${fmtTime(dur)}`;
                }
                rafId = requestAnimationFrame(syncLoop);
            };

            playBtn.addEventListener("click", () => {
                if (videoA.paused) {
                    videoA.play();
                    videoB.play();
                    playBtn.textContent = "⏸";
                } else {
                    videoA.pause();
                    videoB.pause();
                    playBtn.textContent = "▶";
                }
            });

            const seekFromTimeline = () => {
                const dur = videoA.duration;
                if (!isFinite(dur) || dur <= 0) return;
                const t = (Number(timeline.value) / 1000) * dur;
                videoA.currentTime = t;
                if (isFinite(videoB.duration) && videoB.duration > 0) {
                    videoB.currentTime = t % videoB.duration;
                }
            };
            timeline.addEventListener("pointerdown", () => (scrubbing = true));
            timeline.addEventListener("input", seekFromTimeline);
            timeline.addEventListener("change", () => (scrubbing = false));

            // El visor sigue directamente al tamano del nodo: toda la altura
            // que quede entre el inicio del contenido y los controles es para
            // los videos, asi que escalar el nodo escala el video en ambas
            // direcciones. El wipe funciona en % del stage, asi que el
            // letterbox no afecta a la alineacion.
            const updateStageHeight = () => {
                if (stage.style.display === "none") return;
                if (!root.offsetWidth) return; // sin layout aun
                // solo medidas de layout (widget.y + offsetHeight): nada de
                // rects de pantalla, que divergen entre entornos
                const wy = (typeof widget.y === "number" && widget.y > 0 ? widget.y : 46) + 14;
                const controlsH = controls.offsetHeight || 24;
                const h = Math.max(90, node.size[1] - wy - controlsH - 4 - 14);
                const hpx = `${Math.round(h)}px`;
                if (stage.style.height !== hpx) stage.style.height = hpx;
            };
            node._erFitCC = updateStageHeight;
            new ResizeObserver(updateStageHeight).observe(root);
            const fitTimer = setInterval(updateStageHeight, 500);

            // la caja de comparación usa el aspect ratio del video A (el generado);
            // si B tiene otro aspect ratio se centra con bandas (object-fit:contain)
            const updateAspect = () => {
                if (videoA.videoWidth && videoA.videoHeight) {
                    aspect = videoA.videoWidth / videoA.videoHeight;
                } else if (videoB.videoWidth && videoB.videoHeight) {
                    aspect = videoB.videoWidth / videoB.videoHeight;
                }
                // tamano por defecto agradable segun el aspecto del video A;
                // a partir de aqui el usuario escala libre
                requestAnimationFrame(() => {
                    const wy = widget.y || 60;
                    const w = node.size[0];
                    node.setSize([w, Math.max(node.size[1], wy + (w - 20) / aspect + 34 + 24)]);
                    updateStageHeight();
                    app.graph.setDirtyCanvas(true, true);
                });
            };
            videoA.addEventListener("loadedmetadata", updateAspect);
            videoB.addEventListener("loadedmetadata", updateAspect);

            // ---------- API para onExecuted ----------
            node.vcsSetVideos = (fileA, fileB) => {
                stage.style.display = "block";
                controls.style.display = "flex";
                updateStageHeight();
                videoA.src = viewURL(fileA);
                videoB.src = viewURL(fileB);
                videoA.play().catch(() => {});
                videoB.play().catch(() => {});
                playBtn.textContent = "⏸";
                if (rafId === null) rafId = requestAnimationFrame(syncLoop);
                node.setSize([node.size[0], Math.max(node.size[1], node.computeSize()[1])]);
                app.graph.setDirtyCanvas(true, true);
            };

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (rafId !== null) cancelAnimationFrame(rafId);
                rafId = null;
                clearInterval(fitTimer);
                videoA.src = "";
                videoB.src = "";
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const a = message?.video_a?.[0];
            const b = message?.video_b?.[0];
            if (a && b && this.vcsSetVideos) {
                this.vcsSetVideos(a, b);
            }
            const fps = message?.fps?.[0];
            if (fps != null && this._vcsFps) this._vcsFps(fps);
        };
    },
});
