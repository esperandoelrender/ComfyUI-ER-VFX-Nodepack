import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const NODE_TYPE = "EREditGen";
const MAX_REFS = 8;
// todo lo tecnico vive plegado tras ⚙: la vista de trabajo es prompt +
// referencias + Generate + resultado, como una app de edicion
const ADV = [
    "unet_name", "clip_name", "clip_type", "vae_name",
    "seed", "control_after_generate", "steps", "cfg", "megapixels", "denoise",
    "weight_dtype", "sampler_name", "scheduler", "width", "height", "preserve",
];

// lista de LoRAs disponibles (una sola consulta, compartida entre nodos)
let _loraListPromise = null;
const getLoraList = () => {
    if (!_loraListPromise) {
        _loraListPromise = (async () => {
            try {
                const oi = await (await api.fetchApi("/object_info/LoraLoader")).json();
                return oi.LoraLoader.input.required.lora_name[0] || [];
            } catch (e) {
                return [];
            }
        })();
    }
    return _loraListPromise;
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
    name: "comfy.EREditGen",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        nodeType.prototype.onDrawTitleBox = function (ctx, height) {
            if (!logo.complete || !logo.naturalWidth) return;
            const s = height - 4;
            ctx.drawImage(logo, 5, -height + 2, s, s);
        };

        // en cada redibujado se asegura que el nodo abarca su contenido (el
        // visor desbordaba por debajo al reescalar o recargar workflows)
        const onDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            onDrawForeground?.apply(this, arguments);
            this._erFit?.();
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            erBrandNode(this);
            const node = this;
            let aspect = 1;
            let imgLoaded = false;

            // ---------- ranuras dinamicas ----------
            const IMG = (i) => `image_${i}`;
            // los sockets se mantienen por bloques (imagenes juntas, luego
            // mask, luego latent) aunque los slots dinamicos lleguen tarde
            const orderInputs = () => {
                const rank = (inp) => {
                    const m = /^image_(\d+)$/.exec(inp.name);
                    if (m) return 100 + Number(m[1]);
                    if (inp.name === "mask") return 200;
                    if (inp.name === "latent") return 300;
                    return 400;
                };
                const inputs = node.inputs || [];
                for (const inp of inputs) {
                    // los sockets image_N llevan SIEMPRE su nombre visible:
                    // el prompt los referencia ("the car from image 2"...).
                    // Repara workflows guardados cuando estuvieron en blanco.
                    if (/^image_\d+$/.test(inp.name) && (inp.label === " " || inp.label === "")) {
                        delete inp.label;
                    }
                }
                const sorted = inputs.slice().sort((a, b) => rank(a) - rank(b));
                if (!sorted.some((inp, i) => inputs[i] !== inp)) return;
                inputs.length = 0;
                inputs.push(...sorted);
                // los enlaces guardan el indice del slot destino: reapuntarlos
                inputs.forEach((inp, i) => {
                    if (inp.link == null) return;
                    const links = node.graph?.links || app.graph.links;
                    const l = links?.get ? links.get(inp.link) : links?.[inp.link];
                    if (l) l.target_slot = i;
                });
                node.setDirtyCanvas?.(true, true);
            };
            const syncImageInputs = () => {
                let last = 0;
                for (let i = 1; i <= MAX_REFS; i++) {
                    const s = node.findInputSlot(IMG(i));
                    if (s >= 0 && node.inputs[s].link != null) last = i;
                }
                const want = Math.min(MAX_REFS, last + 1);
                for (let i = MAX_REFS; i > want; i--) {
                    const s = node.findInputSlot(IMG(i));
                    if (s >= 0 && node.inputs[s].link == null) node.removeInput(s);
                }
                for (let i = 1; i <= want; i++) {
                    if (node.findInputSlot(IMG(i)) < 0) node.addInput(IMG(i), "IMAGE");
                }
                orderInputs();
            };
            const syncLatentInput = () => {
                const s = node.findInputSlot("latent");
                const want = !!node.properties?.er_chain;
                if (want && s < 0) node.addInput("latent", "LATENT");
                else if (!want && s >= 0 && node.inputs[s].link == null) node.removeInput(s);
                orderInputs();
            };

            // ---------- reparacion de workflows de versiones previas ----------
            const repairWidgets = () => {
                const def = node.constructor?.nodeData?.input;
                const schemaDefault = (name) => {
                    for (const grp of [def?.required, def?.optional]) {
                        const spec = grp?.[name];
                        if (spec) return spec[1]?.default;
                    }
                    return undefined;
                };
                let fixed = 0;
                for (const w of node.widgets || []) {
                    const o = w.options || {};
                    const dflt = schemaDefault(w.name);
                    const list = Array.isArray(o.values) ? o.values : null;
                    const lo = typeof o.min === "number" ? o.min : -Infinity;
                    const hi = typeof o.max === "number" ? o.max : Infinity;
                    const wantsNumber = w.type === "number" || typeof o.min === "number";
                    if (list && list.length && !list.includes(w.value)) {
                        w.value = list.includes(dflt) ? dflt : list[0];
                        fixed++;
                    } else if (wantsNumber && typeof w.value !== "number") {
                        // valor de otra version del nodo colado por indice
                        // (p. ej. un texto dentro de width): repara al default
                        const num = Number(w.value);
                        w.value = Number.isFinite(num)
                            ? Math.min(Math.max(num, lo), hi)
                            : (typeof dflt === "number" ? dflt : Math.max(0, lo));
                        fixed++;
                    } else if (typeof w.value === "number" && (w.value < lo || w.value > hi)) {
                        w.value = typeof dflt === "number" ? dflt : Math.min(Math.max(w.value, lo), hi);
                        fixed++;
                    }
                }
                if (fixed) app.graph.setDirtyCanvas(true, true);
                return fixed;
            };

            // ---------- adopcion de la escena ----------
            // al soltar el nodo en un workflow que ya usa flux klein (u otro
            // modelo de edicion) con sus loaders, copia esas selecciones para
            // que el nodo salga configurado igual que la escena
            const adoptSceneModels = () => {
                const wOf = (nd, name) => nd.widgets?.find((x) => x.name === name)?.value;
                const set = (name, val) => {
                    const w = node.widgets?.find((x) => x.name === name);
                    if (!w || val == null || val === "") return false;
                    const list = w.options?.values;
                    if (Array.isArray(list) && !list.includes(val)) return false;
                    w.value = val;
                    return true;
                };
                let adopted = 0;
                for (const nd of app.graph._nodes || []) {
                    if (nd === node) continue;
                    if (nd.type === "UNETLoader" && set("unet_name", wOf(nd, "unet_name"))) adopted++;
                    if (nd.type === "CLIPLoader") {
                        if (set("clip_name", wOf(nd, "clip_name"))) adopted++;
                        set("clip_type", wOf(nd, "type"));
                    }
                    if (nd.type === "VAELoader" && set("vae_name", wOf(nd, "vae_name"))) adopted++;
                }
                return adopted;
            };

            // ---------- prompt: altura contenida, expandible ----------
            const PROMPT_H = [110, 280];
            let promptBig = false;
            const promptW = node.widgets?.find((w) => w.name === "text");
            const applyPromptH = () => {
                if (!promptW) return;
                const h = PROMPT_H[promptBig ? 1 : 0];
                promptW.computeSize = () => [node.size[0], h];
                if (promptW.element) {
                    promptW.element.style.maxHeight = `${h}px`;
                    promptW.element.style.overflowY = "auto";
                    promptW.element.placeholder =
                        "Describe the edit or the image to generate...";
                }
                fitNode();
            };

            // ---------- ajustes avanzados plegados ----------
            const applyAdv = () => {
                const show = !!node.properties?.er_adv;
                for (const name of ADV) {
                    const w = node.widgets?.find((x) => x.name === name);
                    if (!w) continue;
                    if (w._erType === undefined) w._erType = w.type;
                    if (show) {
                        w.type = w._erType;
                        w.hidden = false;
                        delete w.computeSize;
                    } else {
                        w.type = "hidden";
                        w.hidden = true;
                        w.computeSize = () => [0, -4];
                    }
                }
                fitNode();
            };

            const fitNode = () => {
                node.setSize([node.size[0], node.computeSize()[1]]);
                app.graph.setDirtyCanvas(true, true);
            };
            // minimo continuo: si el contenido no cabe, el nodo crece (y la
            // altura del visor sigue al ancho real del nodo)
            node._erFit = () => {
                sizeStage();
                const min = node.computeSize()[1];
                if (node.size[1] < min - 2) node.setSize([node.size[0], min]);
            };

            // ---------- interfaz ----------
            const root = document.createElement("div");
            root.className = "er-ui";
            root.style.cssText = "width:100%;display:flex;flex-direction:column;gap:5px;";

            const bar = document.createElement("div");
            bar.style.cssText = "display:flex;align-items:center;gap:5px;flex:0 0 auto;";
            const slots = document.createElement("span");
            slots.className = "er-dim";
            slots.style.cssText = "font-size:9px;display:flex;gap:3px;align-items:center;";
            const mkBtn = (txt, title, primary) => {
                const b = document.createElement("button");
                b.className = primary ? "er-btn-primary" : "er-btn";
                b.textContent = txt;
                b.title = title;
                b.style.cssText = `height:${primary ? 22 : 18}px;font-size:10px;line-height:1;padding:0 ${primary ? 12 : 6}px;flex:0 0 auto;`;
                b.addEventListener("pointerdown", (e) => e.stopPropagation());
                return b;
            };
            const chainBtn = mkBtn("⛓ latent", "Show the latent input, to chain another ER EditGen without going through the VAE");
            const loraBtn = mkBtn("LoRA", "Add one or more LoRAs, loaded internally (empty list = none)");
            const advBtn = mkBtn("⚙", "Model, seed, steps and other settings");
            const expandBtn = mkBtn("⤢", "Expand / shrink the prompt box");
            const genBtn = mkBtn("▶ Generate", "Run this workflow", true);
            const info = document.createElement("span");
            info.className = "er-dim";
            info.style.cssText = "font-size:9px;flex:1;text-align:right;";
            bar.append(slots, chainBtn, loraBtn, advBtn, expandBtn, genBtn, info);
            root.appendChild(bar);

            // ---------- panel de LoRAs (lista en un widget JSON oculto) ----------
            const lorasW = node.widgets?.find((w) => w.name === "loras");
            if (lorasW) {
                lorasW.type = "hidden";
                lorasW.hidden = true;
                lorasW.computeSize = () => [0, -4];
            }
            const getLoras = () => {
                try {
                    const d = JSON.parse(lorasW?.value || "[]");
                    if (Array.isArray(d)) return d.filter((x) => x && typeof x === "object");
                } catch (e) {}
                return [];
            };
            const saveLoras = (list) => {
                if (lorasW) lorasW.value = JSON.stringify(list);
                const n2 = list.filter((x) => x.name).length;
                loraBtn.textContent = n2 ? `LoRA · ${n2}` : "LoRA";
                loraBtn.classList.toggle("er-active", n2 > 0);
            };
            const loraPanel = document.createElement("div");
            loraPanel.className = "er-panel";
            loraPanel.style.cssText =
                "display:none;flex-direction:column;gap:4px;padding:5px 7px;flex:0 0 auto;";
            root.appendChild(loraPanel);
            let loraRows = 0;
            const rebuildLoraUI = async () => {
                const options = await getLoraList();
                const list = getLoras();
                loraRows = list.length;
                loraPanel.innerHTML = "";
                list.forEach((it, i) => {
                    const row = document.createElement("div");
                    row.style.cssText = "display:flex;align-items:center;gap:5px;";
                    const sel = document.createElement("select");
                    sel.className = "er-select";
                    sel.style.cssText = "flex:1;font-size:10px;padding:2px 5px;min-width:60px;";
                    for (const name of ["", ...options]) {
                        const o = document.createElement("option");
                        o.value = name;
                        o.textContent = name || "— pick a LoRA —";
                        sel.appendChild(o);
                    }
                    sel.value = options.includes(it.name) ? it.name : "";
                    const num = document.createElement("input");
                    num.type = "number";
                    num.className = "er-input";
                    num.min = "-4";
                    num.max = "4";
                    num.step = "0.05";
                    num.value = String(typeof it.strength === "number" ? it.strength : 1);
                    num.title = "Strength";
                    num.style.cssText = "width:52px;flex:0 0 auto;font-size:10px;padding:2px 4px;text-align:right;";
                    const del = document.createElement("button");
                    del.className = "er-btn";
                    del.textContent = "✕";
                    del.title = "Remove this LoRA";
                    del.style.cssText = `height:18px;font-size:10px;line-height:1;padding:0 6px;color:${ER.error};`;
                    for (const el of [sel, num, del]) {
                        el.addEventListener("pointerdown", (e) => e.stopPropagation());
                    }
                    num.addEventListener("keydown", (e) => e.stopPropagation());
                    sel.addEventListener("change", () => {
                        const l2 = getLoras();
                        if (!l2[i]) return;
                        l2[i].name = sel.value;
                        saveLoras(l2);
                    });
                    num.addEventListener("input", () => {
                        const l2 = getLoras();
                        if (!l2[i]) return;
                        l2[i].strength = Math.min(4, Math.max(-4, Number(num.value) || 0));
                        saveLoras(l2);
                    });
                    del.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const l2 = getLoras();
                        l2.splice(i, 1);
                        saveLoras(l2);
                        rebuildLoraUI().then(fitNode);
                    });
                    row.append(sel, num, del);
                    loraPanel.appendChild(row);
                });
                const addRow = document.createElement("button");
                addRow.className = "er-btn";
                addRow.textContent = "＋ Add LoRA";
                addRow.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 10px;align-self:flex-start;";
                addRow.addEventListener("pointerdown", (e) => e.stopPropagation());
                addRow.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const l2 = getLoras();
                    l2.push({ name: "", strength: 1.0 });
                    saveLoras(l2);
                    rebuildLoraUI().then(fitNode);
                });
                loraPanel.appendChild(addRow);
                saveLoras(list); // refresca el contador del boton
            };
            loraBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                const open = loraPanel.style.display === "none";
                loraPanel.style.display = open ? "flex" : "none";
                if (open) await rebuildLoraUI();
                fitNode();
            });

            const stage = document.createElement("div");
            stage.className = "er-viewer";
            stage.style.cssText =
                "position:relative;width:100%;flex:0 0 auto;overflow:hidden;display:none;";
            const img = document.createElement("img");
            img.style.cssText =
                "position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;display:block;";
            stage.appendChild(img);
            // comparador resultado / referencia (image_1), un clic alterna
            let abOn = false;
            let resultURL = null;
            const abBtn = document.createElement("button");
            abBtn.className = "er-btn";
            abBtn.textContent = "A|B";
            abBtn.title = "Toggle result / reference (image_1)";
            abBtn.style.cssText =
                "position:absolute;top:6px;right:6px;height:22px;font-size:11px;line-height:1;padding:0 8px;opacity:.85;display:none;";
            stage.appendChild(abBtn);
            function updateViewer() {
                if (abOn) {
                    const u = thumbURLFor(IMG(1));
                    if (u) {
                        img.src = u;
                        return;
                    }
                }
                if (resultURL) img.src = resultURL;
            }
            abBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            abBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                abOn = !abOn;
                abBtn.classList.toggle("er-active", abOn);
                updateViewer();
            });
            root.appendChild(stage);

            const widget = node.addDOMWidget("er_editgen_ui", "ER_EDITGEN", root, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = function (width) {
                let h = 30; // barra
                if (loraPanel.style.display !== "none") h += 34 + loraRows * 26;
                if (imgLoaded) h += Math.min(Math.round((width - 22) / aspect), 380) + 6;
                return [width, h];
            };
            const sizeStage = () => {
                if (!imgLoaded) return;
                const w = root.clientWidth || node.size[0] - 22;
                stage.style.height = `${Math.min(Math.round(w / aspect), 380)}px`;
            };
            new ResizeObserver(sizeStage).observe(root);

            // ---------- estado: chips + miniaturas ----------
            const thumbURLFor = (slotName) => {
                const idx = node.findInputSlot?.(slotName);
                if (idx < 0 || node.inputs?.[idx]?.link == null) return null;
                const link = app.graph.links?.[node.inputs[idx].link];
                const src = link ? app.graph.getNodeById(link.origin_id) : null;
                if (!src) return null;
                const cached = app.nodeOutputs?.[String(src.id)];
                if (cached?.images?.length) return viewURL(cached.images[0]);
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

            const refreshUI = () => {
                // el visor propio sustituye al preview de lienzo del core
                // (PreviewImage): si el frontend le cuelga imagenes al nodo
                // (p. ej. el b_preview del sampler), se retiran para que no
                // asomen dibujadas debajo de la interfaz
                if (node.imgs?.length) node.imgs = [];
                // chips 1..n de referencias
                slots.innerHTML = "";
                for (let i = 1; i <= MAX_REFS; i++) {
                    const idx = node.findInputSlot?.(IMG(i));
                    if (idx < 0) continue;
                    const linked = node.inputs?.[idx]?.link != null;
                    const chip = document.createElement("span");
                    chip.textContent = String(i);
                    chip.title = `Reference image ${i}`;
                    chip.style.cssText =
                        "width:14px;height:14px;border-radius:3px;display:inline-flex;" +
                        "align-items:center;justify-content:center;font-size:8px;font-weight:bold;" +
                        (linked
                            ? `background:${ER.accent};color:#111;`
                            : `border:1px solid ${ER.border};color:#888;`);
                    slots.appendChild(chip);
                }
                const li = node.findInputSlot?.("latent");
                if (li >= 0 && node.inputs?.[li]?.link != null) {
                    const chain = document.createElement("span");
                    chain.textContent = "⛓";
                    chain.title = "Chained from another ER EditGen — no VAE round-trip";
                    chain.style.cssText = `color:${ER.ok};font-size:10px;margin-left:2px;`;
                    slots.appendChild(chain);
                }
            };

            // ---------- botones ----------
            chainBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                node.properties = node.properties || {};
                node.properties.er_chain = !node.properties.er_chain;
                chainBtn.classList.toggle("er-active", !!node.properties.er_chain);
                syncLatentInput();
                refreshUI();
                fitNode();
            });
            advBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                node.properties = node.properties || {};
                node.properties.er_adv = !node.properties.er_adv;
                advBtn.classList.toggle("er-active", !!node.properties.er_adv);
                applyAdv();
            });
            expandBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                promptBig = !promptBig;
                expandBtn.classList.toggle("er-active", promptBig);
                applyPromptH();
            });
            genBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                info.textContent = "queued…";
                app.queuePrompt(0, 1);
            });

            // ---------- resultado ----------
            node.erSetImage = (file) => {
                samplingHere = false;
                if (node._erPrevURL) {
                    URL.revokeObjectURL(node._erPrevURL);
                    node._erPrevURL = null;
                }
                const im = new Image();
                im.onload = () => {
                    aspect = im.naturalWidth / Math.max(1, im.naturalHeight);
                    resultURL = im.src;
                    abOn = false;
                    abBtn.classList.remove("er-active");
                    img.src = im.src;
                    imgLoaded = true;
                    stage.style.display = "block";
                    abBtn.style.display = thumbURLFor(IMG(1)) ? "block" : "none";
                    sizeStage();
                    fitNode();
                };
                im.src = viewURL(file);
            };
            // progreso del sampleo en vivo en la barra del nodo
            const onProgress = (e) => {
                const d = e.detail || {};
                if (String(d.node) !== String(node.id) || !d.max) return;
                info.textContent = `sampling ${Math.round((d.value / d.max) * 100)}%`;
            };
            api.addEventListener("progress", onProgress);
            // preview de la progresion del sampler en el visor del nodo:
            // los b_preview no llevan id de nodo, asi que solo se aceptan
            // mientras este nodo es el que esta en ejecucion
            let samplingHere = false;
            const onExecuting = (e) => {
                const d = e.detail;
                const id = d && typeof d === "object" ? d.node : d;
                samplingHere = id != null && String(id) === String(node.id);
            };
            const onBPreview = (e) => {
                if (!samplingHere || !(e.detail instanceof Blob)) return;
                const url = URL.createObjectURL(e.detail);
                const im = new Image();
                im.onload = () => {
                    if (!samplingHere) {
                        URL.revokeObjectURL(url);
                        return;
                    }
                    aspect = im.naturalWidth / Math.max(1, im.naturalHeight);
                    if (node._erPrevURL) URL.revokeObjectURL(node._erPrevURL);
                    node._erPrevURL = url;
                    img.src = url;
                    imgLoaded = true;
                    stage.style.display = "block";
                    sizeStage();
                    fitNode();
                };
                im.onerror = () => URL.revokeObjectURL(url);
                im.src = url;
            };
            api.addEventListener("executing", onExecuting);
            api.addEventListener("b_preview", onBPreview);
            node._erInfo = (txt) => {
                info.textContent = txt || "";
            };

            // ---------- ciclo de vida ----------
            const timer = setInterval(refreshUI, 700);
            const onRemoved = node.onRemoved;
            node.onRemoved = function () {
                clearInterval(timer);
                api.removeEventListener("progress", onProgress);
                api.removeEventListener("executing", onExecuting);
                api.removeEventListener("b_preview", onBPreview);
                if (node._erPrevURL) {
                    URL.revokeObjectURL(node._erPrevURL);
                    node._erPrevURL = null;
                }
                onRemoved?.apply(this, arguments);
            };
            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function () {
                onConnectionsChange?.apply(this, arguments);
                setTimeout(() => {
                    syncImageInputs();
                    syncLatentInput();
                    refreshUI();
                    fitNode();
                }, 60);
            };
            const onConfigure = node.onConfigure;
            node.onConfigure = function () {
                node._erConfigured = true; // nodo restaurado: no adoptar nada
                onConfigure?.apply(this, arguments);
                setTimeout(() => {
                    repairWidgets();
                    const ls = node.findInputSlot("latent");
                    if (ls >= 0 && node.inputs[ls].link != null) {
                        node.properties = node.properties || {};
                        node.properties.er_chain = true;
                    }
                    syncImageInputs();
                    syncLatentInput();
                    applyAdv();
                    applyPromptH();
                    refreshUI();
                    chainBtn.classList.toggle("er-active", !!node.properties?.er_chain);
                    advBtn.classList.toggle("er-active", !!node.properties?.er_adv);
                }, 300);
            };
            setTimeout(() => {
                repairWidgets();
                syncImageInputs();
                syncLatentInput();
                applyAdv();
                applyPromptH();
                refreshUI();
                saveLoras(getLoras()); // contador del boton LoRA
                if (!node._erConfigured) {
                    const n2 = adoptSceneModels();
                    if (n2) info.textContent = "models adopted from this workflow";
                }
                if (!node.widgets.find((w) => w.name === "unet_name")?.value) {
                    info.textContent = "open ⚙ and pick your model";
                }
            }, 140);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            const file = message?.er_editgen?.[0];
            if (file && this.erSetImage) this.erSetImage(file);
            const info = message?.er_editgen_info?.[0];
            if (info && this._erInfo) this._erInfo(info);
            // el frontend guarda el ultimo b_preview del sampler y lo dibuja
            // sobre el lienzo del nodo; nuestro visor ya muestra el resultado,
            // asi que ese preview colgado se limpia para que no asome debajo
            try {
                delete app.nodePreviewImages?.[String(this.id)];
            } catch (e) {}
        };
    },
});
