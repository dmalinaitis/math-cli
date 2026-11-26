// Math CLI — chat with Claude or a local model about maths, with LaTeX typeset in the terminal.
import { writeSync } from "node:fs";
import { CONFIG_FILE, EFFORTS, INLINE_MODES, MODELS, loadConfig, resolveApiKey, saveConfig, type Effort, type InlineMode } from "./config.js";
import { queryTerminal } from "./term/caps.js";
import { writeClipboard } from "./term/clipboard.js";
import { bridgeStatus, clearTerminalTheme, enableBridge, inWezTerm, sendTerminalTheme } from "./term/wezterm.js";
import { listThemes, resolveTheme } from "./ui/themes.js";
import { onInput } from "./term/keys.js";
import { termCols } from "./term/size.js";
import { ClaudeBackend, classifyClaudeError } from "./llm/claude.js";
import { LOCAL_ON_EXIT, LocalAuthError, LocalBackend, LocalServerDown, LocalTimeout, type LocalOnExit } from "./llm/local.js";
import { Session } from "./llm/session.js";
import { isLocalModel, localModelId } from "./llm/types.js";
import { AttachmentError, extractRefs, isAttachablePath, loadAttachment, unquotePath, type Attachment } from "./llm/attachments.js";
import { prompt, promptRecord, type SlashCommand } from "./ui/input.js";
import { select, type SelectEntry } from "./ui/select.js";
import { StreamRenderer } from "./ui/markdown.js";
import { clearRenderCache } from "./math/render.js";
import { clearImagePlaceholders } from "./ui/text.js";
import { applyTheme, theme as t, visibleLen } from "./ui/theme.js";

const out = (s = "") => process.stdout.write(s + "\n");
const note = (s: string) => out(`  ${t.dim}${s}${t.reset}`);
const error = (s: string) => out(`  ${t.error}${s}${t.reset}`);
// Synchronous: an async stdout write at exit can be dropped (notably on Windows).
process.on("exit", () => {
  try { writeSync(1, "\x1b[?25h\x1b[?2004l"); } catch { /* ignore */ }
});

let cfg = loadConfig();
const caps = await queryTerminal();

// Theme: app colours + (in WezTerm, via the bridge) window background, opacity and blur.
function useTheme(name: string): boolean {
  const def = resolveTheme(name);
  if (!def) return false;
  applyTheme(def);
  sendTerminalTheme(def, cfg.opacity, cfg.blur);
  return true;
}
if (!useTheme(cfg.theme)) useTheme("royal");
process.on("exit", clearTerminalTheme);
const history: string[] = [];
let pending: Attachment[] = [];
let lastAnswer = "";

// Everything shown for each question, so the screen can be rebuilt (e.g. in a new theme).
interface Shown {
  prompt: string;
  files: string[];
  answer: string;
  notes: { text: string; error?: boolean }[];
}
const transcript: Shown[] = [];

function newRenderer() {
  return new StreamRenderer({
    caps,
    mathScale: cfg.mathScale,
    inlineMath: cfg.inlineMath,
    width: termCols,
    write: (s) => process.stdout.write(s),
  });
}

// Clear the screen and scrollback, then re-render the conversation with the current theme/settings.
function redraw() {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  banner();
  for (const turn of transcript) {
    process.stdout.write(promptRecord(turn.prompt));
    if (turn.files.length) note(`with ${turn.files.join(", ")}`);
    if (turn.answer) {
      const r = newRenderer();
      r.push(turn.answer);
      r.end();
    }
    for (const n of turn.notes) (n.error ? error : note)(n.text);
    out();
  }
}
let lastDisplayMath: string[] = [];

const shortModel = (m: string) => Object.entries(MODELS).find(([, id]) => id === m)?.[0] ?? m;
const cwd = () => process.cwd().replace(process.env.USERPROFILE ?? process.env.HOME ?? "\0", "~");

const tokens = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`);
const modelLabel = () => (isLocalModel(cfg.model) ? `${localModelId(cfg.model)} (local)` : `${cfg.model} ${cfg.effort}`);

// Context meter, e.g. "12K / 33K": how much of the model's context window the conversation fills.
function meter(convo: Session): string | undefined {
  const window = convo.windowFor(cfg.model) ?? convo.contextWindow;
  if (!window) return;
  const used = convo.contextTokens;
  const colour = used / window > 0.8 ? t.error : t.muted;
  return `${colour}${tokens(used)} / ${tokens(window)}${t.reset}`;
}

function status(convo?: Session): string {
  const parts = [`${t.statusModel}${modelLabel()}${t.reset}`];
  const m = convo && meter(convo);
  if (m) parts.push(m);
  parts.push(`${t.statusPath}${cwd()}${t.reset}`);
  if (convo && convo.costUsd > 0) parts.push(`${t.dim}~$${convo.costUsd.toFixed(convo.costUsd < 1 ? 3 : 2)}${t.reset}`);
  if (!caps.measured) parts.push(`${t.dim}(cell size guessed)${t.reset}`);
  return parts.join(` ${t.muted}·${t.reset} `);
}

function attachmentChips(): string[] {
  if (!pending.length) return [];
  const chips = pending.map((a) => `${t.attach}⎘ ${a.name}${t.reset}${t.dim} ${(a.bytes / 1024).toFixed(0)} KB${t.reset}`);
  return [`  ${chips.join("   ")}   ${t.dim}(/detach to remove)${t.reset}`];
}

function attach(paths: string[]): boolean {
  let ok = true;
  for (const p of paths) {
    try {
      const a = loadAttachment(p);
      if (!pending.some((x) => x.path === a.path)) pending.push(a);
    } catch (e) {
      ok = false;
      error(e instanceof AttachmentError ? e.message : String(e));
    }
  }
  return ok;
}

// Dropping files onto WezTerm pastes their paths; treat a paste made only of attachable paths as attachments.
function onPaste(text: string): boolean {
  const tokens = text.trim().match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  if (!tokens.length || !tokens.every(isAttachablePath)) return false;
  for (const tok of tokens) {
    try {
      const a = loadAttachment(unquotePath(tok));
      if (!pending.some((x) => x.path === a.path)) pending.push(a);
    } catch {
      return false;
    }
  }
  return true;
}

// ---- API key -------------------------------------------------------------------------------------

// Undefined if the user skips (empty Enter) or cancels (Ctrl+C) — local models work without a key.
async function askForKey(reason: string): Promise<string | undefined> {
  out();
  out(`  ${t.bold}${reason}${t.reset}`);
  note("Create a key at https://console.anthropic.com/settings/keys and paste it below.");
  note(`It is saved to ${CONFIG_FILE}. Alternatively set the ANTHROPIC_API_KEY environment variable.`);
  out();
  for (;;) {
    const res = await prompt({ mask: true, placeholder: "Paste your API key (Ctrl+V or Ctrl+Shift+V)", status: () => `${t.dim}Enter to save · Enter on empty to skip · Ctrl+C to cancel${t.reset}` });
    const key = res.kind === "exit" ? "" : res.text.trim();
    if (!key) {
      note("No key saved — /key adds one later; /model local uses LM Studio instead.");
      out();
      return undefined;
    }
    try {
      await ClaudeBackend.verifyKey(key, isLocalModel(cfg.model) ? MODELS.opus : cfg.model);
      cfg = saveConfig({ anthropicApiKey: key });
      note("Key verified and saved.");
      out();
      return key;
    } catch (e) {
      const kind = classifyClaudeError(e)?.kind;
      if (kind === "auth" || kind === "permission") {
        error("That key was rejected by the API — check it and try again.");
        continue;
      }
      cfg = saveConfig({ anthropicApiKey: key });
      error(`Couldn't verify the key (${e instanceof Error ? e.message : e}); saved it anyway.`);
      out();
      return key;
    }
  }
}

// ---- commands ------------------------------------------------------------------------------------

const COMMANDS: SlashCommand[] = [
  { name: "/model", usage: "[name]", description: "switch Claude or LM Studio model (arrows, ←/→ effort)" },
  { name: "/theme", usage: "[name]", description: "switch theme with live preview" },
  { name: "/effort", usage: "[low…max]", description: "how hard Claude thinks (default high)" },
  { name: "/inline", usage: "[mode]", description: "inline maths: auto, image, or unicode" },
  { name: "/scale", usage: "[0.8–3]", description: "display-math size relative to text (default 1.5)" },
  { name: "/opacity", usage: "[0.3–1]", description: "window transparency in WezTerm (1 = opaque)" },
  { name: "/blur", usage: "[on|off]", description: "acrylic blur behind a translucent window" },
  { name: "/thinking", description: "toggle showing Claude's summarised reasoning" },
  { name: "/local-exit", usage: "[mode]", description: "what to unload/stop in LM Studio on exit" },
  { name: "/attach", usage: "<file…>", description: "attach images, PDFs or .tex/.txt files (or @file / drag-drop)", hasArgs: true },
  { name: "/detach", description: "remove pending attachments" },
  { name: "/copy", description: "copy the last answer (markdown + LaTeX) to the clipboard" },
  { name: "/copy-latex", description: "copy just the display equations from the last answer" },
  { name: "/redraw", description: "re-render the conversation (e.g. after resizing)" },
  { name: "/clear", description: "start a new conversation" },
  { name: "/setup-terminal", description: "let mathcli theme its WezTerm window (.wezterm.lua)" },
  { name: "/key", description: "replace the saved Anthropic API key" },
  { name: "/help", description: "show commands and keyboard shortcuts" },
  { name: "/exit", description: "quit (or Ctrl+C on an empty prompt)" },
];

const MODEL_DESCRIPTIONS: Record<string, string> = {
  opus: "Best for hard proofs and multi-step derivations",
  sonnet: "Fast and strong for everyday maths",
  fable: "Deepest reasoning for tough challenges",
  haiku: "Fastest for quick checks and definitions",
};

const EFFORT_DESCRIPTIONS: Record<Effort, string> = {
  low: "Fastest, minimal reasoning",
  medium: "Balanced speed and depth",
  high: "Default — thorough derivations",
  xhigh: "Extra reasoning for tricky problems",
  max: "Maximum reasoning budget",
};

const INLINE_DESCRIPTIONS: Record<InlineMode, string> = {
  auto: "Exact Unicode when possible, typeset image otherwise",
  image: "Always typeset inline maths as one-row images",
  unicode: "Unicode text only (no inline images)",
};

const LOCAL_EXIT_DESCRIPTIONS: Record<LocalOnExit, string> = {
  auto: "Unload models we loaded; stop server / quit LM Studio only if we started them",
  always: "Unload all models, stop the server and quit LM Studio",
  keep: "Leave LM Studio and loaded models running (faster to resume)",
};

function themeSwatch(name: string): string {
  const d = resolveTheme(name);
  if (!d) return "";
  return [d.background, d.panel, d.accent, d.heading, d.inlineMath]
    .map((h) => `\x1b[48;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m  `)
    .join("") + t.reset;
}

async function command(line: string, convo: Session): Promise<"exit" | void> {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  const arg = args.join(" ").trim();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  switch (cmd.toLowerCase()) {
    case "help": case "?":
      for (const c of COMMANDS) {
        const label = c.usage ? `${c.name} ${c.usage}` : c.name;
        out(`  ${t.accent}${label.padEnd(28)}${t.reset}${t.dim}${c.description}${t.reset}`);
      }
      note("Type / to autocomplete commands · Enter sends · Ctrl+J or \\ + Enter for newline · ↑/↓ history · Ctrl+C stops");
      break;
    case "attach": case "a": {
      const paths = arg.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
      if (!paths.length) { note("usage: /attach <file> [more files…]"); break; }
      attach(paths);
      break;
    }
    case "detach": pending = []; note("Attachments cleared."); break;
    case "model": case "m": {
      const a = arg.toLowerCase();
      // Claude models switch at once, without touching (or launching) LM Studio.
      const claudeId = MODELS[a] ?? (a.startsWith("claude-") ? arg : undefined);
      if (claudeId) {
        cfg = saveConfig({ model: claudeId });
        note(`Model: ${claudeId}${convo.turns.length ? " — the conversation so far carries over" : ""}`);
        if (!convo.claude.hasKey) note("No Anthropic API key yet — add one with /key.");
        break;
      }
      if (!arg && interactive) {
        process.stdout.write(`  ${t.dim}Checking LM Studio…${t.reset}`);
        const locals = await localModels(convo);
        process.stdout.write("\r\x1b[2K");
        const entries: SelectEntry<string>[] = [{ kind: "header", label: "Claude" }];
        for (const [alias, id] of Object.entries(MODELS)) {
          entries.push({
            value: id,
            label: `${alias.padEnd(7)} ${id}`,
            description: MODEL_DESCRIPTIONS[alias],
            current: id === cfg.model,
          });
        }
        entries.push({ kind: "header", label: "Local (LM Studio)" });
        if (localError) entries.push({ kind: "note", text: localError });
        else if (!locals) entries.push({ kind: "note", text: "LM Studio isn't running — start it, or run: lms server start" });
        else if (!locals.length) entries.push({ kind: "note", text: "no models installed — download one in LM Studio" });
        for (const m of locals ?? []) {
          const tags = [m.vision ? "vision" : "", `${tokens(m.contextLength)} ctx`, m.loaded ? "loaded" : ""].filter(Boolean).join(", ");
          entries.push({
            value: `local:${m.id}`,
            label: m.id,
            description: `${tags}${m.id === cfg.localModel ? " · default local" : ""}`,
            current: `local:${m.id}` === cfg.model,
          });
        }
        const picked = await select({
          title: "Select model",
          subtitle: "Switch mid-conversation — history carries over.",
          entries,
          initialValue: cfg.model,
          step: {
            values: EFFORTS,
            index: Math.max(0, EFFORTS.indexOf(cfg.effort)),
            format: (v) => `${t.bold}${v}${t.reset} ${t.dim}effort · ←/→ to adjust${t.reset}`,
            activeFor: (item) => !isLocalModel(item.value) && !item.value.startsWith("claude-haiku"),
          },
        });
        if (picked.kind === "cancel") break;
        const id = picked.value;
        const nextEffort = (picked.stepValue as Effort | undefined) ?? cfg.effort;
        const patch: Partial<typeof cfg> = isLocalModel(id)
          ? { model: id, localModel: localModelId(id) }
          : { model: id, effort: nextEffort };
        cfg = saveConfig(patch);
        const effortNote = !isLocalModel(id) && !id.startsWith("claude-haiku") ? ` (${cfg.effort} effort)` : "";
        note(`Model: ${id}${effortNote}${convo.turns.length ? " — the conversation so far carries over" : ""}`);
        if (isLocalModel(id) && !locals?.find((m) => `local:${m.id}` === id)?.loaded) note("It will load on the first message (a few seconds).");
        if (!isLocalModel(id) && !convo.claude.hasKey) note("No Anthropic API key yet — add one with /key.");
        break;
      }
      const locals = await localModels(convo);
      if (!arg) {
        const mark = (id: string) => (id === cfg.model ? t.accent + "›" : " ");
        out(`  ${t.bold}Claude${t.reset}`);
        for (const [alias, id] of Object.entries(MODELS)) out(`  ${mark(id)} ${alias.padEnd(8)}${t.reset}${t.dim}${id}${t.reset}`);
        out(`  ${t.bold}Local (LM Studio)${t.reset}`);
        if (localError) note(`  ${localError}`);
        else if (!locals) note("  LM Studio isn't running — start it, or run: lms server start");
        else if (!locals.length) note("  no models installed — download one in LM Studio");
        for (const m of locals ?? []) {
          const tags = [m.vision ? "vision" : "", `${tokens(m.contextLength)} ctx`, m.loaded ? "loaded" : ""].filter(Boolean).join(", ");
          out(`  ${mark(`local:${m.id}`)} ${m.id.padEnd(34)}${t.reset}${t.dim}${tags}${m.id === cfg.localModel ? " · default local" : ""}${t.reset}`);
        }
        note("/model <name> — e.g. /model sonnet, /model local, /model gemma");
        break;
      }
      const want = (a === "local" ? cfg.localModel : a.replace(/^local:/, "")).toLowerCase();
      const match = locals?.find((m) => m.id.toLowerCase() === want) ?? locals?.find((m) => m.id.toLowerCase().includes(want));
      if (!match) {
        if (localError) error(localError);
        else if (!locals) error("LM Studio isn't running — start it, or run: lms server start");
        else error(`unknown model "${arg}" — /model lists them`);
        break;
      }
      const id = `local:${match.id}`;
      cfg = saveConfig({ model: id, localModel: match.id });
      note(`Model: ${id}${convo.turns.length ? " — the conversation so far carries over" : ""}`);
      if (!match.loaded) note("It will load on the first message (a few seconds).");
      break;
    }
    case "effort": case "e": {
      if (!arg && interactive) {
        const picked = await select<Effort>({
          title: "Reasoning effort",
          subtitle: "How deeply Claude thinks before answering (ignored by Haiku and local models).",
          entries: EFFORTS.map((e) => ({ value: e, label: e, description: EFFORT_DESCRIPTIONS[e], current: e === cfg.effort })),
          initialValue: cfg.effort,
        });
        if (picked.kind === "cancel") break;
        cfg = saveConfig({ effort: picked.value });
        note(`Effort: ${picked.value}`);
        break;
      }
      if (!arg) { note(`Effort: ${cfg.effort}  (options: ${EFFORTS.join(", ")})`); break; }
      const val = arg.toLowerCase();
      if (!EFFORTS.includes(val as Effort)) { error(`effort must be one of ${EFFORTS.join(", ")}`); break; }
      cfg = saveConfig({ effort: val as Effort });
      note(`Effort: ${val}`);
      break;
    }
    case "thinking":
      cfg = saveConfig({ showThinking: !cfg.showThinking });
      note(`Show reasoning: ${cfg.showThinking ? "on" : "off"}`);
      break;
    case "theme": {
      if (!arg && interactive) {
        const names = listThemes();
        const prev = cfg.theme;
        const picked = await select<string>({
          title: "Select theme",
          subtitle: "Live preview — custom themes live in ~/.mathcli/themes/<name>.json.",
          entries: names.map((name) => ({ value: name, label: name, extra: themeSwatch(name), current: name === cfg.theme })),
          initialValue: cfg.theme,
          onHighlight: (item) => { useTheme(item.value); },
        });
        if (picked.kind === "cancel") {
          useTheme(prev);
          break;
        }
        useTheme(picked.value);
        cfg = saveConfig({ theme: picked.value });
        redraw(); // repaint earlier boxes and equations in the new colours
        note(`Theme: ${picked.value}`);
        break;
      }
      if (!arg) {
        for (const name of listThemes()) {
          out(`  ${name === cfg.theme ? t.accent + "›" : " "} ${name.padEnd(10)}${t.reset}${themeSwatch(name)}`);
        }
        note("Custom themes: ~/.mathcli/themes/<name>.json with any colour fields and an optional \"base\".");
        break;
      }
      if (!useTheme(arg)) { error(`unknown theme "${arg}" — /theme lists them`); break; }
      cfg = saveConfig({ theme: arg });
      redraw(); // repaint earlier boxes and equations in the new colours
      note(`Theme: ${arg}`);
      break;
    }
    case "opacity": {
      if (!arg && interactive) {
        const presets = [...new Set([1, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5, cfg.opacity])].sort((a, b) => b - a);
        const prev = cfg.opacity;
        const picked = await select<number>({
          title: "Window opacity",
          subtitle: "Live preview in WezTerm (requires /setup-terminal).",
          entries: presets.map((n) => ({
            value: n,
            label: n.toFixed(2),
            description: n === 1 ? "opaque" : n >= 0.85 ? "subtle translucency" : "glass",
            current: Math.abs(n - cfg.opacity) < 1e-6,
          })),
          initialValue: cfg.opacity,
          onHighlight: (item) => { sendTerminalTheme(t.def, item.value, cfg.blur); },
        });
        if (picked.kind === "cancel") {
          sendTerminalTheme(t.def, prev, cfg.blur);
          break;
        }
        cfg = saveConfig({ opacity: picked.value });
        sendTerminalTheme(t.def, cfg.opacity, cfg.blur);
        note(`Opacity: ${picked.value}${picked.value < 1 && cfg.blur ? " with acrylic blur" : ""}`);
        if (bridgeStatus() !== "enabled") note("Run /setup-terminal first so WezTerm applies it.");
        break;
      }
      if (!arg) { note(`Opacity: ${cfg.opacity}`); break; }
      const n = Number(arg);
      if (!(n >= 0.3 && n <= 1)) { error("opacity must be between 0.3 and 1"); break; }
      cfg = saveConfig({ opacity: n });
      sendTerminalTheme(t.def, cfg.opacity, cfg.blur);
      note(`Opacity: ${n}${n < 1 && cfg.blur ? " with acrylic blur" : ""}`);
      if (bridgeStatus() !== "enabled") note("Run /setup-terminal first so WezTerm applies it.");
      break;
    }
    case "blur": {
      if (!arg && interactive) {
        const prev = cfg.blur;
        const picked = await select<boolean>({
          title: "Acrylic blur",
          subtitle: "Windows 11 frosted backdrop behind translucent windows (/opacity < 1).",
          entries: [
            { value: true, label: "on", description: "enable acrylic blur", current: cfg.blur },
            { value: false, label: "off", description: "clear transparency only", current: !cfg.blur },
          ],
          initialValue: cfg.blur,
          onHighlight: (item) => { sendTerminalTheme(t.def, cfg.opacity, item.value); },
        });
        if (picked.kind === "cancel") {
          sendTerminalTheme(t.def, cfg.opacity, prev);
          break;
        }
        cfg = saveConfig({ blur: picked.value });
        sendTerminalTheme(t.def, cfg.opacity, cfg.blur);
        note(`Blur: ${cfg.blur ? "on" : "off"}${cfg.opacity >= 1 ? " (takes effect when /opacity is below 1)" : ""}`);
        break;
      }
      const val = arg.toLowerCase();
      if (arg && val !== "on" && val !== "off") { error("blur must be on or off"); break; }
      const on = arg ? val === "on" : !cfg.blur;
      cfg = saveConfig({ blur: on });
      sendTerminalTheme(t.def, cfg.opacity, cfg.blur);
      note(`Blur: ${on ? "on" : "off"}${cfg.opacity >= 1 ? " (takes effect when /opacity is below 1)" : ""}`);
      break;
    }
    case "setup-terminal":
      if (!inWezTerm()) { note("This only applies to WezTerm."); break; }
      note(enableBridge());
      note("WezTerm reloads its config automatically; the theme applies from the next change (or restart mathcli).");
      sendTerminalTheme(t.def, cfg.opacity, cfg.blur);
      break;
    case "local-exit": {
      if (!arg && interactive) {
        const picked = await select<LocalOnExit>({
          title: "Local model exit behaviour",
          subtitle: "What Math CLI frees in LM Studio when you quit or close the window.",
          entries: LOCAL_ON_EXIT.map((m) => ({ value: m, label: m, description: LOCAL_EXIT_DESCRIPTIONS[m], current: m === cfg.localOnExit })),
          initialValue: cfg.localOnExit,
        });
        if (picked.kind === "cancel") break;
        cfg = saveConfig({ localOnExit: picked.value });
        note(`On exit: ${picked.value} — ${LOCAL_EXIT_DESCRIPTIONS[picked.value]}`);
        break;
      }
      if (!arg) { note(`On exit: ${cfg.localOnExit} — ${LOCAL_EXIT_DESCRIPTIONS[cfg.localOnExit]}  (options: ${LOCAL_ON_EXIT.join(", ")})`); break; }
      const val = arg.toLowerCase();
      if (!LOCAL_ON_EXIT.includes(val as LocalOnExit)) { error(`must be one of ${LOCAL_ON_EXIT.join(", ")}`); break; }
      cfg = saveConfig({ localOnExit: val as LocalOnExit });
      note(`On exit: ${val} — ${LOCAL_EXIT_DESCRIPTIONS[val as LocalOnExit]}`);
      break;
    }
    case "inline": {
      if (!arg && interactive) {
        const picked = await select<InlineMode>({
          title: "Inline maths rendering",
          subtitle: "Controls how $…$ inside lines of prose is rendered.",
          entries: INLINE_MODES.map((m) => ({ value: m, label: m, description: INLINE_DESCRIPTIONS[m], current: m === cfg.inlineMath })),
          initialValue: cfg.inlineMath,
        });
        if (picked.kind === "cancel") break;
        cfg = saveConfig({ inlineMath: picked.value });
        redraw();
        note(`Inline maths: ${picked.value}`);
        break;
      }
      if (!arg) { note(`Inline maths: ${cfg.inlineMath}  (options: ${INLINE_MODES.join(", ")})`); break; }
      const val = arg.toLowerCase();
      if (!INLINE_MODES.includes(val as InlineMode)) { error(`inline mode must be one of ${INLINE_MODES.join(", ")}`); break; }
      cfg = saveConfig({ inlineMath: val as InlineMode });
      redraw();
      note(`Inline maths: ${val}`);
      break;
    }
    case "scale": {
      if (!arg && interactive) {
        const presets = [...new Set([1.0, 1.2, 1.4, 1.5, 1.7, 2.0, 2.5, cfg.mathScale])].sort((a, b) => a - b);
        const picked = await select<number>({
          title: "Display-math scale",
          subtitle: "Equation size relative to your terminal font (or run /scale <0.8–3>).",
          entries: presets.map((n) => ({
            value: n,
            label: `${n.toFixed(1)}×`,
            description: n === 1.5 ? "default" : n <= 1.2 ? "compact" : n >= 2.0 ? "large" : undefined,
            current: Math.abs(n - cfg.mathScale) < 1e-6,
          })),
          initialValue: cfg.mathScale,
        });
        if (picked.kind === "cancel") break;
        cfg = saveConfig({ mathScale: picked.value });
        redraw();
        note(`Display-math scale: ${picked.value}`);
        break;
      }
      if (!arg) { note(`Display-math scale: ${cfg.mathScale}  (0.8–3)`); break; }
      const n = Number(arg);
      if (!(n >= 0.8 && n <= 3)) { error("scale must be between 0.8 and 3"); break; }
      cfg = saveConfig({ mathScale: n });
      redraw();
      note(`Display-math scale: ${n}`);
      break;
    }
    case "copy":
      if (!lastAnswer) { note("Nothing to copy yet."); break; }
      note(writeClipboard(lastAnswer) ? "Copied the last answer." : "Couldn't access the clipboard.");
      break;
    case "copy-latex":
      if (!lastDisplayMath.length) { note("The last answer had no display equations."); break; }
      note(writeClipboard(lastDisplayMath.map((m) => `$$\n${m}\n$$`).join("\n\n")) ? `Copied ${lastDisplayMath.length} equation(s).` : "Couldn't access the clipboard.");
      break;
    case "redraw":
      redraw();
      break;
    case "clear": case "new":
      convo.reset();
      pending = [];
      lastAnswer = "";
      lastDisplayMath = [];
      transcript.length = 0;
      clearRenderCache();
      clearImagePlaceholders();
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      banner();
      break;
    case "key": {
      const key = await askForKey("Enter a new Anthropic API key.");
      if (key) convo.claude.setApiKey(key);
      break;
    }
    case "exit": case "quit": case "q":
      return "exit";
    default:
      error(`unknown command /${cmd} — try /help`);
  }
}

// ---- a turn --------------------------------------------------------------------------------------

// LM Studio's models, starting its server if needed (local installs only); undefined if it can't be
// reached. A reason worth showing (auth, not LM Studio) is left in localError.
let localError: string | undefined;
async function localModels(convo: Session) {
  localError = undefined;
  try {
    return await convo.local.refresh();
  } catch (e) {
    if (!(e instanceof LocalServerDown)) {
      localError = e instanceof Error ? e.message : String(e);
      return undefined;
    }
    if (!(await convo.local.startServer())) return undefined;
    return convo.local.refresh().catch(() => undefined);
  }
}

async function ask(convo: Session, input: string) {
  // First Claude message without a key: ask now (skipping keeps the question unsent).
  if (!isLocalModel(cfg.model) && !convo.claude.hasKey) {
    const key = await askForKey("Claude needs an Anthropic API key.");
    if (!key) return;
    convo.claude.setApiKey(key);
  }
  const { text, refs } = extractRefs(input);
  if (refs.length && !attach(refs)) return;
  const files = pending;
  pending = [];
  if (files.length) note(`with ${files.map((f) => f.name).join(", ")}`);

  const turn: Shown = { prompt: input, files: files.map((f) => f.name), answer: "", notes: [] };
  transcript.push(turn);
  const tellNote = (text: string) => { note(text); turn.notes.push({ text }); };
  const tellError = (text: string) => { error(text); turn.notes.push({ text, error: true }); };
  const renderer = newRenderer();

  // Spinner until the first visible text.
  const started = Date.now();
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  let frame = 0, spinning = true, label = "waiting";
  process.stdout.write("\x1b[?25l");
  const tick = () => spinning && process.stdout.write(`\r\x1b[2K  ${t.accent}${frames[frame++ % frames.length]}${t.reset} ${t.dim}${label}… ${Math.floor((Date.now() - started) / 1000)}s  (Ctrl+C to stop)${t.reset}`);
  const timer = setInterval(tick, 80);
  const stopSpinner = () => {
    if (!spinning) return;
    spinning = false;
    clearInterval(timer);
    process.stdout.write("\r\x1b[2K");
  };

  let thinking = "";
  const flushThinking = () => {
    if (!thinking.trim()) return;
    const w = termCols() - 6;
    for (const para of thinking.trim().split(/\n+/)) {
      let line = "";
      for (const word of para.split(" ")) {
        if (visibleLen(line) + word.length + 1 > w && line) { out(`  ${t.thinking}┊ ${line}${t.reset}`); line = ""; }
        line += (line ? " " : "") + word;
      }
      out(`  ${t.thinking}┊ ${line}${t.reset}`);
    }
    out();
    thinking = "";
  };

  // Ctrl+C aborts the request.
  const ctl = new AbortController();
  const stopInput = onInput((d) => d.includes(3) && ctl.abort());

  let answer = "";
  try {
    const local = isLocalModel(cfg.model);
    if (local) label = "running locally";
    const send = () =>
      convo.send(text, files, { model: cfg.model, effort: cfg.effort, showThinking: cfg.showThinking, signal: ctl.signal }, {
        onThinkingStart: () => { label = "thinking"; },
        onThinking: (d) => { if (cfg.showThinking) thinking += d; },
        onNotice: (n) => { stopSpinner(); tellNote(n); },
        onText: (d) => {
          if (spinning) { stopSpinner(); flushThinking(); }
          answer += d;
          renderer.push(d);
        },
      });
    let r;
    try {
      r = await send();
    } catch (e) {
      // LM Studio's server isn't running: start it once (on this machine only) and retry.
      if (!(e instanceof LocalServerDown) || !convo.local.isLoopback || ctl.signal.aborted) throw e;
      label = "starting LM Studio";
      const up = await convo.local.startServer(ctl.signal);
      if (ctl.signal.aborted) r = { stopReason: null, servedBy: cfg.model, aborted: true, costUsd: 0 };
      else if (!up) throw e;
      else {
        label = "running locally";
        r = await send();
      }
    }
    stopSpinner();
    flushThinking();
    renderer.end();
    if (r.aborted) tellNote("(interrupted)");
    if (r.refused) tellError(`The model declined to answer: ${r.refused}`);
    if (r.stopReason === "max_tokens") tellNote("(answer hit the length limit — ask it to continue)");
    if (!local && !r.aborted && !r.refused && r.servedBy !== cfg.model) tellNote(`(answered by ${r.servedBy} via safety fallback)`);
    if (answer) { lastAnswer = answer; lastDisplayMath = renderer.displayMath; }
  } catch (e) {
    stopSpinner();
    renderer.end();
    pending = files; // keep attachments so the user can retry
    const c = classifyClaudeError(e);
    if (c?.kind === "auth") tellError("The API key was rejected — use /key to set a new one.");
    else if (c?.kind === "rate-limit") tellError("Rate limited — wait a moment and try again.");
    else if (c?.kind === "bad-request") tellError(`Request rejected: ${c.message}`);
    else if (c?.kind === "connection") tellError("Couldn't reach the Anthropic API — check your connection.");
    else if (c) tellError(`API error ${c.status}: ${c.message}`);
    else if (e instanceof LocalServerDown) tellError(`${e.message} — open LM Studio or run: lms server start`);
    else if (e instanceof LocalAuthError || e instanceof LocalTimeout) tellError(e.message);
    else tellError(e instanceof Error ? e.message : String(e));
  } finally {
    turn.answer = answer;
    stopInput();
    process.stdout.write("\x1b[?25h");
    out();
  }
}

// ---- main ----------------------------------------------------------------------------------------

function banner() {
  out(`  ${t.bold}${t.accent}∑ Math CLI${t.reset}  ${t.dim}LaTeX-rendering maths chat · /help for commands · drag files in to attach${t.reset}`);
  out();
}

banner();
if (inWezTerm() && bridgeStatus() !== "enabled") {
  note("Tip: /setup-terminal lets Math CLI apply its theme background and transparency to this window.");
  out();
}
let { key } = resolveApiKey(cfg);
if (process.env.MATHCLI_FAKE_ANSWER) key ??= "fake";
if (!key && !isLocalModel(cfg.model)) key = await askForKey("No Anthropic API key found.");
// Dev: MATHCLI_AUTOASK="question;;/command;;…" types each step, MATHCLI_AUTOASK_MS apart (automated rendering tests).
if (process.env.MATHCLI_AUTOASK) {
  const gap = Number(process.env.MATHCLI_AUTOASK_MS ?? 6000);
  process.env.MATHCLI_AUTOASK.split(";;").forEach((step, i) =>
    setTimeout(() => process.stdin.emit("data", Buffer.from(step + "\r")), gap * (i + 1)),
  );
}
const convo = new Session(new ClaudeBackend(key), new LocalBackend(cfg.lmstudioUrl));
// On exit (including the window being closed): unload local models / stop LM Studio per /local-exit.
process.on("exit", () => convo.local.cleanupOnExit(cfg.localOnExit));
// Context size for the meter: a quick passive look in the background — never blocks the prompt, never starts LM Studio.
if (isLocalModel(cfg.model)) convo.local.refresh(800).catch(() => {});

for (;;) {
  const r = await prompt({
    status: () => status(convo),
    above: attachmentChips,
    placeholder: convo.turns.length ? "Follow up…" : "Ask a maths question, type / for commands, or attach with @file",
    history,
    commands: COMMANDS,
    onPaste,
  });
  if (r.kind === "exit") break;
  const line = r.text.trim();
  if (!line && !pending.length) continue;
  if (line.startsWith("/")) {
    if ((await command(line, convo)) === "exit") break;
    out();
    continue;
  }
  await ask(convo, line);
}
process.exit(0);
