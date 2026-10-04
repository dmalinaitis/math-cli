// The prompt box at the bottom of the screen: a small line editor that redraws on every key and on resize.
//
//   Enter            submit              Ctrl+J or "\" + Enter   newline
//   ←/→ Home/End     move                ↑/↓                     history
//   Ctrl+U           clear line          Ctrl+C                  clear, or exit when empty
//   Ctrl+V           paste text, or attach a copied screenshot / files from Explorer
//   Paste / drag a file onto the window  → attached if it's a path to a supported file
import { readClipboard } from "../term/clipboard.js";
import { onInput } from "../term/keys.js";
import { termCols } from "../term/size.js";
import { theme as t, visibleLen } from "./theme.js";

export interface PromptOptions {
  status: () => string; // line under the box
  above?: () => string[]; // lines above the box (e.g. pending attachments)
  placeholder?: string;
  mask?: boolean; // for API keys
  history?: string[];
  onPaste?: (text: string) => boolean; // return true if consumed (e.g. a dropped file)
}

export type PromptResult = { kind: "submit"; text: string } | { kind: "exit" };

const width = termCols;

// The static box a sent message leaves behind (also used when redrawing the transcript).
export function promptRecord(text: string, w = width()): string {
  const inner = w - 4;
  const rows: string[] = [];
  for (const line of text.split("\n")) {
    const chars = [...line];
    if (!chars.length) rows.push("");
    for (let i = 0; i < chars.length; i += inner) rows.push(chars.slice(i, i + inner).join(""));
  }
  const panel = (s: string) => t.panelBg + s + " ".repeat(Math.max(0, w - visibleLen(s))) + t.reset;
  const body = rows.map((r, i) => panel((i === 0 ? `${t.dim}›${t.reset}${t.panelBg} ` : "  ") + r));
  return [panel(""), ...body, panel("")].join("\n") + "\n\n";
}

export function prompt(o: PromptOptions): Promise<PromptResult> {
  const { stdout } = process;
  let text = "";
  let cur = 0; // cursor index into [...text]
  let histIdx = o.history?.length ?? 0;
  let draft = "";
  let drawn: string[] = []; // lines currently on screen
  let cursorLine = 0, cursorCol = 0; // where we left the terminal cursor, within `drawn`
  let pasting = false, pasteBuf = "";

  const chars = () => [...text];

  function layout(w: number) {
    const inner = w - 4; // "› " + text + right margin
    const shown = o.mask ? "•".repeat(chars().length) : text;
    const rows: string[][] = [[]];
    let cRow = 0, cCol = 0;
    [...shown].forEach((ch, i) => {
      if (i === cur) { cRow = rows.length - 1; cCol = rows[rows.length - 1].length; }
      if (ch === "\n") { rows.push([]); return; }
      if (rows[rows.length - 1].length >= inner) rows.push([]);
      rows[rows.length - 1].push(ch);
    });
    if (cur >= chars().length) {
      if (rows[rows.length - 1].length >= inner) rows.push([]);
      cRow = rows.length - 1;
      cCol = rows[rows.length - 1].length;
    }
    return { rows: rows.map((r) => r.join("")), cRow, cCol };
  }

  const panel = (s: string, w: number) => t.panelBg + s + " ".repeat(Math.max(0, w - visibleLen(s))) + t.reset;

  // Wipe what we drew. Our lines may have been re-wrapped by a resize, so count the rows above the cursor now.
  function erase() {
    if (!drawn.length) return;
    const w = width();
    const rowsOf = (l: string) => Math.max(1, Math.ceil(visibleLen(l) / w));
    let up = Math.floor(cursorCol / w);
    for (let i = 0; i < cursorLine; i++) up += rowsOf(drawn[i]);
    stdout.write(`\r${up ? `\x1b[${up}A` : ""}\x1b[J`);
    drawn = [];
  }

  function draw() {
    const w = width();
    erase();
    const { rows, cRow, cCol } = layout(w);
    const above = o.above?.() ?? [];
    const body = rows.map((r, i) => {
      const lead = i === 0 ? `${t.accent}›${t.reset}${t.panelBg} ` : "  ";
      const content = !text && i === 0 ? `${t.dim}${o.placeholder ?? ""}${t.reset}${t.panelBg}` : r;
      return panel(lead + content, w);
    });
    drawn = [...above, panel("", w), ...body, panel("", w), o.status()];
    stdout.write(drawn.join("\n"));
    // Park the terminal cursor at the edit position.
    cursorLine = above.length + 1 + cRow;
    cursorCol = 2 + cCol;
    const fromBottom = drawn.length - 1 - cursorLine;
    stdout.write(`${fromBottom ? `\x1b[${fromBottom}A` : ""}\r${cursorCol ? `\x1b[${cursorCol}C` : ""}`);
  }

  // Replace the live box with a static record of what was sent (or nothing, for masked input / exit).
  function settle(record: boolean) {
    erase();
    if (record && text.trim()) stdout.write(promptRecord(text));
  }

  function insert(s: string) {
    const c = chars();
    c.splice(cur, 0, ...s);
    text = c.join("");
    cur += [...s].length;
  }

  return new Promise((resolve) => {
    const finish = (r: PromptResult) => {
      stopInput();
      stdout.off("resize", onResize);
      stdout.write("\x1b[?2004l");
      resolve(r);
    };

    const submit = () => {
      if (text.endsWith("\\")) { // "\" + Enter = newline
        text = text.slice(0, -1); cur = Math.min(cur, chars().length);
        insert("\n");
        draw();
        return;
      }
      settle(!o.mask);
      if (o.history && text.trim() && !o.mask) o.history.push(text);
      finish({ kind: "submit", text });
    };

    const handlePaste = (s: string) => {
      s = s.replace(/\r\n?/g, "\n");
      if (o.onPaste?.(s)) return;
      insert(s);
    };

    function onKey(k: string) {
      switch (k) {
        case "\r": submit(); return;
        case "\n": insert("\n"); break;
        case "\x03":
          if (text) { text = ""; cur = 0; break; }
          settle(false);
          finish({ kind: "exit" });
          return;
        case "\x04": if (!text) { settle(false); finish({ kind: "exit" }); return; } break;
        case "\x15": text = ""; cur = 0; break;
        case "\x16": { // Ctrl+V: the terminal doesn't paste on this key, so read the clipboard ourselves
          const c = readClipboard();
          if (c.kind === "text") handlePaste(c.text);
          else if (c.kind === "image" || c.kind === "files") {
            const paths = (c.kind === "image" ? [c.path] : c.paths).map((p) => `"${p}"`).join(" ");
            if (!o.onPaste?.(paths)) insert(paths);
          }
          break;
        }
        case "\x7f": case "\b":
          if (cur > 0) { const c = chars(); c.splice(cur - 1, 1); text = c.join(""); cur--; }
          break;
        case "\x1b[3~": { const c = chars(); c.splice(cur, 1); text = c.join(""); break; }
        case "\x1b[D": cur = Math.max(0, cur - 1); break;
        case "\x1b[C": cur = Math.min(chars().length, cur + 1); break;
        case "\x1b[H": case "\x1b[1~": case "\x1bOH": case "\x01": cur = 0; break;
        case "\x1b[F": case "\x1b[4~": case "\x1bOF": case "\x05": cur = chars().length; break;
        case "\x1b[A":
          if (o.history && histIdx > 0) {
            if (histIdx === o.history.length) draft = text;
            text = o.history[--histIdx]; cur = chars().length;
          }
          break;
        case "\x1b[B":
          if (o.history && histIdx < o.history.length) {
            histIdx++;
            text = histIdx === o.history.length ? draft : o.history[histIdx];
            cur = chars().length;
          }
          break;
        default:
          if (k.startsWith("\x1b") || /^[\x00-\x1f]$/.test(k)) return; // unhandled key
          insert(k);
      }
      draw();
    }

    function onData(d: Buffer) {
      let s = d.toString("utf8");
      while (s) {
        if (pasting) {
          const end = s.indexOf("\x1b[201~");
          if (end < 0) { pasteBuf += s; return; }
          pasteBuf += s.slice(0, end);
          s = s.slice(end + 6);
          pasting = false;
          handlePaste(pasteBuf);
          pasteBuf = "";
          draw();
          continue;
        }
        if (s.startsWith("\x1b[200~")) { pasting = true; s = s.slice(6); continue; }
        // A multi-char chunk with a newline in it is a paste even without bracketed-paste support.
        if (s.length > 1 && !s.startsWith("\x1b") && /[\r\n]/.test(s.replace(/\r$/, ""))) {
          handlePaste(s.replace(/\r$/, ""));
          draw();
          return;
        }
        const m = /^(\x1b\[[\d;]*[A-Za-z~]|\x1bO.|\x1b.?|[\s\S])/u.exec(s)!;
        // Batch plain printable runs (fast typing / paste without newlines) into one insert.
        const run = /^[^\x00-\x1f\x7f\x1b]+/u.exec(s);
        if (run && run[0].length > 1) {
          if (o.onPaste?.(run[0])) { draw(); s = s.slice(run[0].length); continue; }
          insert(run[0]);
          draw();
          s = s.slice(run[0].length);
          continue;
        }
        onKey(m[0]);
        s = s.slice(m[0].length);
      }
    }

    const onResize = () => draw();

    stdout.write("\x1b[?2004h\x1b[?25h");
    const stopInput = onInput(onData);
    stdout.on("resize", onResize);
    draw();
  });
}
