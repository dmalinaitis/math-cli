// Phase 0: print a canned answer the way the real CLI will, to tune sizing in a real terminal.
//   npm run spike                      (in WezTerm)
//   npm run spike -- --scale 1.4       (display-math size relative to the text font)
import { queryTerminal } from "./term/caps.js";
import { printImage } from "./term/image.js";
import { renderMath, MathError } from "./math/render.js";
import { latexToUnicode } from "./math/unicode.js";
import { segment, INLINE } from "./segment.js";

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};

const ANSWER = String.raw`The Navier–Stokes equations describe how fluids—liquids and gases—move. They express conservation of momentum together with conservation of mass.

For an incompressible Newtonian fluid:

$$\rho\left(\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u}\cdot\nabla)\mathbf{u}\right) = -\nabla p + \mu\nabla^2\mathbf{u} + \rho\mathbf{f},$$

with the incompressibility condition

$$\nabla\cdot\mathbf{u} = 0.$$

Here:

- $\mathbf{u}(x,t)$ is the fluid velocity.
- $p(x,t)$ is pressure.
- $\rho$ is density and $\mu$ is dynamic viscosity.
- $\mathbf{f}$ represents forces per unit mass, such as gravity.

The nonlinear term $(\mathbf{u}\cdot\nabla)\mathbf{u}$ makes turbulent motion hard to analyse. A few more shapes to check sizing:

$$f(x) = \begin{cases} x^2 \sin\frac{1}{x} & x \neq 0 \\ 0 & x = 0 \end{cases} \qquad \int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}$$

$$\begin{aligned} \zeta(s) &= \sum_{n=1}^{\infty} \frac{1}{n^s} = \prod_{p\ \text{prime}} \frac{1}{1-p^{-s}} \end{aligned}$$

$$A = \begin{pmatrix} a_{11} & \cdots & a_{1n} \\ \vdots & \ddots & \vdots \\ a_{m1} & \cdots & a_{mn} \end{pmatrix}$$

And a broken one, which should fall back to source: $$\frac{1}{$$`;

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  panel: "\x1b[48;2;42;42;58m", accent: "\x1b[38;2;240;180;80m", green: "\x1b[38;2;150;210;150m",
  err: "\x1b[38;2;230;120;120m",
};

const caps = await queryTerminal({ needColors: true });
const width = () => process.stdout.columns || caps.cols;
const indent = 2;
const emPx = (caps.cellH / 1.2) * arg("scale", 1.5); // font em ≈ cell height / line-height
const oversample = caps.measured ? 1 : 3; // guessed cell size → render big and let the terminal downscale
const len = (s: string) => [...s.replace(/\x1b\[[\d;]*m/g, "")].length;

const wrap = (text: string, w: number) => {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if (len(line) + len(word) + 1 > w && line) { lines.push(line); line = ""; }
      line += (line ? " " : "") + word;
    }
    lines.push(line);
  }
  return lines;
};

const panelLines = (text: string, prefix: string, w: number) => {
  const pad = " ".repeat(Math.max(0, w - len(text) - len(prefix) - 1));
  const blank = c.panel + " ".repeat(w) + c.reset;
  return [blank, `${c.panel}${prefix}${c.panel} ${text}${c.panel}${pad}${c.reset}`, blank];
};

const cellInfo = caps.measured ? `measured via ${caps.measured}` : "guessed — rendering 3× oversampled";
console.log(`${c.dim}cell ${caps.cellW.toFixed(1)}×${caps.cellH.toFixed(1)}px (${cellInfo}) · fg ${caps.fg} · graphics ${caps.graphics}${c.reset}\n`);
console.log(panelLines("What are the Navier–Stokes equations?", `${c.dim}›${c.reset}`, width()).join("\n"));
console.log();

let first = true;
for (const seg of segment(ANSWER)) {
  if (seg.kind === "text") {
    const prose = seg.text.replace(INLINE, (_m, a, b) => latexToUnicode(a ?? b)).replace(/^\n+|\n+$/g, "");
    if (!prose) continue;
    for (const line of wrap(prose, width() - indent - 1)) {
      console.log((first ? `${c.dim}•${c.reset} ` : " ".repeat(indent)) + line);
      first = false;
    }
    continue;
  }
  try {
    if (caps.graphics === "none") throw new MathError("no graphics");
    const r = renderMath(seg.tex, {
      display: true, emPx, color: caps.fg, cellW: caps.cellW, cellH: caps.cellH,
      maxWidthPx: (width() - indent - 2) * caps.cellW, padCellsY: 0, oversample,
    });
    console.log();
    printImage(r.png, r.cols, r.rows, caps.graphics, indent);
    console.log();
  } catch (e) {
    const why = e instanceof MathError ? e.message : String(e);
    console.log(`\n${" ".repeat(indent)}${c.dim}$$${c.reset} ${seg.tex} ${c.dim}$$${c.reset}  ${c.err}(${why})${c.reset}\n`);
  }
}
console.log();

// Live prompt box + status line: redrawn on every keystroke and on resize.
// Type to see it update; Enter or Ctrl+C exits.
let input = "";
let drawnWidth = 0;
let drawnLines: string[] = [];
const status = `${c.green}claude-sonnet-5-5${c.reset} ${c.dim}·${c.reset} ${c.green}${process.cwd().replace(process.env.USERPROFILE ?? "~", "~")}${c.reset}`;

function drawPrompt() {
  const w = width();
  if (drawnLines.length) {
    // The terminal may have re-wrapped our old lines after a resize: count the rows they occupy now.
    const rows = drawnLines.reduce((n, l) => n + Math.max(1, Math.ceil(len(l) / w)), 0);
    process.stdout.write(`\r${rows > 1 ? `\x1b[${rows - 1}A` : ""}\x1b[J`);
  }
  const text = input ? input : `${c.dim}Ask a maths question…${c.reset}`;
  drawnLines = [...panelLines(text, `${c.accent}›${c.reset}`, w), status];
  drawnWidth = w;
  process.stdout.write(drawnLines.join("\n"));
}

drawPrompt();
process.stdout.on("resize", () => width() !== drawnWidth && drawPrompt());
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (d: Buffer) => {
  const k = d.toString("utf8");
  if (k === "\x03" || k === "\r") {
    process.stdout.write("\n");
    process.exit(0);
  }
  if (k === "\x7f" || k === "\b") input = [...input].slice(0, -1).join("");
  else if (!k.startsWith("\x1b")) input += k.replace(/[\x00-\x1f]/g, "");
  drawPrompt();
});
