// Ask the terminal what it can do: cell size in pixels, fg/bg colours, graphics protocol.
// Replies arrive on stdin, so we briefly switch to raw mode. On Windows, ConPTY forwards the
// pixel-size replies (CSI 14t/16t) but swallows DA1 and OSC 10/11, so we stop as soon as the
// size reply lands and otherwise rely on a timeout — never on DA1 as a sentinel.
import { execFileSync } from "node:child_process";
import { onInput } from "./keys.js";

export type GraphicsProtocol = "iterm2" | "kitty" | "none";

export interface TermCaps {
  cellW: number;
  cellH: number;
  cols: number;
  fg: string;
  bg: string;
  graphics: GraphicsProtocol;
  measured: "escape" | "wezterm-cli" | "env" | false; // false = cell size is a guess
}

function rgbFromOsc(s: string): string | undefined {
  const m = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(s);
  if (!m) return;
  const to8 = (h: string) => Math.round((parseInt(h, 16) / (16 ** h.length - 1)) * 255).toString(16).padStart(2, "0");
  return `#${to8(m[1])}${to8(m[2])}${to8(m[3])}`;
}

function detectGraphics(): GraphicsProtocol {
  const env = process.env;
  if (env.MATHCLI_GRAPHICS) return env.MATHCLI_GRAPHICS as GraphicsProtocol;
  if (env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "iTerm.app") return "iterm2";
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "ghostty") return "kitty";
  return "none";
}

function queryEscapes(timeoutMs: number, needColors: boolean): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    let finished = false;
    let colorTimer: NodeJS.Timeout | undefined;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(colorTimer);
      stop();
      resolve(buf);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const haveSize = /\x1b\[6;\d+;\d+t/.test(buf) || /\x1b\[4;\d+;\d+t/.test(buf);
      if (!haveSize) return;
      if (!needColors) return done();
      if (/\x1b\]11;[^\x07\x1b]*/.test(buf)) return done();
      // Give colour replies a moment, if the terminal sends them (ConPTY swallows OSC 10/11).
      colorTimer ??= setTimeout(done, 60);
    };
    const timer = setTimeout(done, timeoutMs);
    const stop = onInput(onData);
    process.stdout.write("\x1b[16t\x1b[14t" + (needColors ? "\x1b]10;?\x1b\\\x1b]11;?\x1b\\" : ""));
  });
}

const positive = (n: number) => Number.isFinite(n) && n > 0;

// WezTerm can report the pane's pixel size over its CLI even when escapes are filtered.
function weztermCellSize(): { w: number; h: number } | undefined {
  const pane = process.env.WEZTERM_PANE;
  const gui = process.env.WEZTERM_EXECUTABLE;
  if (pane === undefined || !gui) return;
  try {
    const exe = gui.replace(/wezterm-gui(\.exe)?$/i, (_m, ext) => `wezterm${ext ?? ""}`);
    const out = execFileSync(exe, ["cli", "list", "--format", "json"], { timeout: 500, windowsHide: true });
    const panes = JSON.parse(out.toString());
    const s = panes.find((p: any) => String(p.pane_id) === pane)?.size;
    if (!s?.cols || !s.rows) return;
    const w = s.pixel_width / s.cols;
    const h = s.pixel_height / s.rows;
    if (positive(w) && positive(h)) return { w, h };
  } catch {
    return;
  }
}

export interface QueryOptions {
  timeoutMs?: number;
  needColors?: boolean; // also ask for OSC 10/11 fg/bg colours (slower on terminals that drop them)
}

export async function queryTerminal(opts: number | QueryOptions = {}): Promise<TermCaps> {
  const { timeoutMs = 350, needColors = false } = typeof opts === "number" ? { timeoutMs: opts } : opts;
  const env = process.env;
  const caps: TermCaps = {
    cellW: 9,
    cellH: 19,
    cols: process.stdout.columns || 100,
    fg: "#e6e6f0",
    bg: "#16161e",
    graphics: detectGraphics(),
    measured: false,
  };
  const envW = Number(env.MATHCLI_CELL_W);
  const envH = Number(env.MATHCLI_CELL_H);
  if (env.MATHCLI_CELL_W && env.MATHCLI_CELL_H && positive(envW) && positive(envH)) {
    caps.cellW = envW;
    caps.cellH = envH;
    caps.measured = "env";
    if (!needColors) return caps; // nothing left to ask the terminal
  }
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return caps;

  const reply = await queryEscapes(timeoutMs, needColors);
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  const area = /\x1b\[4;(\d+);(\d+)t/.exec(reply);
  if (!caps.measured && cell && positive(Number(cell[1])) && positive(Number(cell[2]))) {
    caps.cellH = Number(cell[1]);
    caps.cellW = Number(cell[2]);
    caps.measured = "escape";
  } else if (!caps.measured && area && stdout.rows && stdout.columns) {
    const h = Number(area[1]) / stdout.rows;
    const w = Number(area[2]) / stdout.columns;
    if (positive(w) && positive(h)) {
      caps.cellH = h;
      caps.cellW = w;
      caps.measured = "escape";
    }
  }
  if (!caps.measured) {
    const wz = weztermCellSize();
    if (wz) {
      caps.cellW = wz.w;
      caps.cellH = wz.h;
      caps.measured = "wezterm-cli";
    }
  }
  if (needColors) {
    const fg = /\x1b\]10;([^\x07\x1b]*)/.exec(reply);
    const bg = /\x1b\]11;([^\x07\x1b]*)/.exec(reply);
    caps.fg = (fg && rgbFromOsc(fg[1])) || caps.fg;
    caps.bg = (bg && rgbFromOsc(bg[1])) || caps.bg;
  }
  return caps;
}
