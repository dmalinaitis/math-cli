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

function queryEscapes(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve(buf);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("latin1");
      const haveSize = /\x1b\[6;\d+;\d+t/.test(buf);
      const haveColours = /\x1b\]11;[^\x07\x1b]*/.test(buf);
      if (haveSize && haveColours) done();
      else if (haveSize) setTimeout(done, 60); // give colour replies a moment, if the terminal sends them
    };
    const timer = setTimeout(done, timeoutMs);
    const stop = onInput(onData);
    process.stdout.write("\x1b[16t\x1b[14t\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
  });
}

// WezTerm can report the pane's pixel size over its CLI even when escapes are filtered.
function weztermCellSize(): { w: number; h: number } | undefined {
  const pane = process.env.WEZTERM_PANE;
  const gui = process.env.WEZTERM_EXECUTABLE;
  if (pane === undefined || !gui) return;
  try {
    const exe = gui.replace(/wezterm-gui(\.exe)?$/i, (_m, ext) => `wezterm${ext ?? ""}`);
    const panes = JSON.parse(execFileSync(exe, ["cli", "list", "--format", "json"], { timeout: 1500 }).toString());
    const s = panes.find((p: any) => String(p.pane_id) === pane)?.size;
    if (s?.pixel_width && s.cols) return { w: s.pixel_width / s.cols, h: s.pixel_height / s.rows };
  } catch {
    return;
  }
}

export async function queryTerminal(timeoutMs = 1000): Promise<TermCaps> {
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
  if (env.MATHCLI_CELL_W && env.MATHCLI_CELL_H) {
    caps.cellW = Number(env.MATHCLI_CELL_W);
    caps.cellH = Number(env.MATHCLI_CELL_H);
    caps.measured = "env";
  }
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return caps;

  const reply = await queryEscapes(timeoutMs);
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  const area = /\x1b\[4;(\d+);(\d+)t/.exec(reply);
  if (!caps.measured && cell) {
    caps.cellH = Number(cell[1]);
    caps.cellW = Number(cell[2]);
    caps.measured = "escape";
  } else if (!caps.measured && area && stdout.rows && stdout.columns) {
    caps.cellH = Number(area[1]) / stdout.rows;
    caps.cellW = Number(area[2]) / stdout.columns;
    caps.measured = "escape";
  }
  if (!caps.measured) {
    const wz = weztermCellSize();
    if (wz) {
      caps.cellW = wz.w;
      caps.cellH = wz.h;
      caps.measured = "wezterm-cli";
    }
  }
  const fg = /\x1b\]10;([^\x07\x1b]*)/.exec(reply);
  const bg = /\x1b\]11;([^\x07\x1b]*)/.exec(reply);
  caps.fg = (fg && rgbFromOsc(fg[1])) || caps.fg;
  caps.bg = (bg && rgbFromOsc(bg[1])) || caps.bg;
  return caps;
}
