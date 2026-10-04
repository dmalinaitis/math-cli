// Streaming markdown renderer for the terminal.
//
// Text arrives in small deltas. Complete lines are rendered as they close; within a long paragraph,
// wrapped visual lines are printed as soon as they're full (greedy wrapping is prefix-stable, so a
// printed line never changes). Display math ($$…$$ / \[…\]) is held until it closes, then rendered
// as an image. Inline math ($…$) becomes Unicode text.
import type { TermCaps } from "../term/caps.js";
import { imageBlock, imageEscape } from "../term/image.js";
import { renderMath, renderInline, MathError } from "../math/render.js";
import { latexToUnicode, latexToUnicodeExact } from "../math/unicode.js";
import { theme as t, visibleLen } from "./theme.js";
import { expandLine, placeholder } from "./text.js";

const INDENT = 2;
const BASELINE = 0.76; // text baseline as a fraction of the cell height (typical for monospace fonts)

export interface RendererOptions {
  caps: TermCaps;
  mathScale: number;
  inlineMath?: "auto" | "image" | "unicode";
  inlineScale?: number;
  width: () => number;
  write: (s: string) => void;
}

interface Block {
  first: string; // prefix for the first visual line
  rest: string; // prefix for continuation lines
  body: string; // styled text
  wrap: boolean;
}

export class StreamRenderer {
  private buf = "";
  private mode: "text" | "math" | "code" = "text";
  private mathBuf = "";
  private mathClose = "$$";
  private emitted = 0; // visual lines of the current (incomplete) line already printed
  private held = ""; // a line whose inline $…$ continues on the next line
  private heldLines = 0;
  private started = false;
  private lastBlank = true;
  readonly displayMath: string[] = []; // every display equation in this answer, for /copy

  constructor(private o: RendererOptions) {}

  // Inline maths: plain Unicode when that's exact (ρ, x², ℝⁿ); otherwise a one-row typeset image
  // (g_{μν}, fractions, roots), falling back to approximate Unicode if it can't fit a row.
  private inlineMath = (tex: string): string => {
    const { caps } = this.o;
    const mode = this.o.inlineMath ?? "auto";
    const uni = latexToUnicodeExact(tex);
    const text = t.inlineMath + uni.text + t.reset;
    if (mode === "unicode" || caps.graphics === "none" || (mode === "auto" && uni.exact)) return text;
    try {
      const r = renderInline(tex, {
        emPx: (caps.cellH / 1.2) * (this.o.inlineScale ?? 1),
        color: t.def.inlineMath,
        cellW: caps.cellW,
        cellH: caps.cellH,
        baseline: BASELINE,
        oversample: caps.measured ? 1 : 3,
      });
      return r ? placeholder(imageEscape(r.png, r.cols, 1, caps.graphics), r.cols) : text;
    } catch {
      return text; // MathJax couldn't parse it
    }
  };

  push(delta: string) {
    this.buf += delta;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.handleLine(line);
    }
    if (this.mode === "text") this.streamPartial(this.buf);
  }

  end() {
    if (this.buf) this.handleLine(this.buf);
    if (this.held) {
      const h = this.held;
      this.held = "";
      this.finishLine(h);
    }
    this.buf = "";
    if (this.mode === "math") this.renderDisplay(this.mathBuf, true); // never closed: show source
    if (this.mode === "code") this.write(t.reset);
    this.mode = "text";
  }

  // ---- line handling -------------------------------------------------------------------------

  private handleLine(line: string) {
    if (this.mode === "code") {
      if (/^\s*```/.test(line)) {
        this.mode = "text";
        this.blank();
      } else {
        this.out(" ".repeat(INDENT + 2) + t.codeBlock + line + t.reset);
      }
      return;
    }
    if (this.mode === "math") {
      const close = line.indexOf(this.mathClose);
      if (close < 0) {
        this.mathBuf += line + "\n";
        return;
      }
      this.mathBuf += line.slice(0, close);
      this.mode = "text";
      this.renderDisplay(this.mathBuf);
      const rest = line.slice(close + this.mathClose.length);
      if (rest.trim() && !/^[\s.,;:]*$/.test(rest)) this.handleLine(rest);
      return;
    }

    // Models sometimes break a line inside inline maths ($A = \begin{pmatrix} … ⏎ … \end{pmatrix}$):
    // join it with the following line, unless that line starts a new block.
    if (this.held) {
      const h = this.held;
      this.held = "";
      if (!line.trim() || STARTS_BLOCK.test(line)) {
        this.heldLines = 0;
        this.finishLine(h);
      } else {
        line = h + " " + line.trim();
      }
    }

    if (/^\s*```/.test(line)) {
      this.finishLine("");
      this.mode = "code";
      const lang = line.trim().slice(3);
      if (!this.lastBlank) this.out("");
      if (lang) this.out(" ".repeat(INDENT + 2) + t.dim + lang + t.reset);
      return;
    }

    const open = findDisplayOpen(line);
    if (open) {
      const before = line.slice(0, open.at);
      if (before.trim()) this.finishLine(before);
      else this.emitted = 0;
      const after = line.slice(open.at + open.token.length);
      const close = after.indexOf(open.close);
      if (close >= 0) {
        this.renderDisplay(after.slice(0, close));
        const rest = after.slice(close + open.close.length);
        if (rest.trim() && !/^[\s.,;:]*$/.test(rest)) this.handleLine(rest);
      } else {
        this.mode = "math";
        this.mathClose = open.close;
        this.mathBuf = after + "\n";
      }
      return;
    }
    if (unclosedInline(line) && this.heldLines < 4) {
      this.held = line;
      this.heldLines++;
      return;
    }
    this.heldLines = 0;
    this.finishLine(line);
  }

  private finishLine(line: string) {
    const block = formatBlock(line, this.inlineMath);
    if (!block) {
      this.emitted = 0;
      this.blank();
      return;
    }
    if (/^#{1,6}\s/.test(line.trim()) && !this.lastBlank) this.out("");
    const lines = this.layout(block);
    for (const l of lines.slice(this.emitted)) this.out(l);
    this.emitted = 0;
  }

  // Print the full visual lines of a paragraph that is still streaming in.
  private streamPartial(partial: string) {
    if (this.held && partial) partial = this.held + " " + partial.trimStart();
    if (!partial ||/^\s*(```|\$\$|\\\[|\||#)/.test(partial)) return;
    const safe = safePrefix(partial);
    if (!safe) return;
    const block = formatBlock(safe, this.inlineMath);
    if (!block || !block.wrap) return;
    const lines = this.layout(block);
    while (this.emitted < lines.length - 1) this.out(lines[this.emitted++]);
  }

  private layout(b: Block): string[] {
    // The answer opens with a "•" marker in the gutter, as in Codex — unless it opens with its own list marker.
    const plain = b.first === " ".repeat(INDENT);
    const firstPrefix = this.started || !plain ? b.first : `${t.bullet}•${t.reset}` + b.first.slice(1);
    if (!b.wrap) return [firstPrefix + b.body + t.reset];
    const w = Math.max(20, this.o.width() - 1);
    return wrapStyled(b.body, w - visibleLen(b.first), w - visibleLen(b.rest)).map(
      (l, i) => (i === 0 ? firstPrefix : b.rest) + l,
    );
  }

  private renderDisplay(tex: string, unclosed = false) {
    tex = tex.trim();
    if (!tex) return;
    this.displayMath.push(tex);
    const { caps } = this.o;
    try {
      if (unclosed) throw new MathError("unclosed $$");
      if (caps.graphics === "none") throw new MathError("no terminal graphics");
      const r = renderMath(tex, {
        display: true,
        emPx: (caps.cellH / 1.2) * this.o.mathScale,
        color: t.def.displayMath,
        cellW: caps.cellW,
        cellH: caps.cellH,
        maxWidthPx: (this.o.width() - INDENT - 1) * caps.cellW,
        minScale: 0.5,
        oversample: caps.measured ? 1 : 3,
      });
      if (!this.lastBlank) this.out("");
      this.started = true;
      this.write(imageBlock(r.png, r.cols, r.rows, caps.graphics, INDENT));
      this.out("");
    } catch (e) {
      // Fall back to Unicode, with the source available via /copy.
      const why = e instanceof MathError ? e.message : String(e);
      if (!this.lastBlank) this.out("");
      const uni = latexToUnicode(tex.replace(/\\\\/g, " ; ").replace(/&/g, " "));
      this.out(" ".repeat(INDENT + 2) + t.inlineMath + uni + t.reset);
      if (caps.graphics !== "none") this.out(" ".repeat(INDENT + 2) + t.dim + `(couldn't typeset: ${why})` + t.reset);
      this.out("");
    }
  }

  // ---- output --------------------------------------------------------------------------------

  private out(line: string) {
    this.started = true;
    this.lastBlank = line.trim() === "";
    this.write(expandLine(line) + "\n");
  }

  private blank() {
    if (!this.lastBlank && this.started) this.out("");
  }

  private write(s: string) {
    this.o.write(s);
  }
}

// ---- block formatting ------------------------------------------------------------------------

const STARTS_BLOCK = /^\s*([-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||```|\$\$|\\\[)/;

// True if the line opens an inline $…$ it doesn't close ($$ and code spans don't count).
function unclosedInline(s: string): boolean {
  let inMath = false, inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") { i++; continue; }
    if (c === "`" && !inMath) inCode = !inCode;
    else if (c === "$" && !inCode) {
      if (s[i + 1] === "$") { i++; continue; }
      inMath = !inMath;
    }
  }
  return inMath;
}

function findDisplayOpen(line: string): { at: number; token: string; close: string } | undefined {
  const d = line.indexOf("$$");
  const b = line.indexOf("\\[");
  if (d < 0 && b < 0) return;
  if (b < 0 || (d >= 0 && d < b)) return { at: d, token: "$$", close: "$$" };
  return { at: b, token: "\\[", close: "\\]" };
}

// Longest prefix ending at a space where no inline math / code / bold span is left open.
function safePrefix(s: string): string {
  const stop = Math.min(...["$$", "\\["].map((tok) => (s.includes(tok) ? s.indexOf(tok) : s.length)));
  let inMath = false, inCode = false, bold = false, cut = 0;
  for (let i = 0; i < stop; i++) {
    const c = s[i];
    if (c === "\\" && inMath) { i++; continue; }
    if (c === "`" && !inMath) inCode = !inCode;
    else if (c === "$" && !inCode) inMath = !inMath;
    else if (c === "*" && s[i + 1] === "*" && !inMath && !inCode) { bold = !bold; i++; }
    else if (c === " " && !inMath && !inCode && !bold) cut = i;
  }
  return s.slice(0, cut);
}

function formatBlock(line: string, math: (tex: string) => string): Block | undefined {
  if (!line.trim()) return;
  const pad = " ".repeat(INDENT);
  let m: RegExpMatchArray | null;

  if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
    return { first: pad, rest: pad, body: t.bold + t.heading + inline(m[2], math) + t.reset, wrap: true };
  }
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
    return { first: pad, rest: pad, body: t.dim + "─".repeat(24) + t.reset, wrap: false };
  }
  if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
    const level = Math.floor(m[1].length / 2);
    const lead = pad + "  ".repeat(level);
    const mark = level === 0 ? "•" : "◦";
    return { first: `${lead}${t.bullet}${mark}${t.reset} `, rest: lead + "  ", body: inline(m[2], math), wrap: true };
  }
  if ((m = line.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
    const level = Math.floor(m[1].length / 2);
    const lead = pad + "  ".repeat(level);
    return { first: `${lead}${t.bullet}${m[2]}${t.reset} `, rest: lead + " ".repeat(m[2].length + 1), body: inline(m[3], math), wrap: true };
  }
  if ((m = line.match(/^\s*>\s?(.*)$/))) {
    const bar = `${pad}${t.quote}│${t.reset} `;
    return { first: bar, rest: bar, body: t.quote + inline(m[1], math), wrap: true };
  }
  if (/^\s*\|/.test(line)) {
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return { first: pad, rest: pad, body: t.dim + line.trim() + t.reset, wrap: false };
    return { first: pad, rest: pad, body: inline(line.trim(), math), wrap: false };
  }
  return { first: pad, rest: pad, body: inline(line.trim(), math), wrap: true };
}

// Inline markdown + math. Math and code are swapped for placeholders first so * and _ inside them survive.
// Pandoc's rule: no space just inside either $, and the closing $ isn't followed by a digit ("$5 and $10").
const INLINE_MATH = /\$(?!\s)((?:\\\$|[^$])+?)(?<!\s)\$(?!\d)|\\\((.+?)\\\)/g;

function inline(s: string, math: (tex: string) => string): string {
  const held: string[] = [];
  const hold = (x: string) => `\u0000${held.push(x) - 1}\u0000`;
  s = s.replace(/`([^`]+)`/g, (_m, code) => hold(t.code + code + t.reset));
  s = s.replace(INLINE_MATH, (_m, a, b) => hold(math(a ?? b)));
  s = s.replace(/\*\*(.+?)\*\*/g, `${t.bold}$1\x1b[22m`);
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, `$1${t.italic}$2\x1b[23m`);
  s = s.replace(/(^|\W)_(?!\s)(.+?)_(?!\w)/g, `$1${t.italic}$2\x1b[23m`);
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)]);
}

// Greedy word wrap that keeps SGR styling alive across line breaks.
function wrapStyled(s: string, firstWidth: number, restWidth: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let line = "";
  let width = firstWidth;
  for (const word of words) {
    const len = visibleLen(line), wl = visibleLen(word);
    if (line && len + 1 + wl > width) {
      lines.push(line);
      line = activeStyle(lines.join(" ")) + word;
      width = restWidth;
    } else {
      line += (line ? " " : "") + word;
    }
  }
  lines.push(line);
  return lines.map((l) => l + t.reset);
}

// The SGR state in effect at the end of `s` (bold / italic / foreground colour), as an escape string.
function activeStyle(s: string): string {
  let bold = false, italic = false, color = "";
  for (const m of s.matchAll(/\x1b\[([\d;]*)m/g)) {
    const p = m[1];
    if (p === "0" || p === "") { bold = italic = false; color = ""; }
    else if (p === "1") bold = true;
    else if (p === "22") bold = false;
    else if (p === "3") italic = true;
    else if (p === "23") italic = false;
    else if (p.startsWith("38;")) color = m[0];
    else if (p === "39") color = "";
  }
  return (bold ? t.bold : "") + (italic ? t.italic : "") + color;
}
