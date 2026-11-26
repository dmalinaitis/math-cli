// LaTeX -> SVG (MathJax, in-process, no TeX install) -> PNG (resvg).
// The PNG is padded to a whole number of terminal cells so it sits on the text grid.
//
// MathJax and resvg are loaded lazily (synchronously, via require) on the first equation, so
// importing this module costs nothing at startup. Call warmupMath() to pay that cost early.
import { createRequire } from "node:module";
import type { LiteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import type { MathDocument } from "mathjax-full/js/core/MathDocument.js";
import type { Resvg as ResvgClass } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);

// TeX packages for university maths. Every name is in MathJax's AllPackages (order preserved);
// left out: action, html, bussproofs, colortbl (web/proof-tree only) and configmacros, tagformat
// (configuration hooks we never set). `physics` isn't in AllPackages and redefines common macros.
const TEX_PACKAGES: [name: string, file: string][] = [
  ["base", "base/BaseConfiguration"],
  ["ams", "ams/AmsConfiguration"],
  ["amscd", "amscd/AmsCdConfiguration"],
  ["bbox", "bbox/BboxConfiguration"],
  ["boldsymbol", "boldsymbol/BoldsymbolConfiguration"],
  ["braket", "braket/BraketConfiguration"],
  ["cancel", "cancel/CancelConfiguration"],
  ["cases", "cases/CasesConfiguration"],
  ["centernot", "centernot/CenternotConfiguration"],
  ["color", "color/ColorConfiguration"],
  ["empheq", "empheq/EmpheqConfiguration"],
  ["enclose", "enclose/EncloseConfiguration"],
  ["extpfeil", "extpfeil/ExtpfeilConfiguration"],
  ["gensymb", "gensymb/GensymbConfiguration"],
  ["mathtools", "mathtools/MathtoolsConfiguration"],
  ["mhchem", "mhchem/MhchemConfiguration"],
  ["newcommand", "newcommand/NewcommandConfiguration"],
  ["noerrors", "noerrors/NoErrorsConfiguration"],
  ["noundefined", "noundefined/NoUndefinedConfiguration"],
  ["upgreek", "upgreek/UpgreekConfiguration"],
  ["unicode", "unicode/UnicodeConfiguration"],
  ["verb", "verb/VerbConfiguration"],
  ["textcomp", "textcomp/TextcompConfiguration"],
  ["textmacros", "textmacros/TextMacrosConfiguration"],
];
export const TEX_PACKAGE_NAMES = TEX_PACKAGES.map(([n]) => n);

let mj: { adaptor: LiteAdaptor; doc: MathDocument<any, any, any> } | undefined;
let ResvgCtor: typeof ResvgClass | undefined;

function getMathJax() {
  if (mj) return mj;
  const { mathjax } = require("mathjax-full/js/mathjax.js");
  const { TeX } = require("mathjax-full/js/input/tex.js");
  const { SVG } = require("mathjax-full/js/output/svg.js");
  const { liteAdaptor } = require("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = require("mathjax-full/js/handlers/html.js");
  for (const [, file] of TEX_PACKAGES) require(`mathjax-full/js/input/tex/${file}.js`); // registers the package
  const adaptor: LiteAdaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: TEX_PACKAGE_NAMES }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  return (mj = { adaptor, doc });
}

function getResvg(): typeof ResvgClass {
  return (ResvgCtor ??= require("@resvg/resvg-js").Resvg as typeof ResvgClass);
}

// Load MathJax + resvg now (idempotent), e.g. in the background while the user types their first prompt.
export function warmupMath(): void {
  getMathJax();
  getResvg();
}

export function isMathLoaded(): boolean {
  return mj !== undefined;
}

export interface RenderOptions {
  display: boolean;
  emPx: number; // pixel size of 1em for the math font
  color: string; // e.g. "#e6e6f0"
  cellW: number;
  cellH: number;
  maxWidthPx: number; // shrink to fit beyond this
  minScale?: number; // don't shrink below this fraction; caller falls back to source
  padCellsY?: number; // blank cell rows above+below (display math breathing room)
  oversample?: number; // render at N× pixels; the terminal scales it into the cell box (use when cell size is guessed)
}

export interface RenderedMath {
  png: Buffer;
  cols: number;
  rows: number;
  scaled: number; // scale actually applied (1 = no shrink)
}

export class MathError extends Error {}

type Svg = { svg: string; wEm: number; hEm: number; ascentEm: number };

// Small LRU: a Map keeps insertion order, so re-inserting on hit makes the first key the oldest.
class Lru<V> {
  private m = new Map<string, V>();
  constructor(private max: number) {}
  get(k: string): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: string, v: V) {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
  }
  clear() {
    this.m.clear();
  }
  get size() {
    return this.m.size;
  }
}

// SVGs are colour/size independent, so a /theme redraw re-rasterises without re-running MathJax.
// Failures are cached too (as the MathError) so a bad expression in a streaming paragraph is parsed once.
const svgCache = new Lru<Svg | MathError>(256);
// PNGs per (expression, options). null = inline expression too tall for one row.
const pngCache = new Lru<RenderedMath | null>(256);

// Drop every cached SVG / PNG (e.g. on /clear).
export function clearRenderCache(): void {
  svgCache.clear();
  pngCache.clear();
}

export function renderCacheSize(): { svg: number; png: number } {
  return { svg: svgCache.size, png: pngCache.size };
}

export function latexToSvg(tex: string, display: boolean): Svg {
  const key = `${display ? "D" : "I"}\0${tex}`;
  const hit = svgCache.get(key);
  if (hit instanceof MathError) throw hit;
  if (hit) return hit;
  try {
    const out = convert(tex, display);
    svgCache.set(key, out);
    return out;
  } catch (e) {
    const err = e instanceof MathError ? e : new MathError(e instanceof Error ? e.message : String(e));
    svgCache.set(key, err);
    throw err;
  }
}

function convert(tex: string, display: boolean): Svg {
  const { adaptor, doc } = getMathJax();
  const node = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 });
  const svgNode = adaptor.firstChild(node) as any;
  const html = adaptor.outerHTML(svgNode);
  const err = /data-mjx-error="([^"]*)"/.exec(html) ?? /<g[^>]*data-mml-node="merror"[^>]*title="([^"]*)"/.exec(html);
  if (err || html.includes('data-mml-node="merror"')) {
    throw new MathError(err?.[1] || "LaTeX error");
  }
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/.exec(html);
  if (!vb) throw new MathError("MathJax produced no viewBox");
  // MathJax viewBox units are 1/1000 em; y = 0 is the baseline, so -minY is the height above it.
  return { svg: html, wEm: Number(vb[3]) / 1000, hEm: Number(vb[4]) / 1000, ascentEm: -Number(vb[2]) / 1000 };
}

// Place MathJax's SVG at (x, y) with size w×h inside a W×H canvas and rasterise it at `k`× resolution.
function rasterise(svg: string, color: string, x: number, y: number, w: number, h: number, W: number, H: number, k = 1): Buffer {
  if (!(k > 0) || !Number.isFinite(k)) k = 1;
  const inner = svg
    .replace(/currentColor/g, color)
    .replace(/^<svg/, `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}"`)
    .replace(/ width="[^"]*"/, ` width="${w.toFixed(2)}"`)
    .replace(/ height="[^"]*"/, ` height="${h.toFixed(2)}"`)
    .replace(/ style="[^"]*"/, "");
  const outer = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(W * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
  const Resvg = getResvg();
  // MathJax (fontCache "none") draws glyphs as paths; only unknown characters come out as <text>.
  // Skipping the system font scan saves tens of ms per equation.
  return new Resvg(outer, {
    background: "rgba(0,0,0,0)",
    shapeRendering: 2,
    textRendering: 2,
    font: { loadSystemFonts: svg.includes("<text") },
  }).render().asPng();
}

const positive = (n: number) => Number.isFinite(n) && n > 0;

export interface InlineOptions {
  emPx: number; // math em size matching the terminal font
  color: string;
  cellW: number;
  cellH: number;
  baseline: number; // text baseline as a fraction of cell height from the top (~0.78 for most monospace fonts)
  minScale?: number; // shrink tall expressions to fit one row down to this; below it, return undefined
  oversample?: number;
}

// Inline maths as an image exactly one text row tall, its baseline on the text baseline,
// so it can sit inside a line of prose. Returns undefined if it can't fit one row legibly.
export function renderInline(tex: string, o: InlineOptions): RenderedMath | undefined {
  if (!positive(o.emPx) || !positive(o.cellW) || !positive(o.cellH)) return undefined;
  const key = JSON.stringify(["inline", tex, o]);
  const hit = pngCache.get(key);
  if (hit !== undefined) return hit ?? undefined;

  const { svg, wEm, hEm, ascentEm } = latexToSvg(tex, false);
  const depthEm = hEm - ascentEm;
  const baseline = Math.min(1, Math.max(0, Number.isFinite(o.baseline) ? o.baseline : 0.78));
  const above = baseline * o.cellH; // room above the baseline
  const below = o.cellH - above;
  const scale = Math.min(
    1,
    ascentEm > 0 ? above / (ascentEm * o.emPx) : 1,
    depthEm > 0 ? below / (depthEm * o.emPx) : 1,
  );
  if (!(scale >= (o.minScale ?? 0.7))) {
    pngCache.set(key, null);
    return undefined;
  }

  const em = o.emPx * scale;
  const w = wEm * em, h = hEm * em;
  const cols = Math.max(1, Math.ceil(w / o.cellW));
  // Centre horizontally so the round-up to whole cells leaves equal slack on both sides.
  const x = (cols * o.cellW - w) / 2;
  const png = rasterise(svg, o.color, x, above - ascentEm * em, w, h, cols * o.cellW, o.cellH, o.oversample);
  const out = { png, cols, rows: 1, scaled: scale };
  pngCache.set(key, out);
  return out;
}

export function renderMath(tex: string, o: RenderOptions): RenderedMath {
  if (!positive(o.emPx) || !positive(o.cellW) || !positive(o.cellH)) throw new MathError("invalid cell metrics");
  const key = JSON.stringify([tex, o]);
  const hit = pngCache.get(key);
  if (hit) return hit;

  const { svg, wEm, hEm } = latexToSvg(tex, o.display);
  let scale = 1;
  const naturalW = wEm * o.emPx;
  if (naturalW > o.maxWidthPx) {
    scale = o.maxWidthPx / naturalW;
    if (!(scale >= (o.minScale ?? 0.6))) throw new MathError("too wide for terminal");
  }
  const w = naturalW * scale;
  const h = hEm * o.emPx * scale;
  const pad = Math.max(0, Math.floor(o.padCellsY ?? 0));
  const cols = Math.max(1, Math.ceil(w / o.cellW));
  const rows = Math.max(1, Math.ceil(h / o.cellH)) + pad * 2;
  const W = cols * o.cellW;
  const H = rows * o.cellH;
  const y = (H - h) / 2; // centre vertically inside the cell block
  const png = rasterise(svg, o.color, 0, y, w, h, W, H, o.oversample);
  const out = { png, cols, rows, scaled: scale };
  pngCache.set(key, out);
  return out;
}
