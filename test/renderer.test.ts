// Streaming must not change the output: feeding an answer in any chunking gives the same bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StreamRenderer } from "../src/ui/markdown.js";
import type { TermCaps } from "../src/term/caps.js";

const caps: TermCaps = { cellW: 10, cellH: 21, cols: 80, fg: "#ffffff", bg: "#000000", graphics: "iterm2", measured: "env" };

const ANSWER = String.raw`The **Navier–Stokes** equations describe how fluids move. They express conservation of momentum together with conservation of mass, and the nonlinear term $(\mathbf{u}\cdot\nabla)\mathbf{u}$ is what makes them hard.

## Incompressible case

$$\rho\left(\frac{\partial \mathbf{u}}{\partial t} + (\mathbf{u}\cdot\nabla)\mathbf{u}\right) = -\nabla p + \mu\nabla^2\mathbf{u},$$
with $\nabla\cdot\mathbf{u} = 0$. Here:

- $\mathbf{u}(x,t)$ is the velocity and $p$ the pressure, which is a long bullet that needs to wrap onto a second line in an 80 column terminal.
  - nested item with \(x^2\) inline
1. First step: compute $\int_0^1 x\,dx = \tfrac12$.
2. Second step uses *italic* and ` + "`code`" + String.raw`.

$$
\begin{aligned}
a &= b \
c &= d
\end{aligned}
$$

> A quote with $\alpha$.

` + "```python\nprint('$not math$')\n```" + String.raw`
Broken: $$\frac{1}{$$ and done.
Prices like $5 and $10 stay as text.
The matrix $A = \begin{pmatrix} 2 & 1 \\
1 & 2 \end{pmatrix}$ is symmetric, with eigenvector $\mathbf{v}_1$.`;

function render(chunks: string[]): string {
  let s = "";
  const r = new StreamRenderer({ caps, mathScale: 1.5, width: () => 80, write: (x) => (s += x) });
  for (const c of chunks) r.push(c);
  r.end();
  return s.replace(/\x1b\]1337;File=[^:]*width=(\d+);height=(\d+)[^\x07]*\x07/g, "[IMG $1x$2]");
}

// Column reached by the end of a printed line: text advances one cell per character, an inline
// image advances by its width, and CSI n G jumps to column n.
function lineWidth(l: string): number {
  let col = 0, max = 0;
  for (const tok of l.match(/\[IMG (\d+)x1\]|\x1b\[(\d+)G|\x1b\[[\d;]*[A-Za-z]|\x1b[78]|\[IMG \d+x\d+\]|\P{M}/gu) ?? []) {
    const img = /^\[IMG (\d+)x1\]$/.exec(tok), cha = /^\x1b\[(\d+)G$/.exec(tok);
    if (img) col += Number(img[1]);
    else if (cha) col = Number(cha[1]) - 1;
    else if (!tok.startsWith("\x1b") && !tok.startsWith("[IMG")) col++;
    max = Math.max(max, col);
  }
  return max;
}

const whole = render([ANSWER]);

test("char-by-char streaming matches whole", () => assert.equal(render([...ANSWER]), whole));
test("random chunking matches whole", () => {
  for (let seed = 1; seed < 30; seed++) {
    const chunks: string[] = [];
    let i = 0, x = seed;
    while (i < ANSWER.length) { x = (x * 1103515245 + 12345) % 2 ** 31; const n = 1 + (x % 23); chunks.push(ANSWER.slice(i, i + n)); i += n; }
    assert.equal(render(chunks), whole, `seed ${seed}`);
  }
});
test("display math becomes images, code is untouched", () => {
  assert.equal((whole.match(/\[IMG \d+x([2-9]|\d\d+)\]/g) ?? []).length, 2, "display equations");
  assert.match(whole, /\[IMG \d+x1\]/, "inline ½ should be typeset");
  assert.match(whole, /nested item with \S*x²/, "exact inline maths stays as text");
  assert.match(whole, /print\('\$not math\$'\)/);
  assert.match(whole, /couldn't typeset/);
  assert.match(whole, /\$5 and \$10/);
});
test("inline maths split across lines is joined, matrices never leak raw LaTeX", () => {
  assert.doesNotMatch(whole, /\\begin\{pmatrix\}/);
  assert.match(whole, /A = \(2 1; 1 2\)|\[IMG \d+x1\][^\n]* is symmetric/);
  assert.doesNotMatch(whole, /𝐯/, "bold maths letters should be typeset, not left to the font");
});
test("no visual line exceeds the width", () => {
  for (const l of whole.split("\n")) {
    const vis = lineWidth(l);
    assert.ok(vis <= 80, `too wide (${vis}): ${l}`);
  }
});
if (process.env.DUMP) console.log(whole.replace(/\x1b\[[\d;]*m/g, "").replace(/\x1b/g, "^["));
