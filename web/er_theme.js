// ER Academy shared visual theme.
// This file is duplicated in every ER pack so each one stays standalone.
// Palette matches the ER Academy branding: cyan + white over dark charcoal.

import { app } from "../../scripts/app.js";

export const ER = {
    accent: "#5ce1e6",       // ER cyan
    accentStrong: "#35c9cf", // pressed / stronger cyan
    accentDark: "#0f3236",   // node title bar
    accentSoft: "rgba(92,225,230,0.14)",
    bg: "#232323",           // panel background
    bgNode: "#242a2b",       // node body
    inset: "#171717",        // viewers / wells
    border: "#3a3a3a",
    borderSoft: "#2e2e2e",
    text: "#f2f2f2",
    textDim: "#9a9a9a",
    ok: "#3fd97d",           // success / installed
    error: "#ff5b5b",        // errors / missing
    warn: "#ffb84d",
    font: "'Trebuchet MS', 'Segoe UI', sans-serif",
};

const CSS = `
.er-ui { font-family: ${ER.font}; color: ${ER.text}; }
.er-panel {
    background: ${ER.bg};
    border: 1px solid ${ER.border};
    border-radius: 8px;
}
.er-title {
    color: ${ER.accent};
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 1.2px;
    text-transform: uppercase;
}
.er-btn {
    background: #2c2c2c;
    color: ${ER.text};
    border: 1px solid ${ER.border};
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    font-family: ${ER.font};
    cursor: pointer;
    transition: border-color .15s, color .15s, background .15s;
}
.er-btn:hover { border-color: ${ER.accent}; color: ${ER.accent}; }
.er-btn.er-active {
    background: ${ER.accentSoft};
    border-color: ${ER.accent};
    color: ${ER.accent};
}
.er-btn-primary {
    background: ${ER.accent};
    color: #10282a;
    border: 1px solid ${ER.accent};
    border-radius: 6px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 700;
    font-family: ${ER.font};
    letter-spacing: .4px;
    cursor: pointer;
    transition: filter .15s;
}
.er-btn-primary:hover { filter: brightness(1.12); }
.er-btn-primary:disabled { filter: grayscale(.6) brightness(.8); cursor: default; }
.er-input, .er-select {
    background: ${ER.inset};
    color: ${ER.text};
    border: 1px solid ${ER.border};
    border-radius: 5px;
    padding: 3px 7px;
    font-size: 12px;
    font-family: ${ER.font};
    outline: none;
}
.er-input:focus, .er-select:focus { border-color: ${ER.accent}; }
.er-range { accent-color: ${ER.accent}; }
.er-dim { color: ${ER.textDim}; }
.er-ok { color: ${ER.ok}; }
.er-error { color: ${ER.error}; }
.er-divider { border: none; border-top: 1px solid ${ER.borderSoft}; margin: 6px 0; }
.er-viewer {
    background: ${ER.inset};
    border: 1px solid ${ER.borderSoft};
    border-radius: 8px;
    overflow: hidden;
}
`;

/** Injects the ER Academy stylesheet once and returns the palette. */
export function erTheme() {
    if (!document.getElementById("er-academy-theme")) {
        const s = document.createElement("style");
        s.id = "er-academy-theme";
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    return ER;
}

// Ajuste generico de altura minima: la caja del nodo nunca queda mas corta
// que el contenido DOM de sus paneles (los frontends nuevos no reservan la
// altura real del dom-widget al crear el nodo y los paneles desbordaban).
// Los hijos que gestionan su propia altura (visores .er-viewer o elementos
// con height inline en px) se excluyen con un pequeno minimo reservado, para
// que sigan adaptandose libremente al tamano del nodo al escalarlo.
function erMinFit(node) {
    const now = Date.now();
    if (node.__erFitAt && now - node.__erFitAt < 250) return;
    node.__erFitAt = now;
    const dw = (node.widgets || []).find(
        (w) => w.element?.classList?.contains("er-ui") && w.element.isConnected
    );
    if (!dw) return;
    const root = dw.element;
    if (!root.offsetWidth) return; // oculto o sin layout
    // el root es transparente al raton y solo el contenido visible (los
    // hijos) captura clics: si el contenedor dom-widget estira el root mas
    // alla del contenido, esa zona invisible ya no bloquea el paneo con el
    // boton central sobre el cuerpo del nodo
    if (root.style.pointerEvents !== "none") root.style.pointerEvents = "none";
    for (const c of root.children) {
        if (!c.style.pointerEvents) c.style.pointerEvents = "auto";
    }
    // SOLO medidas de layout (offsetHeight/scrollWidth de los HIJOS): nada
    // de rects de pantalla, escala del canvas ni scrollHeight del root.
    // Son identicas en cualquier navegador/zoom/DPI, y no les afecta que el
    // contenedor dom-widget del frontend estire el root para rellenar el
    // nodo (eso creaba una realimentacion que inflaba nodos hasta 1400px).
    const gap = parseFloat(getComputedStyle(root).rowGap) || 0;
    const keepOf = (el) =>
        Math.max(40, parseFloat(getComputedStyle(el).minHeight) || 0);
    let content = 0;
    let count = 0;
    let wMax = 0;
    for (const c of root.children) {
        let h = c.offsetHeight;
        if (!h) continue; // oculto
        const cs = getComputedStyle(c);
        if (cs.position === "absolute" || cs.position === "fixed") continue;
        if (c.classList.contains("er-viewer") || c.dataset.erSelf === "1") {
            // visor autoajustable: solo se le reserva su minimo, para no
            // bloquear el encogido del nodo
            h = Math.min(h, keepOf(c));
        } else {
            // visores anidados dentro de un envoltorio: mismo descuento
            for (const el of c.querySelectorAll(".er-viewer, [data-er-self]")) {
                const eh = el.offsetHeight;
                if (!eh) continue;
                const keep = keepOf(el);
                if (eh > keep) h -= eh - keep;
            }
        }
        content += h;
        count++;
    }
    if (count) content += gap * (count - 1);
    // inicio del area de widgets dentro del nodo + margen del dom-widget
    const top = (typeof dw.y === "number" && dw.y > 0 ? dw.y : 46) + 14;
    const min = top + content + 14;
    if (!isFinite(min) || min > 1400) return;
    // reparacion al restaurar workflows: los nodos "torre" que dejo el
    // antiguo bug de crecimiento (cientos de px vacios) vuelven a su
    // altura de contenido; los tamanos razonables del usuario se respetan
    if (node.__erRepair) {
        node.__erRepair = false;
        if (node.size[1] > min + 700) {
            node.setSize([node.size[0], min]);
            node.__erFitMin = min;
            return;
        }
    }
    if (node.size[1] < min - 3) {
        // solo crece con dos medidas consecutivas coherentes: durante un
        // pan/zoom el overlay DOM va un frame por detras del canvas y una
        // medida suelta puede salir inflada (y un nodo nunca debe crecer
        // por un transitorio, porque no hay camino de vuelta automatico)
        if (Math.abs((node.__erFitMin ?? -1e9) - min) <= 3) {
            node.setSize([node.size[0], min]);
        }
    }
    node.__erFitMin = min;
    // anchura minima: SOLO el desborde real del root (contenido mas ancho
    // que la caja: scrollWidth > offsetWidth; clientWidth reporta 0 en el
    // contenedor dom-widget de este frontend) ensancha el nodo, y lo justo.
    // Nunca el scrollWidth a secas: las filas flexibles rellenan el ancho
    // del nodo y usarlas de referencia creaba un trinquete que ensanchaba
    // el nodo sin fin (+24px por tick). Sin desborde, la anchura es del
    // usuario al 100%.
    wMax = root.scrollWidth - root.offsetWidth;
    if (wMax > 4) {
        const wMin = Math.min(node.size[0] + wMax + 8, 900);
        if (Math.abs((node.__erFitMinW ?? -1e9) - wMin) <= 3) {
            node.setSize([wMin, Math.max(node.size[1], min)]);
            node.__erFitMinW = -1e9;
        } else {
            node.__erFitMinW = wMin;
        }
    } else {
        node.__erFitMinW = -1e9;
    }
}

/** Applies the ER brand colors to a node (title bar + body). */
export function erBrandNode(node) {
    if (node.__erBranded) return;
    node.__erBranded = true;
    if (!node.color || node.color === LiteGraph.NODE_DEFAULT_COLOR) node.color = ER.accentDark;
    if (!node.bgcolor || node.bgcolor === LiteGraph.NODE_DEFAULT_BGCOLOR) node.bgcolor = ER.bgNode;
    // encadena el ajuste de altura minima al redibujado del nodo, sin pisar
    // el onDrawForeground que cada pack instala en el prototipo
    const protoDraw = Object.getPrototypeOf(node).onDrawForeground;
    node.onDrawForeground = function (ctx) {
        if (protoDraw) protoDraw.apply(this, arguments);
        erMinFit(this);
    };
    // al restaurarse desde un workflow guardado, marca el nodo para la
    // reparacion unica de tamano (ver erMinFit)
    const protoConf = Object.getPrototypeOf(node).onConfigure;
    node.onConfigure = function () {
        this.__erRepair = true;
        if (protoConf) return protoConf.apply(this, arguments);
    };
}
