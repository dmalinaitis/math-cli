// LaTeX -> SVG (MathJax, in-process, no TeX install) -> PNG (resvg).
// The PNG is padded to a whole number of terminal cells so it sits on the text grid.
import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import { AllPackages } from "mathjax-full/js/input/tex/AllPackages.js";
import { Resvg } from "@resvg/resvg-js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document("", {
  InputJax: new TeX({ packages: AllPackages.filter((p: string) => p !== "bussproofs") }),
  OutputJax: new SVG({ fontCache: "none" }),
});

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

const cache = new Map<string, RenderedMath>();

export function latexToSvg(tex: string, display: boolean): { svg: string; wEm: number; hEm: number; ascentEm: number } {
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
  const inner = svg
    .replace(/currentColor/g, color)
    .replace(/^<svg/, `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}"`)
    .replace(/ width="[^"]*"/, ` width="${w.toFixed(2)}"`)
    .replace(/ height="[^"]*"/, ` height="${h.toFixed(2)}"`)
    .replace(/ style="[^"]*"/, "");
  const outer = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${Math.round(W * k)}" height="${Math.round(H * k)}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
  return new Resvg(outer, { background: "rgba(0,0,0,0)", shapeRendering: 2, textRendering: 2 }).render().asPng();
}

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
  const key = JSON.stringify(["inline", tex, o]);
  const hit = cache.get(key);
  if (hit) return hit;

  const { svg, wEm, hEm, ascentEm } = latexToSvg(tex, false);
  const depthEm = hEm - ascentEm;
  const above = o.baseline * o.cellH; // room above the baseline
  const below = o.cellH - above;
  const scale = Math.min(1, above / (ascentEm * o.emPx), depthEm > 0 ? below / (depthEm * o.emPx) : 1);
  if (scale < (o.minScale ?? 0.7)) return undefined;

  const em = o.emPx * scale;
  const w = wEm * em, h = hEm * em;
  const cols = Math.max(1, Math.ceil(w / o.cellW));
  // Centre horizontally so the round-up to whole cells leaves equal slack on both sides.
  const x = (cols * o.cellW - w) / 2;
  const png = rasterise(svg, o.color, x, above - ascentEm * em, w, h, cols * o.cellW, o.cellH, o.oversample);
  const out = { png, cols, rows: 1, scaled: scale };
  cache.set(key, out);
  return out;
}

export function renderMath(tex: string, o: RenderOptions): RenderedMath {
  const key = JSON.stringify([tex, o]);
  const hit = cache.get(key);
  if (hit) return hit;

  const { svg, wEm, hEm } = latexToSvg(tex, o.display);
  let scale = 1;
  const naturalW = wEm * o.emPx;
  if (naturalW > o.maxWidthPx) {
    scale = o.maxWidthPx / naturalW;
    if (scale < (o.minScale ?? 0.6)) throw new MathError("too wide for terminal");
  }
  const w = naturalW * scale;
  const h = hEm * o.emPx * scale;
  const pad = o.padCellsY ?? 0;
  const cols = Math.max(1, Math.ceil(w / o.cellW));
  const rows = Math.max(1, Math.ceil(h / o.cellH)) + pad * 2;
  const W = cols * o.cellW;
  const H = rows * o.cellH;
  const y = (H - h) / 2; // centre vertically inside the cell block
  const png = rasterise(svg, o.color, 0, y, w, h, W, H, o.oversample);
  const out = { png, cols, rows, scaled: scale };
  cache.set(key, out);
  return out;
}
