// Tests for the interactive option picker (select.ts) and prompt slash-command autocomplete (input.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterCommands, prompt, type SlashCommand } from "../src/ui/input.js";
import { clipAnsi, parseKeyTokens, select } from "../src/ui/select.js";
import { visibleLen } from "../src/ui/theme.js";

function harness() {
  let handler: ((d: Buffer) => void) | undefined;
  let output = "";
  const listen = (h: (d: Buffer) => void) => {
    handler = h;
    return () => { if (handler === h) handler = undefined; };
  };
  const send = (s: string) => handler?.(Buffer.from(s, "utf8"));
  return {
    listen,
    send,
    write: (s: string) => { output += s; },
    get output() { return output; },
    width: () => 80,
  };
}

const SAMPLE_COMMANDS: SlashCommand[] = [
  { name: "/model", usage: "[name]", description: "switch model" },
  { name: "/theme", usage: "[name]", description: "switch theme" },
  { name: "/thinking", description: "toggle reasoning" },
  { name: "/attach", usage: "<file>", description: "attach a file", hasArgs: true },
  { name: "/copy-latex", description: "copy equations" },
];

test("parseKeyTokens splits CSI sequences and standalone ESC cleanly", () => {
  assert.deepEqual(parseKeyTokens("\x1b[A\x1b[B\x1b\r"), ["\x1b[A", "\x1b[B", "\x1b", "\r"]);
  assert.deepEqual(parseKeyTokens("jk1"), ["j", "k", "1"]);
});

test("clipAnsi preserves ANSI codes while bounding visible width", () => {
  const s = "\x1b[1m\x1b[38;2;255;0;0m" + "a".repeat(40) + "\x1b[0m";
  const clipped = clipAnsi(s, 15);
  assert.ok(visibleLen(clipped) <= 15);
  assert.ok(clipped.includes("…"));
});

test("select: arrow keys wrap around, skip headers/notes, and Enter selects", async () => {
  const h = harness();
  const highlights: string[] = [];
  const p = select<string>({
    title: "Pick",
    entries: [
      { kind: "header", label: "Group A" },
      { value: "a", label: "Alpha", current: true },
      { kind: "note", text: "info line" },
      { value: "b", label: "Beta" },
      { value: "c", label: "Gamma" },
    ],
    initialValue: "a",
    onHighlight: (item) => highlights.push(item.value),
    write: h.write,
    width: h.width,
    listen: h.listen,
  });
  h.send("\x1b[B"); // -> b
  h.send("\x1b[B"); // -> c
  h.send("\x1b[B"); // wrap -> a
  h.send("\x1b[A"); // wrap -> c
  h.send("\r");
  const res = await p;
  assert.deepEqual(res, { kind: "select", value: "c", stepValue: undefined });
  assert.deepEqual(highlights, ["b", "c", "a", "c"]);
});

test("select: left/right adjusts secondary step only when activeFor matches", async () => {
  const h = harness();
  const p = select<string>({
    title: "Select model",
    entries: [
      { value: "claude-opus-5-5", label: "opus", current: true },
      { value: "local:qwen", label: "qwen" },
    ],
    initialValue: "claude-opus-5-5",
    step: {
      values: ["low", "medium", "high", "xhigh", "max"],
      index: 2, // high
      format: (v) => `${v} effort`,
      activeFor: (item) => !item.value.startsWith("local:"),
    },
    write: h.write,
    width: h.width,
    listen: h.listen,
  });
  h.send("\x1b[C"); // high -> xhigh
  h.send("\x1b[B"); // move to local:qwen (step inactive)
  h.send("\x1b[D"); // ignored while on local
  h.send("\x1b[A"); // back to opus (still xhigh)
  h.send("\r");
  const res = await p;
  assert.deepEqual(res, { kind: "select", value: "claude-opus-5-5", stepValue: "xhigh" });
});

test("select: number keys jump and confirm; Esc cancels cleanly", async () => {
  const h1 = harness();
  const p1 = select<string>({
    title: "Pick",
    entries: [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
      { value: "third", label: "Third" },
    ],
    write: h1.write,
    width: h1.width,
    listen: h1.listen,
  });
  h1.send("2");
  assert.deepEqual(await p1, { kind: "select", value: "second", stepValue: undefined });

  const h2 = harness();
  const p2 = select<string>({
    title: "Pick",
    entries: [{ value: "only", label: "Only" }],
    write: h2.write,
    width: h2.width,
    listen: h2.listen,
  });
  h2.send("\x1b");
  assert.deepEqual(await p2, { kind: "cancel" });
});

test("filterCommands matches prefixes first, falls back to substrings, and closes on space", () => {
  assert.deepEqual(filterCommands("/", SAMPLE_COMMANDS).map((c) => c.name), ["/model", "/theme", "/thinking", "/attach", "/copy-latex"]);
  assert.deepEqual(filterCommands("/th", SAMPLE_COMMANDS).map((c) => c.name), ["/theme", "/thinking"]);
  assert.deepEqual(filterCommands("/lat", SAMPLE_COMMANDS).map((c) => c.name), ["/copy-latex"]);
  assert.deepEqual(filterCommands("/model ", SAMPLE_COMMANDS), []);
  assert.deepEqual(filterCommands("hello", SAMPLE_COMMANDS), []);
});

test("prompt autocomplete: arrows cycle commands and Enter submits highlighted command", async () => {
  const h = harness();
  const p = prompt({
    status: () => "status",
    commands: SAMPLE_COMMANDS,
    write: h.write,
    width: h.width,
    listen: h.listen,
  });
  h.send("/");
  h.send("t");
  h.send("h"); // matches ["/theme", "/thinking"]
  h.send("\x1b[B"); // highlight "/thinking"
  h.send("\r");
  assert.deepEqual(await p, { kind: "submit", text: "/thinking" });
});

test("prompt autocomplete: Tab/Enter on hasArgs command fills '<cmd> ' instead of submitting bare", async () => {
  const h = harness();
  const p = prompt({
    status: () => "status",
    commands: SAMPLE_COMMANDS,
    write: h.write,
    width: h.width,
    listen: h.listen,
  });
  h.send("/");
  h.send("a"); // matches ["/attach"] (hasArgs: true)
  h.send("\r"); // inserts "/attach " and stays in prompt
  h.send("notes.pdf");
  h.send("\r");
  assert.deepEqual(await p, { kind: "submit", text: "/attach notes.pdf" });
});

test("prompt autocomplete: Esc dismisses menu so Enter submits raw typed text", async () => {
  const h = harness();
  const p = prompt({
    status: () => "status",
    commands: SAMPLE_COMMANDS,
    write: h.write,
    width: h.width,
    listen: h.listen,
  });
  h.send("/");
  h.send("m"); // matches "/model"
  h.send("\x1b"); // dismiss autocomplete
  h.send("\r"); // submit literal "/m"
  assert.deepEqual(await p, { kind: "submit", text: "/m" });
});
