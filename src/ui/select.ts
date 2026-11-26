// Inline interactive option picker (↑/↓ to move, ←/→ for optional secondary setting, Enter to select, Esc to cancel).
// Shares the single raw-mode stdin router in term/keys.ts so it never toggles raw mode on Windows ConPTY.
import { onInput } from "../term/keys.js";
import { termCols } from "../term/size.js";
import { theme as t, visibleLen } from "./theme.js";

export interface SelectItem<T> {
  kind?: "option";
  value: T;
  label: string;
  description?: string;
  extra?: string; // optional pre-styled segment (e.g. theme colour swatch)
  current?: boolean;
  disabled?: boolean;
}

export interface SelectHeader {
  kind: "header";
  label: string;
}

export interface SelectNote {
  kind: "note";
  text: string;
}

export type SelectEntry<T> = SelectItem<T> | SelectHeader | SelectNote;

export interface SelectStep<T> {
  values: readonly string[];
  index: number;
  format: (value: string) => string;
  activeFor?: (item: SelectItem<T>) => boolean;
}

export interface SelectOptions<T> {
  title: string;
  subtitle?: string;
  entries: SelectEntry<T>[];
  initialValue?: T;
  step?: SelectStep<T>;
  onHighlight?: (item: SelectItem<T>) => void;
  hint?: string;
  // Injectable hooks for unit tests.
  write?: (s: string) => void;
  width?: () => number;
  listen?: (h: (d: Buffer) => void) => () => void;
}

export type SelectResult<T> =
  | { kind: "select"; value: T; stepValue?: string }
  | { kind: "cancel" };

const isOption = <T>(e: SelectEntry<T>): e is SelectItem<T> => e.kind !== "header" && e.kind !== "note";

// Truncate an ANSI-styled string to at most `maxCols` visible columns so no row ever wraps unexpectedly.
export function clipAnsi(s: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleLen(s) <= maxCols) return s;
  let out = "";
  let vis = 0;
  const limit = Math.max(1, maxCols - 1);
  const re = /\x1b\[[\d;]*m|\P{M}\p{M}*/gu;
  for (const m of s.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith("\x1b")) {
      out += tok;
      continue;
    }
    if (vis + 1 > limit) break;
    out += tok;
    vis++;
  }
  return out + "…" + t.reset;
}

// Parse one key token from raw stdin data. Standalone ESC is treated as "esc", while CSI/SS3 sequences stay intact.
export function parseKeyTokens(raw: string): string[] {
  const out: string[] = [];
  let s = raw;
  while (s) {
    const m = /^(\x1b\[[\d;]*[A-Za-z~]|\x1bO.|\x1b|[\s\S])/u.exec(s)!;
    out.push(m[0]);
    s = s.slice(m[0].length);
  }
  return out;
}

export function select<T>(o: SelectOptions<T>): Promise<SelectResult<T>> {
  const write = o.write ?? ((s: string) => process.stdout.write(s));
  const width = o.width ?? termCols;
  const listen = o.listen ?? onInput;

  const selectable: { entryIdx: number; item: SelectItem<T> }[] = [];
  o.entries.forEach((e, i) => {
    if (isOption(e) && !e.disabled) selectable.push({ entryIdx: i, item: e });
  });
  if (!selectable.length) return Promise.resolve({ kind: "cancel" });
  if (!o.listen && (!process.stdin.isTTY || !process.stdout.isTTY)) return Promise.resolve({ kind: "cancel" });

  let cursor = selectable.findIndex((s) => (o.initialValue !== undefined ? s.item.value === o.initialValue : s.item.current));
  if (cursor < 0) cursor = 0;

  let stepIdx = o.step ? Math.max(0, Math.min(o.step.values.length - 1, o.step.index)) : 0;
  let drawnRows = 0;

  // Align descriptions neatly across options.
  const labelW = Math.min(34, Math.max(8, ...selectable.map((s) => visibleLen(s.item.label))));
  const showNums = selectable.length <= 9;
  const numOf = new Map<number, number>();
  selectable.forEach((s, idx) => numOf.set(s.entryIdx, idx + 1));

  function activeItem(): SelectItem<T> {
    return selectable[cursor].item;
  }

  function stepActive(): boolean {
    if (!o.step) return false;
    return o.step.activeFor ? o.step.activeFor(activeItem()) : true;
  }

  function erase() {
    if (!drawnRows) return;
    write(`\r${drawnRows > 1 ? `\x1b[${drawnRows - 1}A` : ""}\x1b[J`);
    drawnRows = 0;
  }

  function renderLines(w: number): string[] {
    const maxW = Math.max(20, w - 1);
    const lines: string[] = [];
    const ruleW = Math.min(maxW - 2, 72);
    lines.push(`  ${t.accent}${"─".repeat(Math.max(10, ruleW))}${t.reset}`);
    lines.push(`  ${t.bold}${t.heading}${o.title}${t.reset}`);
    if (o.subtitle) lines.push(`  ${t.dim}${o.subtitle}${t.reset}`);
    lines.push("");

    const selectedEntryIdx = selectable[cursor].entryIdx;
    for (let i = 0; i < o.entries.length; i++) {
      const e = o.entries[i];
      if (e.kind === "header") {
        if (lines.length > 4 && lines[lines.length - 1] !== "") lines.push("");
        lines.push(`  ${t.bold}${e.label}${t.reset}`);
        continue;
      }
      if (e.kind === "note") {
        lines.push(`    ${t.dim}${e.text}${t.reset}`);
        continue;
      }
      const isSel = i === selectedEntryIdx;
      const pointer = isSel ? `${t.accent}›${t.reset}` : " ";
      const num = showNums ? `${t.dim}${numOf.get(i) ?? " "}.${t.reset} ` : "";
      const pad = " ".repeat(Math.max(0, labelW - visibleLen(e.label)));
      const labelStyled = e.disabled
        ? `${t.dim}${e.label}${t.reset}`
        : isSel
          ? `${t.bold}${t.accent}${e.label}${t.reset}`
          : e.label;
      const check = e.current ? ` ${t.accent}✓${t.reset}` : "  ";
      const extra = e.extra ? ` ${e.extra}` : "";
      const desc = e.description ? `  ${t.dim}${e.description}${t.reset}` : "";
      lines.push(clipAnsi(`  ${pointer} ${num}${labelStyled}${pad}${check}${extra}${desc}`, maxW));
    }

    if (o.step && stepActive()) {
      lines.push("");
      const val = o.step.values[stepIdx];
      lines.push(clipAnsi(`  ${t.accent}◉${t.reset} ${o.step.format(val)}`, maxW));
    }

    lines.push("");
    const hints = [
      "↑/↓ move",
      ...(o.step && stepActive() ? ["←/→ adjust"] : []),
      ...(showNums ? ["1-" + selectable.length + " jump"] : []),
      ...(o.hint ? [o.hint] : []),
      "Enter select",
      "Esc cancel",
    ];
    lines.push(clipAnsi(`  ${t.dim}${hints.join(" · ")}${t.reset}`, maxW));
    return lines;
  }

  function draw() {
    erase();
    const lines = renderLines(width());
    write(lines.join("\n"));
    drawnRows = lines.length;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: SelectResult<T>) => {
      if (settled) return;
      settled = true;
      stopInput();
      if (!o.listen) process.stdout.off("resize", onResize);
      erase();
      write("\x1b[?25h");
      resolve(res);
    };

    const move = (delta: number) => {
      cursor = (cursor + delta + selectable.length) % selectable.length;
      o.onHighlight?.(activeItem());
      draw();
    };

    const confirm = () => {
      const item = activeItem();
      const stepValue = o.step && stepActive() ? o.step.values[stepIdx] : undefined;
      finish({ kind: "select", value: item.value, stepValue });
    };

    const onKey = (k: string) => {
      switch (k) {
        case "\x1b[A": case "k": move(-1); return;
        case "\x1b[B": case "j": move(1); return;
        case "\x1b[D": case "h":
          if (o.step && stepActive()) {
            stepIdx = Math.max(0, stepIdx - 1);
            draw();
          }
          return;
        case "\x1b[C": case "l":
          if (o.step && stepActive()) {
            stepIdx = Math.min(o.step.values.length - 1, stepIdx + 1);
            draw();
          }
          return;
        case "\r": case "\n": confirm(); return;
        case "\x1b": case "\x03": case "q": finish({ kind: "cancel" }); return;
        default:
          if (showNums && /^[1-9]$/.test(k)) {
            const idx = Number(k) - 1;
            if (idx < selectable.length) {
              cursor = idx;
              o.onHighlight?.(activeItem());
              confirm();
            }
          }
      }
    };

    const onData = (d: Buffer) => {
      for (const k of parseKeyTokens(d.toString("utf8"))) {
        if (settled) break;
        onKey(k);
      }
    };

    const onResize = () => draw();
    write("\x1b[?25l");
    const stopInput = listen(onData);
    if (!o.listen) process.stdout.on("resize", onResize);
    draw();
  });
}
