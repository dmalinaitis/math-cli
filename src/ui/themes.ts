// Theme definitions. Built-ins below; custom themes are JSON files in ~/.mathcli/themes/<name>.json
// holding any subset of ThemeDef fields plus an optional "base" (a theme to inherit from).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "../config.js";

export interface ThemeDef {
  // Terminal window (applied through the WezTerm bridge)
  background: string;
  gradient?: string[]; // vertical background gradient, top → bottom; replaces the flat background
  foreground: string;
  titlebar: string;
  cursor: string;
  selection: string;
  // App
  panel: string; // prompt box background
  accent: string; // prompt chevron, spinner
  heading: string;
  bullet: string;
  code: string;
  codeBlock: string;
  quote: string;
  error: string;
  thinking: string;
  attach: string;
  statusModel: string;
  statusPath: string;
  dim: string; // separators, hints
  displayMath: string; // typeset equation colour
  inlineMath: string; // inline maths (text and images)
}

export const BUILTIN_THEMES: Record<string, ThemeDef> = {
  // Glossy dark royal purple, sampled from the Codex screenshot (#100d1e base, #2c2a38 panels).
  royal: {
    background: "#100d1e",
    gradient: ["#1a1433", "#110e22", "#0b0916"],
    foreground: "#ecebf3",
    titlebar: "#151127",
    cursor: "#e6c8b0",
    selection: "#3a3358",
    panel: "#2c2a38",
    accent: "#e6c8b0",
    heading: "#c9b6ff",
    bullet: "#a9a8b4",
    code: "#e7b3d6",
    codeBlock: "#cfcde0",
    quote: "#a3a2b8",
    error: "#ef8a8a",
    thinking: "#7d7896",
    attach: "#9fc9ef",
    statusModel: "#fff7db",
    statusPath: "#c8e4cd",
    dim: "#a3a2aa",
    displayMath: "#f6f4fc",
    inlineMath: "#ddd5ff",
  },
  // The original Math CLI look: cool slate blue.
  midnight: {
    background: "#16161e",
    foreground: "#e6e6f0",
    titlebar: "#16161e",
    cursor: "#e6e6f0",
    selection: "#33334a",
    panel: "#2a2a3a",
    accent: "#f0b450",
    heading: "#f0b450",
    bullet: "#8a8aa8",
    code: "#e8a0c8",
    codeBlock: "#c8c8e0",
    quote: "#9a9ab8",
    error: "#e67878",
    thinking: "#7a7a96",
    attach: "#80c8e8",
    statusModel: "#96d296",
    statusPath: "#96d296",
    dim: "#8a8aa0",
    displayMath: "#e6e6f0",
    inlineMath: "#c0d0ff",
  },
  // Light, near-monochrome greys, sampled from Grok CLI (#eeeeee base, #d6d6d6 panels).
  white: {
    background: "#eeeeee",
    foreground: "#1e1e1e",
    titlebar: "#e4e4e4",
    cursor: "#1e1e1e",
    selection: "#c9c9d2",
    panel: "#d6d6d6",
    accent: "#3a3a3a",
    heading: "#1e1e1e",
    bullet: "#6a6a6a",
    code: "#7a3e65",
    codeBlock: "#2e2e36",
    quote: "#5f5f5f",
    error: "#b23b3b",
    thinking: "#8a8a8a",
    attach: "#2f6690",
    statusModel: "#5c5c5c",
    statusPath: "#5c5c5c",
    dim: "#6a6a6a",
    displayMath: "#1a1a1a",
    inlineMath: "#232323",
  },
  // Matches the Catppuccin Mocha WezTerm config.
  mocha: {
    background: "#181825",
    foreground: "#cdd6f4",
    titlebar: "#181825",
    cursor: "#f5e0dc",
    selection: "#3a3a52",
    panel: "#313244",
    accent: "#fab387",
    heading: "#cba6f7",
    bullet: "#7f849c",
    code: "#f5c2e7",
    codeBlock: "#bac2de",
    quote: "#9399b2",
    error: "#f38ba8",
    thinking: "#6c7086",
    attach: "#89dceb",
    statusModel: "#f9e2af",
    statusPath: "#a6e3a1",
    dim: "#7f849c",
    displayMath: "#cdd6f4",
    inlineMath: "#b4befe",
  },
};

const USER_THEME_DIR = join(CONFIG_DIR, "themes");

export function listThemes(): string[] {
  const user = existsSync(USER_THEME_DIR)
    ? readdirSync(USER_THEME_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
    : [];
  return [...new Set([...Object.keys(BUILTIN_THEMES), ...user])];
}

export function resolveTheme(name: string, seen = new Set<string>()): ThemeDef | undefined {
  const file = join(USER_THEME_DIR, `${name}.json`);
  if (existsSync(file) && !seen.has(name)) {
    seen.add(name);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ThemeDef> & { base?: string };
    const base = resolveTheme(raw.base ?? "royal", seen) ?? BUILTIN_THEMES.royal;
    const { base: _b, ...fields } = raw;
    return { ...base, ...fields };
  }
  return BUILTIN_THEMES[name];
}
