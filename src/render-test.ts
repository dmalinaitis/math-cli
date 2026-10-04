// Renders the sample equations to PNG files so the renderer can be checked without a terminal.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderMath } from "./math/render.js";
import { SAMPLES } from "./samples.js";

const outDir = process.argv[2] ?? ".cache/render-test";
mkdirSync(outDir, { recursive: true });
SAMPLES.forEach((tex, i) => {
  const r = renderMath(tex, {
    display: true, emPx: 30, color: "#e6e6f0", cellW: 10, cellH: 21, maxWidthPx: 1200, padCellsY: 0,
  });
  const file = join(outDir, `eq${i}.png`);
  writeFileSync(file, r.png);
  console.log(`${file}  ${r.cols}x${r.rows} cells  scale=${r.scaled.toFixed(2)}`);
});
