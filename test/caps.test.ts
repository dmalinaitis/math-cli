// Terminal capability probe: env overrides must skip the escape round-trip entirely, and bad values
// must never leak into the cell size.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { queryTerminal } from "../src/term/caps.js";

const saved = {
  w: process.env.MATHCLI_CELL_W,
  h: process.env.MATHCLI_CELL_H,
  inTTY: Object.getOwnPropertyDescriptor(process.stdin, "isTTY"),
  outTTY: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
  write: process.stdout.write,
};
let writes: string[] = [];

function setTTY(on: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value: on, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: on, configurable: true });
}
function restoreTTY(stream: object, d?: PropertyDescriptor) {
  if (d) Object.defineProperty(stream, "isTTY", d);
  else delete (stream as { isTTY?: boolean }).isTTY;
}
function setEnv(w?: string, h?: string) {
  if (w === undefined) delete process.env.MATHCLI_CELL_W;
  else process.env.MATHCLI_CELL_W = w;
  if (h === undefined) delete process.env.MATHCLI_CELL_H;
  else process.env.MATHCLI_CELL_H = h;
}

beforeEach(() => {
  writes = [];
  process.stdout.write = ((s: string | Uint8Array) => (writes.push(String(s)), true)) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = saved.write;
  restoreTTY(process.stdin, saved.inTTY);
  restoreTTY(process.stdout, saved.outTTY);
  setEnv(saved.w, saved.h);
});

test("valid MATHCLI_CELL_W/H bypass the escape probe even on a TTY", async () => {
  setEnv("10.5", "22");
  setTTY(true); // would probe (and enter raw mode) if the bypass didn't return early
  const start = Date.now();
  const caps = await queryTerminal();
  assert.equal(caps.measured, "env");
  assert.equal(caps.cellW, 10.5);
  assert.equal(caps.cellH, 22);
  assert.deepEqual(writes, [], "no escape sequences sent");
  assert.ok(Date.now() - start < 50);
});

for (const [w, h] of [["0", "20"], ["10", "-3"], ["abc", "20"], ["10", "Infinity"], ["", "20"], ["10", undefined]]) {
  test(`invalid env cell size (${w}, ${h}) is ignored`, async () => {
    setEnv(w, h);
    setTTY(false);
    const caps = await queryTerminal();
    assert.equal(caps.measured, false);
    assert.equal(caps.cellW, 9);
    assert.equal(caps.cellH, 19);
  });
}

test("accepts a numeric timeout (backwards compatible) and an options object", async () => {
  setEnv(undefined, undefined);
  setTTY(false);
  for (const opt of [undefined, 5, {}, { timeoutMs: 5 }, { needColors: true }]) {
    const caps = await queryTerminal(opt as any);
    assert.equal(caps.measured, false);
    assert.equal(caps.fg, "#e6e6f0");
    assert.equal(caps.bg, "#16161e");
  }
});

test("needColors still probes colours when env gives the cell size", async () => {
  setEnv("10", "20");
  setTTY(true);
  const stdin = process.stdin as any;
  const savedRaw = stdin.setRawMode;
  stdin.setRawMode = () => stdin;
  try {
    const p = queryTerminal({ needColors: true, timeoutMs: 1000 });
    assert.ok(writes.join("").includes("\x1b]11;?"), "asks for OSC 11");
    process.stdin.emit("data", Buffer.from("\x1b[6;30;15t\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\"));
    const caps = await p;
    assert.equal(caps.measured, "env"); // env wins over the escape reply
    assert.equal(caps.cellW, 10);
    assert.equal(caps.fg, "#ffffff");
    assert.equal(caps.bg, "#000000");
  } finally {
    stdin.setRawMode = savedRaw;
    process.stdin.pause();
  }
});

test("size-only probe resolves as soon as the size reply lands and skips OSC queries", async () => {
  setEnv(undefined, undefined);
  setTTY(true);
  const stdin = process.stdin as any;
  const savedRaw = stdin.setRawMode;
  stdin.setRawMode = () => stdin;
  try {
    const start = Date.now();
    const p = queryTerminal({ timeoutMs: 5000 });
    assert.ok(!writes.join("").includes("\x1b]1"), "no OSC 10/11 queries");
    process.stdin.emit("data", Buffer.from("\x1b[6;24;12t"));
    const caps = await p;
    assert.ok(Date.now() - start < 1000, "resolved without waiting for the timeout");
    assert.equal(caps.measured, "escape");
    assert.equal(caps.cellW, 12);
    assert.equal(caps.cellH, 24);
  } finally {
    stdin.setRawMode = savedRaw;
    process.stdin.pause();
  }
});

test("zero-sized escape replies are rejected", async () => {
  setEnv(undefined, undefined);
  setTTY(true);
  const stdin = process.stdin as any;
  const savedRaw = stdin.setRawMode;
  const savedPane = process.env.WEZTERM_PANE;
  delete process.env.WEZTERM_PANE;
  stdin.setRawMode = () => stdin;
  try {
    const p = queryTerminal({ timeoutMs: 5000 });
    process.stdin.emit("data", Buffer.from("\x1b[6;0;0t"));
    const caps = await p;
    assert.equal(caps.measured, false);
    assert.equal(caps.cellW, 9);
    assert.equal(caps.cellH, 19);
  } finally {
    stdin.setRawMode = savedRaw;
    process.stdin.pause();
    if (savedPane !== undefined) process.env.WEZTERM_PANE = savedPane;
  }
});
