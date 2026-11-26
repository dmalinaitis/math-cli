// Lazy loading, caching and cleanup in the maths renderer.
// Must run in its own process (node --test isolates files), so nothing has loaded MathJax yet.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import {
  isMathLoaded, warmupMath, renderInline, renderMath, latexToSvg, clearRenderCache, renderCacheSize,
  MathError, TEX_PACKAGE_NAMES,
} from "../src/math/render.js";
import { SAMPLES } from "../src/samples.js";
import { placeholder, visibleLen, clearImagePlaceholders } from "../src/ui/text.js";

const inline = { emPx: 17.5, color: "#ffffff", cellW: 10, cellH: 21, baseline: 0.76 };
const display = { display: true, emPx: 26, color: "#ffffff", cellW: 10, cellH: 21, maxWidthPx: 780, minScale: 0.5 };
const TALL = String.raw`\sum_{k=1}^{n}\frac{\frac{a}{b}}{\frac{c}{d}}`;

test("importing the renderer does not load MathJax", () => {
  assert.equal(isMathLoaded(), false);
  // tsx loads ESM-from-TS via the CJS loader, so the module registry tells us what was evaluated.
  const req = createRequire(import.meta.url);
  const loaded = Object.keys(req.cache).filter((k) => /mathjax-full|@resvg/.test(k));
  assert.deepEqual(loaded, []);
});

test("every TeX package is a real MathJax package", () => {
  const { AllPackages } = createRequire(import.meta.url)("mathjax-full/js/input/tex/AllPackages.js");
  for (const p of TEX_PACKAGE_NAMES) assert.ok(AllPackages.includes(p), p);
});

test("first render loads MathJax; warmupMath is idempotent", () => {
  const r = renderInline(String.raw`\tfrac12`, inline);
  assert.ok(r && r.png.length > 0);
  assert.equal(isMathLoaded(), true);
  warmupMath();
  warmupMath();
  assert.equal(isMathLoaded(), true);
});

test("all samples render with the subsetted TeX packages", () => {
  for (const tex of SAMPLES) {
    const r = renderMath(tex, display);
    assert.ok(r.png.subarray(1, 4).toString() === "PNG", tex);
    assert.ok(r.cols > 0 && r.rows > 0, tex);
  }
  // A spread of package macros (ams, mathtools, cancel, mhchem, braket, boldsymbol, extpfeil, upgreek, color, textmacros…).
  for (const tex of [
    String.raw`\coloneqq`, String.raw`\cancel{x}`, String.raw`\ce{H2O}`, String.raw`\bra{a}\ket{b}`,
    String.raw`\boldsymbol{\alpha}`, String.raw`\xrightarrow{f}`, String.raw`\uppi`, String.raw`\color{red}{x}`,
    String.raw`\text{if } x>0`, String.raw`\begin{CD} A @>>> B \end{CD}`, String.raw`\newcommand{\R}{\mathbb{R}}\R^n`,
  ]) assert.doesNotThrow(() => latexToSvg(tex, true), tex);
});

test("too-tall inline maths is negatively cached", () => {
  clearRenderCache();
  assert.equal(renderInline(TALL, inline), undefined);
  const after1 = renderCacheSize();
  assert.deepEqual(after1, { svg: 1, png: 1 });
  assert.equal(renderInline(TALL, inline), undefined);
  assert.deepEqual(renderCacheSize(), after1, "second call is a cache hit");
});

test("LaTeX errors are cached and rethrown as MathError", () => {
  clearRenderCache();
  const bad = String.raw`\frac{1}{`;
  assert.throws(() => renderInline(bad, inline), MathError);
  assert.throws(() => renderInline(bad, inline), MathError);
  assert.equal(renderCacheSize().svg, 1);
});

test("SVGs are shared across colours (theme redraws skip MathJax)", () => {
  clearRenderCache();
  const a = renderMath(SAMPLES[2], display);
  const b = renderMath(SAMPLES[2], { ...display, color: "#ff0000" });
  assert.notDeepEqual(a.png, b.png);
  assert.deepEqual(renderCacheSize(), { svg: 1, png: 2 });
  assert.equal(renderMath(SAMPLES[2], display), a, "PNG cache hit returns the same object");
});

test("invalid metrics never produce NaN or negative sizes", () => {
  for (const bad of [0, -5, NaN, Infinity]) {
    assert.equal(renderInline("x", { ...inline, cellW: bad }), undefined);
    assert.equal(renderInline("x", { ...inline, emPx: bad }), undefined);
    assert.throws(() => renderMath("x", { ...display, cellH: bad }), MathError);
  }
  assert.throws(() => renderMath(SAMPLES[0], { ...display, maxWidthPx: -1 }), MathError);
});

test("caches are bounded", () => {
  clearRenderCache();
  for (let i = 0; i < 300; i++) renderInline(`x_{${i}}`, inline);
  const { svg, png } = renderCacheSize();
  assert.ok(svg <= 256 && png <= 256, `svg=${svg} png=${png}`);
  clearRenderCache();
  assert.deepEqual(renderCacheSize(), { svg: 0, png: 0 });
});

test("clearImagePlaceholders resets placeholder ids", () => {
  const p = placeholder("ESC-A", 3);
  assert.equal(visibleLen(p), 3);
  assert.equal(placeholder("ESC-A", 3), p, "same image, same id");
  clearImagePlaceholders();
  const q = placeholder("ESC-B", 5);
  assert.match(q, /0/, "ids restart from 0");
  assert.equal(visibleLen(q), 5);
});
