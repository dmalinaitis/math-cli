// Replays a canned, equation-heavy answer through the real renderer at LLM-like speed (no API calls).
//   npx tsx src/dev/stream-demo.ts [delayMs] [fixture.md]
import { readFileSync } from "node:fs";
import { queryTerminal } from "../term/caps.js";
import { onInput } from "../term/keys.js";
import { StreamRenderer } from "../ui/markdown.js";

const delay = Number(process.argv[2] ?? 15);
const answer = readFileSync(process.argv[3] ?? "test/fixtures/gr-answer.md", "utf8");

const caps = await queryTerminal();
const r = new StreamRenderer({ caps, mathScale: 1.5, width: () => process.stdout.columns || 100, write: (s) => process.stdout.write(s) });
for (let i = 0; i < answer.length; ) {
  const n = 2 + Math.floor(Math.random() * 12);
  r.push(answer.slice(i, i + n));
  i += n;
  await new Promise((res) => setTimeout(res, delay));
}
r.end();
process.stdout.write("\n[demo done]\n");
onInput(() => process.exit(0)); // keep the window open for inspection; any key (or closing it) exits
