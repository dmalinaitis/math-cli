// Theme the WezTerm window mathcli runs in: background/gradient, opacity, acrylic blur.
//
// A terminal app can't change its window's background or transparency itself, so we send the theme
// as a WezTerm user var (OSC 1337 SetUserVar) and a small Lua handler (scripts/wezterm-mathcli.lua)
// applies it to this window only. The overrides are cleared when mathcli exits.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../config.js";
import type { ThemeDef } from "../ui/themes.js";

const BRIDGE_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "wezterm-mathcli.lua");
const BRIDGE_DEST = join(CONFIG_DIR, "wezterm.lua");
const LOADER = `pcall(dofile, wezterm.home_dir .. "/.mathcli/wezterm.lua") -- Math CLI: lets mathcli theme its own window`;

export const inWezTerm = () => process.env.TERM_PROGRAM === "WezTerm";

function setUserVar(value: string) {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  // Synchronous: this also runs from the process 'exit' handler, where async TTY writes are dropped on Windows.
  try {
    writeSync(1, `\x1b]1337;SetUserVar=MATHCLI_THEME=${b64}\x07`);
  } catch {
    // terminal already gone (window closed) — nothing to reset
  }
}

export function sendTerminalTheme(d: ThemeDef, opacity: number, blur: boolean) {
  if (!inWezTerm()) return;
  setUserVar(
    JSON.stringify({
      background: d.background,
      gradient: d.gradient,
      foreground: d.foreground,
      titlebar: d.titlebar,
      cursor: d.cursor,
      selection: d.selection,
      dim: d.dim,
      opacity,
      blur,
    }),
  );
}

export function clearTerminalTheme() {
  if (inWezTerm()) setUserVar("");
}

// The user's WezTerm config file, if any (same lookup order as WezTerm).
function weztermConfigFile(): string | undefined {
  const candidates = [
    process.env.WEZTERM_CONFIG_FILE,
    join(homedir(), ".wezterm.lua"),
    join(homedir(), ".config", "wezterm", "wezterm.lua"),
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

// Keep ~/.mathcli/wezterm.lua in sync with the repo copy; report whether the user's config loads it.
export function bridgeStatus(): "enabled" | "not-enabled" | "no-config" {
  if (existsSync(BRIDGE_SRC)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    const src = readFileSync(BRIDGE_SRC, "utf8");
    if (!existsSync(BRIDGE_DEST) || readFileSync(BRIDGE_DEST, "utf8") !== src) writeFileSync(BRIDGE_DEST, src);
  }
  const cfg = weztermConfigFile();
  if (!cfg) return "no-config";
  return readFileSync(cfg, "utf8").includes(".mathcli/wezterm.lua") ? "enabled" : "not-enabled";
}

// Add the one-line loader to the user's WezTerm config (backing it up first), or create a minimal config.
export function enableBridge(): string {
  bridgeStatus(); // make sure the module file exists
  const cfg = weztermConfigFile();
  if (!cfg) {
    const file = join(homedir(), ".wezterm.lua");
    writeFileSync(file, `local wezterm = require("wezterm")\nlocal config = wezterm.config_builder()\n${LOADER}\nreturn config\n`);
    return `Created ${file}.`;
  }
  const text = readFileSync(cfg, "utf8");
  if (text.includes(".mathcli/wezterm.lua")) return `Already enabled in ${cfg}.`;
  copyFileSync(cfg, `${cfg}.bak`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = /\n\s*return\s+config\s*$/.exec(text.trimEnd());
  const next = m
    ? text.trimEnd().slice(0, m.index) + `${eol}${eol}${LOADER}${eol}return config${eol}`
    : text.trimEnd() + `${eol}${eol}-- Math CLI${eol}local wezterm = require("wezterm")${eol}${LOADER}${eol}`;
  writeFileSync(cfg, next);
  return `Added the Math CLI loader to ${cfg} (backup: ${cfg}.bak).`;
}
