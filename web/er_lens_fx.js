import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { erTheme, erBrandNode, ER } from "./er_theme.js";

erTheme();

const logo = new Image();
logo.src = new URL("./logo.png", import.meta.url).href;
logo.onload = () => app.graph?.setDirtyCanvas(true, true);

const MAX_PREVIEW = 640;
const MAX_FLARES = 4;
const DEFAULT_FLARE = {
    x: 0.7, y: 0.3, intensity: 1.0, core: 1.0, core_radius: 1.0,
    scale: 1.0, hue: 35.0,
    sat: 0.35, ghosts: 0.5, streak: 0.4, streak_hue: 245.0,
    streak_width: 1.0, rays: 0.3, ray_count: 7.0,
    // grados: gira el patron de puntas del starburst alrededor de la luz
    ray_rotation: 0.0,
    // grados: SOLO el angulo del reguero de ghosts (girado alrededor de la
    // luz; 0 = eje natural luz->centro). El streak siempre va recto.
    rotation: 0.0,
    on: true, open: true,
};

// presets de flare: looks clasicos de cine (rellenan valores y todo queda
// editable; no tocan la posicion del flare)
const FLARE_PRESETS = {
    "anamorphic blue": { intensity: 1.1, core: 0.8, core_radius: 0.8, scale: 1.0, hue: 210, sat: 0.25, ghosts: 0.15, streak: 0.9, streak_hue: 215, streak_width: 1.6, rays: 0.05, ray_count: 4, rotation: 0 },
    "vintage prime": { intensity: 0.9, core: 1.0, core_radius: 1.3, scale: 1.2, hue: 38, sat: 0.45, ghosts: 0.8, streak: 0.05, streak_hue: 40, streak_width: 1.0, rays: 0.15, ray_count: 6, rotation: 0 },
    "70s zoom ghosts": { intensity: 1.0, core: 0.5, core_radius: 1.0, scale: 1.1, hue: 30, sat: 0.5, ghosts: 1.0, streak: 0.0, streak_hue: 40, streak_width: 1.0, rays: 0.1, ray_count: 5, rotation: 0 },
    "golden sun": { intensity: 1.2, core: 1.6, core_radius: 2.0, scale: 1.4, hue: 40, sat: 0.5, ghosts: 0.45, streak: 0.1, streak_hue: 45, streak_width: 1.2, rays: 0.5, ray_count: 8, rotation: 0 },
    "clean modern": { intensity: 0.6, core: 0.7, core_radius: 0.9, scale: 0.9, hue: 215, sat: 0.15, ghosts: 0.15, streak: 0.12, streak_hue: 220, streak_width: 0.9, rays: 0.2, ray_count: 12, rotation: 0 },
    "sci-fi streak": { intensity: 1.1, core: 1.2, core_radius: 0.6, scale: 1.0, hue: 195, sat: 0.4, ghosts: 0.1, streak: 1.0, streak_hue: 190, streak_width: 0.6, rays: 0.15, ray_count: 4, rotation: 0 },
    "night sodium": { intensity: 1.0, core: 1.2, core_radius: 0.7, scale: 0.9, hue: 28, sat: 0.7, ghosts: 0.3, streak: 0.25, streak_hue: 30, streak_width: 0.9, rays: 0.4, ray_count: 6, rotation: 0 },
    "car headlight": { intensity: 1.1, core: 1.5, core_radius: 0.5, scale: 0.8, hue: 210, sat: 0.12, ghosts: 0.15, streak: 0.35, streak_hue: 220, streak_width: 0.8, rays: 0.7, ray_count: 9, rotation: 0 },
};

// parametros del Lens Effects, agrupados en paneles plegables
const DEFAULT_LENS = {
    distortion: 0.0, distortion_fine: 0.0, chromatic_aberration: 0.0,
    vignette: 0.0, vignette_softness: 0.5, vignette_x: 0.5, vignette_y: 0.5,
    sharpen: 0.0, glow: 0.0, glow_threshold: 0.75, glow_size: 3.0,
    corner_softness: 0.0, diffusion: 0.0, halation: 0.0,
};
const LENS_GROUPS = [
    ["Distortion", [
        ["distortion", "Distortion", -1, 1, 0.01],
        ["distortion_fine", "Fine (k2)", -1, 1, 0.01],
        ["chromatic_aberration", "Chromatic ab.", 0, 0.03, 0.0005],
    ]],
    ["Vignette", [
        ["vignette", "Amount", 0, 1, 0.01],
        ["vignette_softness", "Softness", 0, 1, 0.01],
        ["vignette_x", "Center X", 0, 1, 0.005],
        ["vignette_y", "Center Y", 0, 1, 0.005],
    ]],
    ["Sharpen & Glow", [
        ["sharpen", "Sharpen", 0, 2, 0.01],
        ["glow", "Glow", 0, 1, 0.01],
        ["glow_threshold", "Threshold", 0, 1, 0.01],
        ["glow_size", "Size %", 0.5, 10, 0.1],
    ]],
    ["Optics", [
        ["corner_softness", "Corner soft", 0, 1, 0.01],
        ["diffusion", "Diffusion", 0, 1, 0.01],
        ["halation", "Halation", 0, 1, 0.01],
    ]],
];

// presets de tipo de lente: RELLENAN los valores y quedan editables
// (punto de partida, no bloqueo)
const LENS_PRESETS = {
    "modern prime": { distortion: -0.03, chromatic_aberration: 0.002, vignette: 0.15, vignette_softness: 0.6, sharpen: 0.25, corner_softness: 0.05 },
    "vintage prime": { distortion: 0.06, distortion_fine: 0.03, chromatic_aberration: 0.008, vignette: 0.35, vignette_softness: 0.55, corner_softness: 0.3, diffusion: 0.15, halation: 0.1, glow: 0.1, glow_threshold: 0.8, glow_size: 4 },
    "vintage anamorphic": { distortion: -0.08, chromatic_aberration: 0.01, vignette: 0.45, vignette_softness: 0.5, corner_softness: 0.35, diffusion: 0.2, halation: 0.2, glow: 0.15, glow_threshold: 0.75, glow_size: 5 },
    "fisheye": { distortion: 0.65, distortion_fine: 0.25, chromatic_aberration: 0.012, vignette: 0.5, vignette_softness: 0.7 },
    "smartphone": { distortion: 0.04, chromatic_aberration: 0.004, sharpen: 0.8, vignette: 0.1 },
    "dreamy diffusion": { diffusion: 0.6, glow: 0.3, glow_threshold: 0.6, glow_size: 5, corner_softness: 0.2, vignette: 0.2 },
    "old film": { distortion: 0.05, chromatic_aberration: 0.006, vignette: 0.4, vignette_softness: 0.5, corner_softness: 0.25, halation: 0.35, diffusion: 0.15 },
};

// camera dirt: motas + manchas procedurales que se revelan con las luces
const DEFAULT_DIRT = {
    amount: 1.0, size: 1.0, density: 0.5, smudge: 0.5,
    softness: 0.4, seed: 7,
    base: 0.15, highlights: 1.0, threshold: 0.7, hue: 40, sat: 0.08,
};
const DIRT_GROUPS = [
    ["Dirt", [
        ["amount", "Amount", 0, 2, 0.01],
        ["size", "Size", 0.2, 3, 0.01],
        ["density", "Density", 0, 1, 0.01],
        ["smudge", "Smudges", 0, 1, 0.01],
        ["softness", "Softness", 0, 1, 0.01],
        ["seed", "Seed", 0, 99, 1],
    ]],
    ["Reveal", [
        ["base", "Base vis.", 0, 1, 0.01],
        ["highlights", "Highlights", 0, 2, 0.01],
        ["threshold", "Threshold", 0, 1, 0.01],
        ["hue", "Tint hue", 0, 360, 1],
        ["sat", "Tint sat", 0, 1, 0.01],
    ]],
];

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

// espejo de apply_lens_effects en Python: distorsion+CA -> sharpen -> glow -> vineta
// (distorsion Brown-Conrady k1+k2 con radio circular corregido por aspecto)
const FRAG_LENS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_vigpos;
uniform float u_dist, u_dist2, u_ca, u_vig, u_vigsoft, u_sharpen, u_glow, u_glowthr, u_glowsize;
uniform float u_corner, u_diff, u_hal, u_split;

vec2 distUV(vec2 uv, float scale) {
    vec2 d = uv * 2.0 - 1.0;
    float aspect = u_res.x / u_res.y;
    float r2 = (d.x * d.x * aspect * aspect + d.y * d.y) / (aspect * aspect + 1.0);
    float norm = max(0.001, 1.0 + u_dist + u_dist2);
    float m = (1.0 + u_dist * r2 + u_dist2 * r2 * r2) / norm;
    return clamp(d * m * scale, -1.0, 1.0) * 0.5 + 0.5;
}
vec3 distCA(vec2 uv) {
    return vec3(
        texture2D(u_tex, distUV(uv, 1.0 + u_ca)).r,
        texture2D(u_tex, distUV(uv, 1.0)).g,
        texture2D(u_tex, distUV(uv, 1.0 - u_ca)).b
    );
}
void main() {
    vec3 base = distCA(v_uv);
    vec3 col = base;
    if (u_sharpen > 0.0) {
        vec2 px = 1.0 / u_res;
        vec3 mean = vec3(0.0);
        for (int i = -1; i <= 1; i++)
            for (int j = -1; j <= 1; j++)
                mean += distCA(v_uv + vec2(float(i), float(j)) * px);
        mean /= 9.0;
        col = base + u_sharpen * (base - mean);
    }

    // blur suave compartido por corner softness y diffusion
    vec3 blurSoft = vec3(0.0);
    if (u_corner > 0.0 || u_diff > 0.0) {
        float sigma = 0.015;
        vec2 s = vec2(sigma, sigma * u_res.x / u_res.y);
        float wsum = 0.0;
        for (int i = -6; i <= 6; i++) {
            for (int j = -6; j <= 6; j++) {
                vec2 o = vec2(float(i), float(j)) * 0.5;
                float w = exp(-dot(o, o) * 0.5);
                blurSoft += w * distCA(v_uv + o * s);
                wsum += w;
            }
        }
        blurSoft /= wsum;
    }

    // suavidad de esquinas: mezcla radial (radio fotografico)
    if (u_corner > 0.0) {
        vec2 dd = v_uv * 2.0 - 1.0;
        float aspect = u_res.x / u_res.y;
        float rp = sqrt((dd.x * dd.x * aspect * aspect + dd.y * dd.y) / (aspect * aspect + 1.0));
        float mcorner = clamp(u_corner * smoothstep(0.35, 1.0, rp), 0.0, 1.0);
        col = mix(col, blurSoft, mcorner);
    }

    // glow + halation (mismo blur, la halation tenida de rojo)
    if (u_glow > 0.0 || u_hal > 0.0) {
        float sigma = u_glowsize / 100.0;
        vec2 s = vec2(sigma, sigma * u_res.x / u_res.y);
        vec3 acc = vec3(0.0);
        float wsum = 0.0;
        for (int i = -6; i <= 6; i++) {
            for (int j = -6; j <= 6; j++) {
                vec2 o = vec2(float(i), float(j)) * 0.5;
                float w = exp(-dot(o, o) * 0.5);
                acc += w * max(distCA(v_uv + o * s) - u_glowthr, 0.0);
                wsum += w;
            }
        }
        vec3 g = acc / wsum * 2.5066 * 0.4;
        col += u_glow * g;
        col += u_hal * 1.5 * g * vec3(1.0, 0.30, 0.18);
    }

    // diffusion (Pro-Mist): levanta y florece con la imagen desenfocada
    if (u_diff > 0.0) {
        col = 1.0 - (1.0 - col) * (1.0 - u_diff * 0.65 * clamp(blurSoft, 0.0, 1.0));
    }

    vec2 d = v_uv * 2.0 - 1.0;
    vec2 cv = u_vigpos * 2.0 - 1.0;
    float r = length(d - cv);
    float v = 1.0 - u_vig * smoothstep(1.0 - u_vigsoft * 1.2, 1.55, r);
    vec3 outc = clamp(col * v, 0.0, 1.0);

    // comparador A/B: a la izquierda del corte se ve el original intacto
    if (u_split > 0.001) {
        if (v_uv.x < u_split) outc = texture2D(u_tex, v_uv).rgb;
        if (abs(v_uv.x - u_split) < 1.2 / u_res.x) outc = vec3(0.36, 0.88, 0.9);
    }
    gl_FragColor = vec4(outc, 1.0);
}`;

// espejo de flare_field en Python: hasta 4 flares independientes
// u_fA = (x, y, intensity, scale) · u_fB = (hue, sat, ghosts, streak)
// u_fC = (rays, streak_hue, on, ray_count)
// u_fD = (streak_width, core, core_radius, rotation_rad)
// u_fE = (ray_rotation_rad, -, -, -)
const FRAG_FLARE = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec4 u_fA[4];
uniform vec4 u_fB[4];
uniform vec4 u_fC[4];
uniform vec4 u_fD[4];
uniform vec4 u_fE[4];
uniform float u_count;
uniform float u_ab;

vec3 hsv(float h, float s) {
    h = mod(mod(h, 360.0) + 360.0, 360.0) / 60.0;
    float x = 1.0 - abs(mod(h, 2.0) - 1.0);
    vec3 c = h < 1.0 ? vec3(1.0, x, 0.0) : h < 2.0 ? vec3(x, 1.0, 0.0)
           : h < 3.0 ? vec3(0.0, 1.0, x) : h < 4.0 ? vec3(0.0, x, 1.0)
           : h < 5.0 ? vec3(x, 0.0, 1.0) : vec3(1.0, 0.0, x);
    return 1.0 - s * (1.0 - c);
}
float g2(float d, float s) { float q = d / s; return exp(-q * q); }

vec3 flareOne(vec2 p, vec4 A, vec4 B, vec4 C, vec4 D, vec4 E, float aspect) {
    vec2 L = vec2((A.x - 0.5) * aspect, A.y - 0.5);
    float scale = A.w;
    vec2 dL = p - L;
    float rl = length(dL);
    vec3 tint = hsv(B.x, B.y);
    float cosr = cos(D.w);
    float sinr = sin(D.w);

    // nucleo + halo con ganancia (core) y radio (core_radius) propios
    float crad = scale * max(0.05, D.z);
    float core = (1.2 * g2(rl, 0.05 * crad) + 0.45 * g2(rl, 0.16 * crad)) * D.y;
    vec3 acc = core * tint;

    if (C.x > 0.0) {
        float ang = atan(dL.y, dL.x) - E.x;
        float k = max(1.0, C.w) * 0.5;
        float star = pow(abs(cos(ang * k)), 24.0) * exp(-pow(rl / (0.45 * scale), 1.5));
        acc += C.x * 0.6 * star * tint;
    }
    if (B.w > 0.0) {
        float sw = 0.015 * max(0.05, D.x) * scale;
        float st = g2(dL.y, sw) * exp(-abs(dL.x) / (0.55 * scale));
        acc += B.w * st * hsv(C.y, min(1.0, B.y + 0.2));
    }
    if (B.z > 0.0) {
        // (t, size, hueShift, w) - mismas constantes que GHOSTS en Python
        vec4 G[6];
        G[0] = vec4(-0.55, 0.11, 160.0, 0.25);
        G[1] = vec4(0.32, 0.06, 30.0, 0.35);
        G[2] = vec4(0.55, 0.12, 60.0, 0.25);
        G[3] = vec4(0.85, 0.05, 210.0, 0.30);
        G[4] = vec4(1.20, 0.16, 100.0, 0.22);
        G[5] = vec4(1.55, 0.09, 320.0, 0.28);
        // el reguero sale de la luz por el eje natural luz->centro,
        // girado D.w alrededor de la luz (angulo del ghost)
        for (int i = 0; i < 6; i++) {
            vec2 gb = -L * (G[i].x + 1.0);
            vec2 gp = L + vec2(gb.x * cosr - gb.y * sinr, gb.x * sinr + gb.y * cosr);
            float d = length(p - gp);
            acc += B.z * G[i].w * g2(d, G[i].y * scale) * hsv(B.x + G[i].z, min(1.0, B.y + 0.35));
        }
        float rc = length(p);
        acc += B.z * 0.30 * g2(rc - 0.42 * scale, 0.10) * tint;
    }
    return acc * A.z;
}

void main() {
    // comparador A/B: original intacto
    if (u_ab > 0.5) {
        gl_FragColor = vec4(texture2D(u_tex, v_uv).rgb, 1.0);
        return;
    }
    float aspect = u_res.x / u_res.y;
    vec2 p = vec2((v_uv.x - 0.5) * aspect, v_uv.y - 0.5);
    vec3 total = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        if (float(i) >= u_count) break;
        if (u_fC[i].z < 0.5) continue;
        total += flareOne(p, u_fA[i], u_fB[i], u_fC[i], u_fD[i], u_fE[i], aspect);
    }
    vec3 img = texture2D(u_tex, v_uv).rgb;
    vec3 flare = clamp(total, 0.0, 1.0);
    gl_FragColor = vec4(clamp(1.0 - (1.0 - img) * (1.0 - flare), 0.0, 1.0), 1.0);
}`;

// espejo de apply_camera_dirt en Python: motas Worley + manchas fbm
// (hash permute mod-289, exacto en float32) reveladas por las altas luces
const FRAG_DIRT = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_amount, u_size, u_density, u_smudge, u_soft, u_seed;
uniform float u_base, u_hi, u_thr, u_hue, u_sat, u_split;

vec3 hsv(float h, float s) {
    h = mod(mod(h, 360.0) + 360.0, 360.0) / 60.0;
    float x = 1.0 - abs(mod(h, 2.0) - 1.0);
    vec3 c = h < 1.0 ? vec3(1.0, x, 0.0) : h < 2.0 ? vec3(x, 1.0, 0.0)
           : h < 3.0 ? vec3(0.0, 1.0, x) : h < 4.0 ? vec3(0.0, x, 1.0)
           : h < 5.0 ? vec3(x, 0.0, 1.0) : vec3(1.0, 0.0, x);
    return 1.0 - s * (1.0 - c);
}
float perm(float x) { return mod((x * 34.0 + 1.0) * x, 289.0); }
float hash2(vec2 c, float k) {
    float xx = mod(c.x + k * 31.0, 289.0);
    float yy = mod(c.y + k * 17.0, 289.0);
    return fract(perm(perm(xx) + yy) / 41.0);
}
float vnoise01(vec2 q, float k) {
    vec2 c = floor(q);
    vec2 f = q - c;
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash2(c, k);
    float b = hash2(c + vec2(1.0, 0.0), k);
    float cc = hash2(c + vec2(0.0, 1.0), k);
    float d = hash2(c + vec2(1.0, 1.0), k);
    return a + (b - a) * u.x + (cc - a) * u.y + (a - b - cc + d) * u.x * u.y;
}
float dirtMap(vec2 p) {
    float size = max(0.2, u_size);
    // motas: Worley con radio, existencia y opacidad aleatorios por celda
    vec2 q = p * (18.0 / size);
    vec2 cq = floor(q);
    vec2 fq = q - cq;
    float edge = 0.85 - 0.75 * u_soft;
    float speck = 0.0;
    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            vec2 cell = cq + vec2(float(ox), float(oy));
            float hx = hash2(cell, u_seed);
            float hy = hash2(cell, u_seed + 57.0);
            float hr = hash2(cell, u_seed + 113.0);
            float he = hash2(cell, u_seed + 171.0);
            float ho = hash2(cell, u_seed + 229.0);
            vec2 dv = vec2(float(ox), float(oy)) + vec2(hx, hy) - fq;
            float d = length(dv);
            float r = 0.10 + 0.22 * hr;
            // smoothstep invertido a mano (edge1 < edge0 es UB en GLSL)
            float t = clamp((d - r) / (r * edge - r), 0.0, 1.0);
            float s = t * t * (3.0 - 2.0 * t);
            speck = max(speck, s * (1.0 - step(u_density, he)) * (0.45 + 0.55 * ho));
        }
    }
    // manchas: fbm de 3 octavas, umbral suave
    vec2 q2 = p * (3.5 / size);
    float n1 = vnoise01(q2, u_seed + 300.0);
    float n2 = vnoise01(q2 * 2.0 + vec2(11.0, 7.0), u_seed + 300.0);
    float n3 = vnoise01(q2 * 4.0 + vec2(23.0, 29.0), u_seed + 300.0);
    float fbm = (0.5 * n1 + 0.25 * n2 + 0.125 * n3) / 0.875;
    float smm = smoothstep(0.5, 0.9, fbm) * u_smudge;
    return clamp(speck + smm * 0.75, 0.0, 1.0);
}
void main() {
    float aspect = u_res.x / u_res.y;
    vec3 img = texture2D(u_tex, v_uv).rgb;
    vec2 p = vec2(v_uv.x * aspect, v_uv.y);
    float dirt = dirtMap(p) * u_amount;

    // altas luces (desenfocadas) que revelan la suciedad
    float sigma = 0.04;
    vec2 s = vec2(sigma, sigma * aspect);
    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int i = -6; i <= 6; i++) {
        for (int j = -6; j <= 6; j++) {
            vec2 o = vec2(float(i), float(j)) * 0.5;
            float w = exp(-dot(o, o) * 0.5);
            acc += w * max(texture2D(u_tex, v_uv + o * s).rgb - u_thr, 0.0);
            wsum += w;
        }
    }
    vec3 hl = acc / wsum * 2.5066 * 0.4;
    vec3 vis = vec3(u_base) + u_hi * 2.0 * hl;
    vec3 add = dirt * hsv(u_hue, u_sat) * vis;
    vec3 outc = clamp(img + add, 0.0, 1.0);

    // comparador A/B: original intacto
    if (u_split > 0.001 && v_uv.x < u_split) outc = img;
    gl_FragColor = vec4(outc, 1.0);
}`;

// espejo de apply_camera_defocus en Python: desenfoque con kernel de
// diafragma (muestreo de disco en espiral de Vogel), bokeh ponderado por
// altas luces y fringe cromatico en el borde
const FRAG_DEFOCUS = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_radius, u_blades, u_rot, u_boost, u_thr, u_fringe, u_split;

float apShape(float theta) {
    // radio del poligono regular (1.0 si es disco)
    if (u_blades < 2.5) return 1.0;
    float n = floor(u_blades + 0.5);
    float stp = 6.2831853 / n;
    float a = mod(theta - u_rot, stp) - stp * 0.5;
    return cos(3.1415926 / n) / max(cos(a), 1e-3);
}
float hw(vec3 c) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float t = clamp((l - u_thr) / max(1.0 - u_thr, 1e-3), 0.0, 1.0);
    return 1.0 + u_boost * 4.0 * t * t;
}
void main() {
    vec3 img = texture2D(u_tex, v_uv).rgb;
    float rpx = u_radius / 100.0;                 // radio en fraccion del ancho
    vec3 outc;
    if (rpx * u_res.x < 0.75) {
        outc = img;
    } else {
        vec2 px = vec2(rpx, rpx * u_res.x / u_res.y); // a UV (x e y)
        float sr = 1.0 + u_fringe * 0.10;
        float sb = 1.0 - u_fringe * 0.10;
        vec3 acc = vec3(0.0);
        vec3 wsum = vec3(0.0);
        for (int i = 0; i < 48; i++) {
            float fi = float(i);
            float t = (fi + 0.5) / 48.0;
            float theta = fi * 2.39996323;         // angulo aureo (Vogel)
            float rr = sqrt(t) * apShape(theta);
            vec2 dir = vec2(cos(theta), sin(theta)) * rr * px;
            vec3 cg = texture2D(u_tex, v_uv + dir).rgb;
            vec3 cr = texture2D(u_tex, v_uv + dir * sr).rgb;
            vec3 cb = texture2D(u_tex, v_uv + dir * sb).rgb;
            float wg = hw(cg); float wr = hw(cr); float wb = hw(cb);
            acc += vec3(cr.r * wr, cg.g * wg, cb.b * wb);
            wsum += vec3(wr, wg, wb);
        }
        outc = clamp(acc / max(wsum, vec3(1e-5)), 0.0, 1.0);
    }
    // comparador A/B: original intacto
    if (u_split > 0.001 && v_uv.x < u_split) outc = img;
    gl_FragColor = vec4(outc, 1.0);
}`;

const DEFAULT_DEFOCUS = {
    radius: 2.0, blades: 0, blade_rotation: 0,
    boost: 1.5, threshold: 0.75, fringe: 0.0,
};
const DEFOCUS_GROUPS = [
    ["Lens", [
        ["radius", "Radius %", 0, 8, 0.05],
        ["blades", "Blades", 0, 12, 1],
        ["blade_rotation", "Blade rot.", -90, 90, 1],
    ]],
    ["Bokeh", [
        ["boost", "Highlight boost", 0, 4, 0.05],
        ["threshold", "Threshold", 0, 0.99, 0.01],
        ["fringe", "Chromatic fringe", 0, 1, 0.01],
    ]],
];

const NODE_DEFS = {
    ERLensEffects: {
        frag: FRAG_LENS,
        lens: true,
        setUniforms(gl, u, p) {
            gl.uniform1f(u.u_dist, p.distortion);
            gl.uniform1f(u.u_dist2, p.distortion_fine);
            gl.uniform1f(u.u_ca, p.chromatic_aberration);
            gl.uniform1f(u.u_vig, p.vignette);
            gl.uniform1f(u.u_vigsoft, p.vignette_softness);
            gl.uniform2f(u.u_vigpos, p.vignette_x, p.vignette_y);
            gl.uniform1f(u.u_sharpen, p.sharpen);
            gl.uniform1f(u.u_glow, p.glow);
            gl.uniform1f(u.u_glowthr, p.glow_threshold);
            gl.uniform1f(u.u_glowsize, p.glow_size);
            gl.uniform1f(u.u_corner, p.corner_softness);
            gl.uniform1f(u.u_diff, p.diffusion);
            gl.uniform1f(u.u_hal, p.halation);
            gl.uniform1f(u.u_split, p._split || 0);
        },
        flare: false,
        groups: LENS_GROUPS,
        defaults: DEFAULT_LENS,
        presets: LENS_PRESETS,
        migrate: true, // migra los widgets sueltos del formato antiguo
    },
    ERLensFlare: { frag: FRAG_FLARE, flare: true },
    ERLensCameraDirt: {
        frag: FRAG_DIRT,
        lens: true,
        setUniforms(gl, u, p) {
            gl.uniform1f(u.u_amount, p.amount);
            gl.uniform1f(u.u_size, p.size);
            gl.uniform1f(u.u_density, p.density);
            gl.uniform1f(u.u_smudge, p.smudge);
            gl.uniform1f(u.u_soft, p.softness);
            gl.uniform1f(u.u_seed, Math.floor(p.seed));
            gl.uniform1f(u.u_base, p.base);
            gl.uniform1f(u.u_hi, p.highlights);
            gl.uniform1f(u.u_thr, p.threshold);
            gl.uniform1f(u.u_hue, p.hue);
            gl.uniform1f(u.u_sat, p.sat);
            gl.uniform1f(u.u_split, p._split || 0);
        },
        flare: false,
        groups: DIRT_GROUPS,
        defaults: DEFAULT_DIRT,
        presets: null,
    },
    ERCameraDefocus: {
        frag: FRAG_DEFOCUS,
        lens: true,
        setUniforms(gl, u, p) {
            gl.uniform1f(u.u_radius, p.radius);
            gl.uniform1f(u.u_blades, p.blades);
            gl.uniform1f(u.u_rot, (p.blade_rotation * Math.PI) / 180);
            gl.uniform1f(u.u_boost, p.boost);
            gl.uniform1f(u.u_thr, p.threshold);
            gl.uniform1f(u.u_fringe, p.fringe);
            gl.uniform1f(u.u_split, p._split || 0);
        },
        flare: false,
        groups: DEFOCUS_GROUPS,
        defaults: DEFAULT_DEFOCUS,
        presets: null,
    },
};

function initGL(canvas, fragSrc) {
    const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true });
    if (!gl) return null;
    const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error("[ERLensFX]", gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
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
        uniforms[info.name.replace("[0]", "")] = gl.getUniformLocation(prog, info.name);
    }
    return { gl, prog, tex, uniforms };
}

app.registerExtension({
    name: "comfy.ERLensFX",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        const def = NODE_DEFS[nodeData.name];
        if (!def) return;

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

            // widget oculto con la lista de flares
            let flaresW = null;
            if (def.flare) {
                flaresW = node.widgets?.find((w) => w.name === "flares");
                if (flaresW) {
                    flaresW.type = "hidden";
                    flaresW.computeSize = () => [0, -4];
                    flaresW.hidden = true;
                }
            }
            // widget oculto con los parametros del lens effects
            let paramsW = null;
            if (def.lens) {
                paramsW = node.widgets?.find((w) => w.name === "params");
                if (paramsW) {
                    paramsW.type = "hidden";
                    paramsW.computeSize = () => [0, -4];
                    paramsW.hidden = true;
                }
            }
            const DEFAULTS = def.defaults || DEFAULT_LENS;
            const getLens = () => {
                try {
                    const d = JSON.parse(paramsW?.value || "{}");
                    if (d && typeof d === "object" && !Array.isArray(d)) return { ...DEFAULTS, _open: {}, ...d };
                } catch (e) {}
                return { ...DEFAULTS, _open: {} };
            };
            const saveLens = (p) => {
                if (paramsW) paramsW.value = JSON.stringify(p);
            };
            const getFlares = () => {
                try {
                    const d = JSON.parse(flaresW?.value || "[]");
                    if (Array.isArray(d)) return d.slice(0, MAX_FLARES).map((f) => ({ ...DEFAULT_FLARE, ...f }));
                } catch (e) {}
                return [];
            };
            const saveFlares = (list) => {
                if (flaresW) flaresW.value = JSON.stringify(list.slice(0, MAX_FLARES));
            };

            // ---------- DOM ----------
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

            // ---------- UI multi-flare ----------
            let overlay = null;
            let markers = [];
            let rotHandles = [];
            let flaresBox = null;
            let rebuildUI = () => {};
            const ROT_R = 30; // radio en px de pantalla del tirador de rotacion
            if (def.flare) {
                overlay = document.createElement("div");
                overlay.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;";
                stage.appendChild(overlay);

                // ojo global: abre/cierra los tiradores del visor
                const eyeBtn = document.createElement("button");
                eyeBtn.className = "er-btn";
                eyeBtn.title = "Show/hide the light markers";
                eyeBtn.style.cssText =
                    "position:absolute;top:6px;right:6px;height:22px;font-size:12px;line-height:1;padding:0 8px;opacity:.85;";
                const applyMarkerVis = () => {
                    const hidden = !!node.properties?.er_marker_hidden;
                    overlay.style.display = hidden ? "none" : "block";
                    eyeBtn.textContent = hidden ? "🙈" : "👁";
                };
                eyeBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
                eyeBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    node.properties = node.properties || {};
                    node.properties.er_marker_hidden = !node.properties.er_marker_hidden;
                    applyMarkerVis();
                });
                stage.appendChild(eyeBtn);

                // barra superior + panel de flares
                const bar = document.createElement("div");
                bar.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;";
                const addBtn = document.createElement("button");
                addBtn.textContent = "＋ Flare";
                addBtn.className = "er-btn-primary";
                addBtn.style.cssText = "height:22px;font-size:11px;line-height:1;padding:0 12px;";
                addBtn.title = `Add a lens flare (max ${MAX_FLARES})`;
                const resetAllBtn = document.createElement("button");
                resetAllBtn.textContent = "⟲ All";
                resetAllBtn.className = "er-btn";
                resetAllBtn.title = "Reset every flare's parameters (keeps positions)";
                resetAllBtn.style.cssText = "height:22px;font-size:11px;line-height:1;padding:0 10px;";
                resetAllBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
                resetAllBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const list = getFlares().map((f) => ({
                        ...DEFAULT_FLARE, x: f.x, y: f.y, on: f.on, open: f.open,
                    }));
                    saveFlares(list);
                    rebuildUI();
                });
                bar.append(addBtn, resetAllBtn);
                flaresBox = document.createElement("div");
                flaresBox.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;";
                root.append(bar, flaresBox);

                addBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
                addBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const list = getFlares();
                    if (list.length >= MAX_FLARES) return;
                    list.push({ ...DEFAULT_FLARE, x: 0.25 + 0.5 * Math.random(), y: 0.2 + 0.3 * Math.random() });
                    saveFlares(list);
                    rebuildUI();
                    node.setSize([node.size[0], node.size[1] + 150]);
                });

                // angulo natural del reguero de ghosts en pantalla: de la
                // luz hacia el centro de la imagen (el overlay va con el
                // aspecto bloqueado, asi que coincide con el espacio del flare)
                const ghostBaseDeg = (f, rW, rH) => {
                    const dx = (0.5 - f.x) * (rW || 320);
                    const dy = (0.5 - f.y) * (rH || 180);
                    if (Math.abs(dx) < 1e-4 && Math.abs(dy) < 1e-4) return 0;
                    return (Math.atan2(dy, dx) * 180) / Math.PI;
                };
                // coloca el tirador del angulo del ghost apuntando por donde
                // sale realmente el reguero (eje natural + offset)
                const placeRotHandle = (i, f) => {
                    const rh = rotHandles[i];
                    if (!rh) return;
                    const r = overlay.getBoundingClientRect();
                    const rad = ((ghostBaseDeg(f, r.width, r.height) + (f.rotation ?? 0)) * Math.PI) / 180;
                    rh.style.left = `calc(${f.x * 100}% + ${Math.round(ROT_R * Math.cos(rad))}px)`;
                    rh.style.top = `calc(${f.y * 100}% + ${Math.round(ROT_R * Math.sin(rad))}px)`;
                };

                // arrastre de marcadores por delegacion (indice estable)
                let dragIdx = -1;
                const setFromEvent = (idx, e) => {
                    const r = overlay.getBoundingClientRect();
                    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
                    const list = getFlares();
                    if (!list[idx]) return;
                    list[idx].x = Math.round(x * 1000) / 1000;
                    list[idx].y = Math.round(y * 1000) / 1000;
                    saveFlares(list);
                    if (markers[idx]) {
                        markers[idx].style.left = `${x * 100}%`;
                        markers[idx].style.top = `${y * 100}%`;
                    }
                    placeRotHandle(idx, list[idx]);
                };
                overlay.addEventListener("pointerdown", (e) => {
                    const idx = markers.indexOf(e.target);
                    if (idx < 0) return;
                    e.stopPropagation();
                    dragIdx = idx;
                    try { overlay.setPointerCapture(e.pointerId); } catch (err) {}
                });
                overlay.addEventListener("pointermove", (e) => {
                    if (dragIdx >= 0) setFromEvent(dragIdx, e);
                });
                const endDrag = (e) => {
                    if (dragIdx < 0) return;
                    dragIdx = -1;
                    try { overlay.releasePointerCapture(e.pointerId); } catch (err) {}
                };
                overlay.addEventListener("pointerup", endDrag);
                overlay.addEventListener("pointercancel", endDrag);

                // sliders de un flare
                const SLIDERS = [
                    ["intensity", "Intensity", 0, 2, 0.01],
                    ["core", "Core", 0, 2, 0.01],
                    ["core_radius", "Core radius", 0.2, 3, 0.01],
                    ["scale", "Scale", 0.2, 3, 0.01],
                    ["hue", "Hue", 0, 360, 1],
                    ["sat", "Sat", 0, 1, 0.01],
                    ["rotation", "Ghost angle", -180, 180, 1],
                    ["ghosts", "Ghosts", 0, 1, 0.01],
                    ["streak", "Streak", 0, 1, 0.01],
                    ["streak_hue", "Streak hue", 0, 360, 1],
                    ["streak_width", "Streak width", 0.2, 4, 0.05],
                    ["rays", "Rays", 0, 1, 0.01],
                    ["ray_count", "Ray count", 2, 16, 1],
                    ["ray_rotation", "Ray angle", -180, 180, 1],
                ];

                rebuildUI = () => {
                    flaresBox.innerHTML = "";
                    for (const m of markers) m.remove();
                    markers = [];
                    for (const h of rotHandles) h?.remove();
                    rotHandles = [];
                    const list = getFlares();
                    list.forEach((f, i) => {
                        const tint = `hsl(${f.hue},${Math.round(f.sat * 100)}%,65%)`;
                        // marcador en el visor, coloreado con el tinte del flare
                        const mk = document.createElement("div");
                        mk.style.cssText =
                            "position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;" +
                            `border:2px solid ${tint};` +
                            "box-shadow:0 0 6px rgba(0,0,0,.8);cursor:grab;background:rgba(255,255,255,.25);";
                        mk.style.left = `${f.x * 100}%`;
                        mk.style.top = `${f.y * 100}%`;
                        mk.style.opacity = f.on ? "1" : "0.35";
                        overlay.appendChild(mk);
                        markers.push(mk);

                        // tirador del angulo del ghost: orbita el marcador y
                        // apunta por donde cae el reguero de reflejos
                        const rh = document.createElement("div");
                        rh.title = `Aim Flare ${i + 1}'s ghost trail (0 = natural light-to-center axis)`;
                        rh.style.cssText =
                            "position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;" +
                            `background:${tint};border:1px solid #000;transform:rotate(45deg);` +
                            "box-shadow:0 0 4px rgba(0,0,0,.8);cursor:grab;";
                        rh.style.opacity = f.on ? "1" : "0.35";
                        overlay.appendChild(rh);
                        rotHandles.push(rh);
                        placeRotHandle(i, f);
                        rh.addEventListener("pointerdown", (e) => {
                            e.stopPropagation();
                            const move = (ev) => {
                                const r = overlay.getBoundingClientRect();
                                const list2 = getFlares();
                                if (!list2[i] || !r.width) return;
                                const cx = r.left + list2[i].x * r.width;
                                const cy = r.top + list2[i].y * r.height;
                                // offset respecto al eje natural luz->centro
                                let deg =
                                    (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI -
                                    ghostBaseDeg(list2[i], r.width, r.height);
                                deg = Math.round(((deg + 540) % 360) - 180);
                                list2[i].rotation = deg;
                                saveFlares(list2);
                                placeRotHandle(i, list2[i]);
                                node._erSyncRot?.(i, deg);
                            };
                            move(e);
                            const up = () => {
                                window.removeEventListener("pointermove", move);
                                window.removeEventListener("pointerup", up);
                            };
                            window.addEventListener("pointermove", move);
                            window.addEventListener("pointerup", up);
                        });

                        // panel plegable del flare
                        const box = document.createElement("div");
                        box.className = "er-panel";
                        box.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:5px 7px;";
                        const head = document.createElement("div");
                        head.style.cssText = "display:flex;align-items:center;gap:6px;";
                        const fold = document.createElement("button");
                        fold.className = "er-btn";
                        fold.textContent = f.open ? "▾" : "▸";
                        fold.title = "Expand/collapse";
                        fold.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 6px;";
                        const title = document.createElement("span");
                        title.className = "er-title";
                        title.textContent = `Flare ${i + 1}`;
                        title.style.opacity = f.on ? "1" : "0.45";
                        const eye = document.createElement("button");
                        eye.className = "er-btn";
                        eye.textContent = f.on ? "👁" : "🙈";
                        eye.title = "Enable/disable this flare";
                        eye.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
                        const freset = document.createElement("button");
                        freset.className = "er-btn";
                        freset.textContent = "⟲";
                        freset.title = "Reset this flare (keeps its position)";
                        freset.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;";
                        // preset de look (rellena valores, posicion intacta)
                        const presetSel = document.createElement("select");
                        presetSel.className = "er-select";
                        presetSel.title = "Flare look preset — fills the values, everything stays editable";
                        presetSel.style.cssText = "font-size:9px;padding:1px 4px;max-width:118px;flex:0 1 auto;";
                        for (const name of ["custom", ...Object.keys(FLARE_PRESETS)]) {
                            const o = document.createElement("option");
                            o.value = o.textContent = name;
                            presetSel.appendChild(o);
                        }
                        presetSel.value = f._preset && FLARE_PRESETS[f._preset] ? f._preset : "custom";
                        presetSel.addEventListener("pointerdown", (e) => e.stopPropagation());
                        presetSel.addEventListener("change", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            if (!list2[i]) return;
                            const preset = FLARE_PRESETS[presetSel.value];
                            if (preset) {
                                list2[i] = { ...list2[i], ...preset, _preset: presetSel.value };
                            } else {
                                list2[i]._preset = "custom";
                            }
                            saveFlares(list2);
                            rebuildUI();
                        });
                        // duplicar: clona el flare con todos sus ajustes
                        // (p. ej. los dos faros de un coche: uno hecho a mano
                        // y su copia arrastrada al otro lado)
                        const dup = document.createElement("button");
                        dup.className = "er-btn";
                        dup.textContent = "⧉";
                        dup.title = list.length >= MAX_FLARES
                            ? `Duplicate this flare (max ${MAX_FLARES} reached)`
                            : "Duplicate this flare (same settings, nudged position)";
                        dup.style.cssText = "height:20px;font-size:11px;line-height:1;padding:0 7px;" +
                            (list.length >= MAX_FLARES ? "opacity:.35;" : "");
                        const del = document.createElement("button");
                        del.className = "er-btn";
                        del.textContent = "✕";
                        del.title = "Delete this flare";
                        del.style.cssText = `height:20px;font-size:10px;line-height:1;padding:0 7px;color:${ER.error};`;
                        head.append(fold, title, presetSel, eye, dup, freset, del);
                        const body = document.createElement("div");
                        body.style.cssText =
                            `display:${f.open ? "grid" : "none"};grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:3px 12px;`;
                        for (const [key, label, min, max, step] of SLIDERS) {
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
                            inp.value = String(f[key]);
                            inp.title = label + " (double click: reset)";
                            inp.style.cssText = "flex:1;height:12px;cursor:pointer;min-width:30px;";
                            const num = document.createElement("input");
                            num.type = "number";
                            num.className = "er-input";
                            num.min = String(min);
                            num.max = String(max);
                            num.step = String(step);
                            num.value = String(f[key]);
                            num.style.cssText =
                                "width:44px;flex:0 0 auto;font-size:9px;padding:1px 3px;text-align:right;";
                            const rst = document.createElement("button");
                            rst.className = "er-btn";
                            rst.textContent = "⟲";
                            rst.title = "Reset " + label;
                            rst.style.cssText = "height:16px;font-size:9px;line-height:1;padding:0 4px;flex:0 0 auto;";
                            const push = (v, syncNum, syncRange) => {
                                const val = Math.min(max, Math.max(min, Number(v)));
                                const list2 = getFlares();
                                if (!list2[i]) return;
                                list2[i][key] = val;
                                saveFlares(list2);
                                if (syncNum) num.value = String(val);
                                if (syncRange) inp.value = String(val);
                                if (key === "hue" || key === "sat") {
                                    const t2 = `hsl(${list2[i].hue},${Math.round(list2[i].sat * 100)}%,65%)`;
                                    if (markers[i]) markers[i].style.borderColor = t2;
                                    if (rotHandles[i]) rotHandles[i].style.background = t2;
                                }
                                if (key === "rotation") placeRotHandle(i, list2[i]);
                            };
                            if (key === "rotation") {
                                // el tirador del visor sincroniza este slider
                                const prevSync = node._erSyncRot;
                                node._erSyncRot = (idx2, deg) => {
                                    prevSync?.(idx2, deg);
                                    if (idx2 === i) {
                                        inp.value = String(deg);
                                        num.value = String(deg);
                                    }
                                };
                            }
                            for (const el of [inp, num, rst]) {
                                el.addEventListener("pointerdown", (e) => e.stopPropagation());
                            }
                            num.addEventListener("keydown", (e) => e.stopPropagation());
                            inp.addEventListener("input", () => push(inp.value, true, false));
                            num.addEventListener("input", () => push(num.value, false, true));
                            inp.addEventListener("dblclick", (e) => {
                                e.stopPropagation();
                                push(DEFAULT_FLARE[key], true, true);
                            });
                            rst.addEventListener("click", (e) => {
                                e.stopPropagation();
                                push(DEFAULT_FLARE[key], true, true);
                            });
                            wrap.append(tag, inp, num, rst);
                            body.appendChild(wrap);
                        }
                        box.append(head, body);
                        flaresBox.appendChild(box);

                        for (const el of [fold, eye, dup, freset, del]) {
                            el.addEventListener("pointerdown", (e) => e.stopPropagation());
                        }
                        dup.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            if (!list2[i] || list2.length >= MAX_FLARES) return;
                            const copy = { ...list2[i] };
                            // ligeramente desplazado para verlo y arrastrarlo
                            copy.x = Math.round(Math.min(0.98, copy.x + 0.06) * 1000) / 1000;
                            copy.y = Math.round(Math.min(0.98, copy.y + 0.06) * 1000) / 1000;
                            list2.splice(i + 1, 0, copy);
                            saveFlares(list2);
                            rebuildUI();
                            node.setSize([node.size[0], node.size[1] + 150]);
                        });
                        freset.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            if (!list2[i]) return;
                            const keep = { x: list2[i].x, y: list2[i].y, on: list2[i].on, open: list2[i].open };
                            list2[i] = { ...DEFAULT_FLARE, ...keep };
                            saveFlares(list2);
                            rebuildUI();
                        });
                        fold.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            if (!list2[i]) return;
                            list2[i].open = !list2[i].open;
                            saveFlares(list2);
                            rebuildUI();
                        });
                        eye.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            if (!list2[i]) return;
                            list2[i].on = !list2[i].on;
                            saveFlares(list2);
                            rebuildUI();
                        });
                        del.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const list2 = getFlares();
                            list2.splice(i, 1);
                            saveFlares(list2);
                            rebuildUI();
                        });
                    });
                    applyMarkerVis();
                };

                // migracion desde el formato antiguo (widgets sueltos) + estado
                const onConfigure = node.onConfigure;
                node.onConfigure = function (info) {
                    onConfigure?.apply(this, arguments);
                    node._erConfigured = true;
                    setTimeout(() => {
                        let ok = false;
                        try { ok = Array.isArray(JSON.parse(flaresW?.value || "")); } catch (e) {}
                        if (!ok) {
                            const vals = info?.widgets_values;
                            if (Array.isArray(vals) && vals.length >= 9 && typeof vals[0] === "number") {
                                saveFlares([{
                                    ...DEFAULT_FLARE,
                                    x: vals[0], y: vals[1], intensity: vals[2], scale: vals[3],
                                    hue: vals[4], sat: vals[5], ghosts: vals[6], streak: vals[7], rays: vals[8],
                                }]);
                            } else {
                                saveFlares([{ ...DEFAULT_FLARE }]);
                            }
                        }
                        rebuildUI();
                    }, 300);
                };
                // nodo recien creado: arranca con un flare
                setTimeout(() => {
                    if (!node._erConfigured && !getFlares().length) {
                        saveFlares([{ ...DEFAULT_FLARE }]);
                        rebuildUI();
                    }
                }, 400);
            }

            // comparador antes/despues: UN clic alterna original / procesado
            let abOn = false;
            const abBtn = document.createElement("button");
            abBtn.className = "er-btn";
            abBtn.textContent = "A|B";
            abBtn.title = "Toggle before/after";
            abBtn.style.cssText =
                `position:absolute;top:6px;right:${def.flare ? "44" : "6"}px;` +
                "height:22px;font-size:11px;line-height:1;padding:0 8px;opacity:.85;";
            stage.appendChild(abBtn);
            abBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
            abBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                abOn = !abOn;
                abBtn.classList.toggle("er-active", abOn);
            });

            // ---------- UI de paneles del lens effects ----------
            if (def.lens) {
                const stopEv = (el) => {
                    el.addEventListener("pointerdown", (e) => e.stopPropagation());
                };
                // selector de presets (si el nodo los tiene): rellenan los
                // valores como punto de partida y todo queda editable
                let lensSel = null;
                if (def.presets) {
                    const lensBar = document.createElement("div");
                    lensBar.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 auto;";
                    const lensTag = document.createElement("span");
                    lensTag.className = "er-title";
                    lensTag.textContent = "Lens";
                    lensSel = document.createElement("select");
                    lensSel.className = "er-select";
                    lensSel.style.cssText = "flex:1;font-size:10px;padding:2px 5px;max-width:220px;";
                    for (const name of ["custom", ...Object.keys(def.presets)]) {
                        const o = document.createElement("option");
                        o.value = o.textContent = name;
                        lensSel.appendChild(o);
                    }
                    const applyBadge = document.createElement("span");
                    applyBadge.className = "er-dim";
                    applyBadge.style.cssText = "font-size:9px;";
                    applyBadge.textContent = "presets fill values — everything stays editable";
                    lensBar.append(lensTag, lensSel, applyBadge);
                    root.appendChild(lensBar);
                    stopEv(lensSel);
                }

                const groupsBox = document.createElement("div");
                groupsBox.style.cssText = "display:flex;flex-direction:column;gap:5px;flex:0 0 auto;";
                root.appendChild(groupsBox);

                const rebuildLensUI = () => {
                    groupsBox.innerHTML = "";
                    const p = getLens();
                    (def.groups || LENS_GROUPS).forEach(([gtitle, sliders], gi) => {
                        const open = p._open?.[gi] !== false; // abierto por defecto
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
                            tag.style.cssText = "font-size:9px;width:60px;flex:0 0 auto;user-select:none;";
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
                            const rst = document.createElement("button");
                            rst.className = "er-btn";
                            rst.textContent = "⟲";
                            rst.title = "Reset " + label;
                            rst.style.cssText = "height:16px;font-size:9px;line-height:1;padding:0 4px;flex:0 0 auto;";
                            const push = (v, syncNum, syncRange) => {
                                const val = Math.min(max, Math.max(min, Number(v)));
                                const p2 = getLens();
                                p2[key] = val;
                                saveLens(p2);
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
                            const p2 = getLens();
                            p2._open = p2._open || {};
                            p2._open[gi] = !(p2._open[gi] !== false);
                            saveLens(p2);
                            rebuildLensUI();
                        };
                        fold.addEventListener("click", toggle);
                        title.addEventListener("click", toggle);
                        greset.addEventListener("click", (e) => {
                            e.stopPropagation();
                            const p2 = getLens();
                            for (const [key] of sliders) p2[key] = DEFAULTS[key];
                            saveLens(p2);
                            rebuildLensUI();
                        });
                    });
                    // reset general de todos los grupos
                    const allBar = document.createElement("div");
                    allBar.style.cssText = "display:flex;justify-content:flex-end;";
                    const allBtn = document.createElement("button");
                    allBtn.className = "er-btn";
                    allBtn.textContent = "⟲ Reset all";
                    allBtn.title = "Reset every parameter to its default";
                    allBtn.style.cssText = "height:20px;font-size:10px;line-height:1;padding:0 10px;";
                    stopEv(allBtn);
                    allBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const p2 = getLens();
                        saveLens({ ...DEFAULTS, _open: p2._open || {} });
                        rebuildLensUI();
                    });
                    allBar.appendChild(allBtn);
                    groupsBox.appendChild(allBar);
                    // refleja el preset guardado en el selector
                    if (lensSel) {
                        const cur = getLens()._preset;
                        lensSel.value = cur && def.presets[cur] ? cur : "custom";
                    }
                };
                lensSel?.addEventListener("change", () => {
                    const p = getLens();
                    const preset = def.presets[lensSel.value];
                    if (preset) {
                        saveLens({ ...DEFAULTS, ...preset, _preset: lensSel.value, _open: p._open || {} });
                    } else {
                        saveLens({ ...p, _preset: "custom" });
                    }
                    rebuildLensUI();
                });
                rebuildLensUI();

                // migracion desde el formato antiguo (widgets sueltos)
                const onConfigureL = node.onConfigure;
                node.onConfigure = function (info) {
                    onConfigureL?.apply(this, arguments);
                    node._erConfigured = true;
                    setTimeout(() => {
                        let ok = false;
                        try {
                            const d = JSON.parse(paramsW?.value || "");
                            ok = d && typeof d === "object" && !Array.isArray(d);
                        } catch (e) {}
                        if (!ok) {
                            const v = info?.widgets_values;
                            if (def.migrate && Array.isArray(v) && v.length >= 8 && typeof v[0] === "number") {
                                saveLens({
                                    ...DEFAULTS,
                                    distortion: v[0], chromatic_aberration: v[1], vignette: v[2],
                                    vignette_softness: v[3], sharpen: v[4], glow: v[5],
                                    glow_threshold: v[6], glow_size: v[7],
                                    distortion_fine: v[8] ?? 0, vignette_x: v[9] ?? 0.5, vignette_y: v[10] ?? 0.5,
                                });
                            } else {
                                saveLens({ ...DEFAULTS });
                            }
                        }
                        rebuildLensUI();
                    }, 300);
                };
                setTimeout(() => {
                    if (!node._erConfigured && !paramsW?.value?.startsWith("{")) {
                        saveLens({ ...DEFAULTS });
                    }
                }, 400);
            }

            const widget = node.addDOMWidget("er_lens_preview", "ER_LENS", root, {
                serialize: false,
                hideOnZoom: false,
            });
            widget.computeSize = function (width) {
                return [width, 160];
            };

            // ajuste con realimentacion + aspecto bloqueado (sin bandas
            // negras; ademas los marcadores quedan alineados con la imagen)
            const updateStageHeight = () => {
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
                if (stage.style.display === "none") {
                    // sin visor: la altura minima ya la garantiza el ajuste
                    // generico del tema (erMinFit) con medidas de layout;
                    // crecer aqui con rects de pantalla se disparaba cuando
                    // el overlay DOM iba un frame por detras del canvas
                    return;
                }
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

            // ---------- render ----------
            const getParams = () => {
                if (def.flare) return { flares: flaresW?.value || "[]", _ab: abOn ? 1 : 0 };
                const p = getLens();
                p._split = abOn ? 2.0 : 0.0; // transitorio: no se guarda en el workflow
                return p;
            };
            const render = () => {
                if (!glState || !imgLoaded) return;
                const { gl, uniforms } = glState;
                gl.viewport(0, 0, glCanvas.width, glCanvas.height);
                gl.uniform2f(uniforms.u_res, glCanvas.width, glCanvas.height);
                gl.uniform1i(uniforms.u_tex, 0);
                if (def.flare) {
                    const list = getFlares();
                    const A = new Float32Array(16), B = new Float32Array(16), C = new Float32Array(16), D = new Float32Array(16), E = new Float32Array(16);
                    list.forEach((f, i) => {
                        A.set([f.x, f.y, f.intensity, f.scale], i * 4);
                        B.set([f.hue, f.sat, f.ghosts, f.streak], i * 4);
                        C.set([f.rays, f.streak_hue, f.on ? 1 : 0, f.ray_count], i * 4);
                        D.set([
                            f.streak_width, f.core ?? 1, f.core_radius ?? 1,
                            ((f.rotation ?? 0) * Math.PI) / 180,
                        ], i * 4);
                        E.set([((f.ray_rotation ?? 0) * Math.PI) / 180, 0, 0, 0], i * 4);
                    });
                    gl.uniform4fv(uniforms.u_fA, A);
                    gl.uniform4fv(uniforms.u_fB, B);
                    gl.uniform4fv(uniforms.u_fC, C);
                    gl.uniform4fv(uniforms.u_fD, D);
                    gl.uniform4fv(uniforms.u_fE, E);
                    gl.uniform1f(uniforms.u_count, list.length);
                    gl.uniform1f(uniforms.u_ab, abOn ? 1 : 0);
                } else {
                    def.setUniforms(gl, uniforms, getParams());
                }
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            };

            let rafId = null;
            const loop = () => {
                const key = JSON.stringify(getParams());
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
                    if (!glState) glState = initGL(glCanvas, def.frag);
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
            const file = message?.er_lens?.[0];
            if (file && this.erSetImage) this.erSetImage(file);
        };
    },
});
