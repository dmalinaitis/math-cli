// The active UI colours as ready-to-print escape codes. Mutated in place by applyTheme(), so every
// module that reads `theme.x` at print time picks up a /theme switch immediately.
import { BUILTIN_THEMES, type ThemeDef } from "./themes.js";

const fg = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const bg = (hex: string) => fg(hex).replace("[38;", "[48;");

function build(d: ThemeDef) {
  return {
    def: d,
    panelBg: bg(d.panel),
    accent: fg(d.accent),
    statusModel: fg(d.statusModel),
    statusPath: fg(d.statusPath),
    muted: fg(d.dim),
    heading: fg(d.heading),
    bullet: fg(d.bullet),
    code: fg(d.code),
    codeBlock: fg(d.codeBlock),
    inlineMath: fg(d.inlineMath),
    quote: fg(d.quote),
    error: fg(d.error),
    thinking: fg(d.thinking),
    attach: fg(d.attach),
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    italic: "\x1b[3m",
    reset: "\x1b[0m",
  };
}

export const theme = build(BUILTIN_THEMES.royal);

export function applyTheme(d: ThemeDef) {
  Object.assign(theme, build(d));
}

export { visibleLen } from "./text.js";
