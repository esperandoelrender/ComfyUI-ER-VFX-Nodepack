import { app } from "../../scripts/app.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme(); // inyecta el tema ER Academy una sola vez

const NODE_TYPE = "ERAutoResolution";

// espejo de MODELS/RATIOS en Python
const MODELS = {
    "SD 1.5": { pixels: 512 * 512, multiple: 64 },
    "SDXL / Pony / Illustrious": { pixels: 1024 * 1024, multiple: 64 },
    "SD 3 / 3.5": { pixels: 1024 * 1024, multiple: 64 },
    "FLUX.1 (1MP)": { pixels: 1024 * 1024, multiple: 16 },
    "FLUX.1 (2MP)": { pixels: 2 * 1024 * 1024, multiple: 16 },
    "FLUX.2 / Klein (2MP)": { pixels: 2 * 1024 * 1024, multiple: 16 },
    "FLUX.2 (4MP)": { pixels: 4 * 1024 * 1024, multiple: 16 },
    "Qwen-Image": { pixels: 1328 * 1328, multiple: 16 },
    "HiDream-I1": { pixels: 1024 * 1024, multiple: 64 },
};
const RATIOS = {
    "1:1": 1, "4:3": 4 / 3, "3:4": 3 / 4, "3:2": 1.5, "2:3": 2 / 3,
    "16:9": 16 / 9, "9:16": 9 / 16, "21:9": 21 / 9, "9:21": 9 / 21,
};

const logo = new Image();
logo.src = new URL("./logo.png", import.meta.url).href;
logo.onload = () => app.graph?.setDirtyCanvas(true, true);

function computeResolution(model, ratio) {
    const cfg = MODELS[model];
    if (!cfg) return null;
    const m = cfg.multiple;
    let w = Math.sqrt(cfg.pixels * ratio);
    let h = w / ratio;
    w = Math.max(m, Math.round(w / m) * m);
    h = Math.max(m, Math.round(h / m) * m);
    return [w, h];
}

app.registerExtension({
    name: "comfy.ERAutoResolution",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        // logo en la barra de título
        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            const node = this;

            erBrandNode(node);

            const label = document.createElement("div");
            label.className = "er-ui";
            // pointer-events:none: es solo informativo; si el frontend deja
            // que el texto desborde el nodo, no debe robar clics del lienzo
            label.style.cssText =
                "width:100%;text-align:center;color:" + ER.textDim + ";font-size:12px;" +
                "font-family:" + ER.font + ";letter-spacing:.5px;padding:2px 0;user-select:none;" +
                "pointer-events:none;";
            // decoración en gris, números en cian ER
            const setLabel = (deco, res, suffix) => {
                label.textContent = "";
                const arrow = document.createElement("span");
                arrow.style.color = ER.textDim;
                arrow.textContent = deco;
                label.appendChild(arrow);
                if (res) {
                    const nums = document.createElement("span");
                    nums.style.cssText = "color:" + ER.accent + ";font-weight:700;";
                    nums.textContent = res;
                    label.appendChild(nums);
                }
                if (suffix) {
                    const tail = document.createElement("span");
                    tail.style.color = ER.textDim;
                    tail.textContent = suffix;
                    label.appendChild(tail);
                }
            };
            setLabel("→ …");
            const widget = node.addDOMWidget("er_res_label", "ER_RES", label, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = (width) => [width, 20];
            // el frontend nuevo no siempre reserva el alto pedido: asegura
            // hueco para la etiqueta dentro del nodo
            setTimeout(() => {
                const min = node.computeSize();
                node.setSize([
                    Math.max(node.size[0], min[0]),
                    Math.max(node.size[1], min[1] + 34),
                ]);
            }, 50);

            let lastKey = null;
            const update = () => {
                const model = node.widgets?.find((w) => w.name === "model")?.value;
                const ratioName = node.widgets?.find((w) => w.name === "aspect_ratio")?.value;
                const key = model + "|" + ratioName + "|" + (node._erLastRes || "");
                if (key !== lastKey) {
                    lastKey = key;
                    if (RATIOS[ratioName]) {
                        const r = computeResolution(model, RATIOS[ratioName]);
                        if (r) setLabel("→ ", `${r[0]} × ${r[1]}`);
                        else setLabel("→ …");
                    } else if (node._erLastRes) {
                        setLabel("→ ", `${node._erLastRes[0]} × ${node._erLastRes[1]}`, " (auto)");
                    } else {
                        setLabel("→ auto (run once)");
                    }
                }
                node._erResRaf = requestAnimationFrame(update);
            };
            node._erResRaf = requestAnimationFrame(update);

            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                if (node._erResRaf) cancelAnimationFrame(node._erResRaf);
                onRemoved?.apply(this, arguments);
            };
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const res = message?.er_res?.[0];
            if (Array.isArray(res)) this._erLastRes = res;
        };
    },
});
