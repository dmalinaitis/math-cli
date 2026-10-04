// Math CLI — chat with Claude or a local model about maths, with LaTeX typeset in the terminal.
import Anthropic from "@anthropic-ai/sdk";
import { CONFIG_FILE, EFFORTS, INLINE_MODES, MODELS, loadConfig, resolveApiKey, saveConfig, type Effort, type InlineMode } from "./config.js";
import { queryTerminal } from "./term/caps.js";
import { writeClipboard } from "./term/clipboard.js";
import { bridgeStatus, clearTerminalTheme, enableBridge, inWezTerm, sendTerminalTheme } from "./term/wezterm.js";
import { listThemes, resolveTheme } from "./ui/themes.js";
import { onInput } from "./term/keys.js";
import { termCols } from "./term/size.js";
import { ClaudeBackend } from "./llm/claude.js";
import { LOCAL_ON_EXIT, LocalBackend, LocalServerDown, type LocalOnExit } from "./llm/local.js";
import { Session } from "./llm/session.js";
import { isLocalModel, localModelId } from "./llm/types.js";
import { AttachmentError, extractRefs, isAttachablePath, loadAttachment, unquotePath, type Attachment } from "./llm/attachments.js";
import { prompt, promptRecord } from "./ui/input.js";
import { StreamRenderer } from "./ui/markdown.js";
import { applyTheme, theme as t, visibleLen } from "./ui/theme.js";

const out = (s = "") => process.stdout.write(s + "\n");
const note = (s: string) => out(`  ${t.dim}${s}${t.reset}`);
const error = (s: string) => out(`  ${t.error}${s}${t.reset}`);
process.on("exit", () => process.stdout.write("\x1b[?25h\x1b[?2004l"));

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

async function askForKey(reason: string): Promise<string> {
  out();
  out(`  ${t.bold}${reason}${t.reset}`);
  note("Create a key at https://console.anthropic.com/settings/keys and paste it below.");
  note(`It is saved to ${CONFIG_FILE}. Alternatively set the ANTHROPIC_API_KEY environment variable.`);
  out();
  for (;;) {
    const r = prompt({ mask: true, placeholder: "Paste your API key (Ctrl+V or Ctrl+Shift+V)", status: () => `${t.dim}Enter to save · Ctrl+C to quit${t.reset}` });
    const res = await r;
    if (res.kind === "exit") process.exit(0);
    const key = res.text.trim();
    if (!key) continue;
    try {
      await ClaudeBackend.verifyKey(key, isLocalModel(cfg.model) ? MODELS.opus : cfg.model);
      cfg = saveConfig({ anthropicApiKey: key });
      note("Key verified and saved.");
      out();
      return key;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
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

const HELP: [string, string][] = [
  ["/attach <file…>", "attach images, PDFs or .tex/.txt files (or type @file, or drag files onto the window)"],
  ["/detach", "remove pending attachments"],
  ["/model [name]", "list or switch models: opus, sonnet, fable, haiku, local, or an LM Studio model (e.g. gemma)"],
  ["/effort [low…max]", "how hard Claude thinks (default high)"],
  ["/thinking", "toggle showing Claude's summarised reasoning"],
  ["/scale <n>", "display-math size relative to text (default 1.5)"],
  ["/inline [auto|image|unicode]", "inline maths: typeset only when Unicode can't show it exactly (auto), always, or never"],
  ["/theme [name]", "list or switch themes (royal, white, midnight, mocha, or your own in ~/.mathcli/themes)"],
  ["/opacity [0.3–1]", "window transparency in WezTerm (1 = opaque)"],
  ["/blur [on|off]", "acrylic blur behind a translucent window"],
  ["/setup-terminal", "let mathcli theme its WezTerm window (adds one line to your .wezterm.lua)"],
  ["/local-exit [auto|always|keep]", "on exit, free the local model and close LM Studio (auto: only what mathcli started)"],
  ["/copy", "copy the last answer (markdown + LaTeX) to the clipboard"],
  ["/copy-latex", "copy just the display equations from the last answer"],
  ["/redraw", "re-render the conversation (e.g. after resizing the window)"],
  ["/clear", "start a new conversation"],
  ["/key", "replace the saved API key"],
  ["/exit", "quit (or Ctrl+C on an empty prompt)"],
];

async function command(line: string, convo: Session): Promise<"exit" | void> {
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  const arg = args.join(" ").trim();
  switch (cmd.toLowerCase()) {
    case "help": case "?":
      for (const [c, d] of HELP) out(`  ${t.accent}${c.padEnd(36)}${t.reset}${t.dim}${d}${t.reset}`);
      note("Enter sends · Ctrl+J or \\ + Enter for a new line · ↑/↓ history · Ctrl+C interrupts an answer");
      break;
    case "attach": case "a": {
      const paths = arg.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
      if (!paths.length) { note("usage: /attach <file> [more files…]"); break; }
      attach(paths);
      break;
    }
    case "detach": pending = []; note("Attachments cleared."); break;
    case "model": case "m": {
      const locals = await localModels(convo);
      if (!arg) {
        const mark = (id: string) => (id === cfg.model ? t.accent + "›" : " ");
        out(`  ${t.bold}Claude${t.reset}`);
        for (const [alias, id] of Object.entries(MODELS)) out(`  ${mark(id)} ${alias.padEnd(8)}${t.reset}${t.dim}${id}${t.reset}`);
        out(`  ${t.bold}Local (LM Studio)${t.reset}`);
        if (!locals) note("  LM Studio isn't running — start it, or run: lms server start");
        else if (!locals.length) note("  no models installed — download one in LM Studio");
        for (const m of locals ?? []) {
          const tags = [m.vision ? "vision" : "", `${tokens(m.contextLength)} ctx`, m.loaded ? "loaded" : ""].filter(Boolean).join(", ");
          out(`  ${mark(`local:${m.id}`)} ${m.id.padEnd(34)}${t.reset}${t.dim}${tags}${m.id === cfg.localModel ? " · default local" : ""}${t.reset}`);
        }
        note("/model <name> — e.g. /model sonnet, /model local, /model gemma");
        break;
      }
      const a = arg.toLowerCase();
      let id = MODELS[a] ?? (a.startsWith("claude-") ? arg : undefined);
      if (!id) {
        const want = a === "local" ? cfg.localModel : a.replace(/^local:/, "");
        const match = locals?.find((m) => m.id.toLowerCase() === want) ?? locals?.find((m) => m.id.toLowerCase().includes(want));
        if (match) id = `local:${match.id}`;
        else if (!locals) { error("LM Studio isn't running — start it, or run: lms server start"); break; }
      }
      if (!id) { error(`unknown model "${arg}" — /model lists them`); break; }
      cfg = saveConfig(isLocalModel(id) ? { model: id, localModel: localModelId(id) } : { model: id });
      note(`Model: ${id}${convo.turns.length ? " — the conversation so far carries over" : ""}`);
      if (isLocalModel(id) && !locals?.find((m) => `local:${m.id}` === id)?.loaded) note("It will load on the first message (a few seconds).");
      if (!isLocalModel(id) && !convo.claude.hasKey) note("No Anthropic API key yet — add one with /key.");
      break;
    }
    case "effort": case "e": {
      if (!arg) { note(`Effort: ${cfg.effort}  (options: ${EFFORTS.join(", ")})`); break; }
      if (!EFFORTS.includes(arg as Effort)) { error(`effort must be one of ${EFFORTS.join(", ")}`); break; }
      cfg = saveConfig({ effort: arg as Effort });
      note(`Effort: ${arg}`);
      break;
    }
    case "thinking":
      cfg = saveConfig({ showThinking: !cfg.showThinking });
      note(`Show reasoning: ${cfg.showThinking ? "on" : "off"}`);
      break;
    case "theme": {
      if (!arg) {
        for (const name of listThemes()) {
          const d = resolveTheme(name)!;
          const swatch = [d.background, d.panel, d.accent, d.heading, d.inlineMath].map((h) => `\x1b[48;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m  `).join("") + t.reset;
          out(`  ${name === cfg.theme ? t.accent + "›" : " "} ${name.padEnd(10)}${t.reset}${swatch}`);
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
      const on = arg ? arg === "on" : !cfg.blur;
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
      const explain: Record<LocalOnExit, string> = {
        auto: "unload models this session loaded; stop the server and quit LM Studio if mathcli started them",
        always: "unload all models, stop the server and quit LM Studio",
        keep: "leave LM Studio and loaded models as they are",
      };
      if (!arg) { note(`On exit: ${cfg.localOnExit} — ${explain[cfg.localOnExit]}  (options: ${LOCAL_ON_EXIT.join(", ")})`); break; }
      if (!LOCAL_ON_EXIT.includes(arg as LocalOnExit)) { error(`must be one of ${LOCAL_ON_EXIT.join(", ")}`); break; }
      cfg = saveConfig({ localOnExit: arg as LocalOnExit });
      note(`On exit: ${arg} — ${explain[arg as LocalOnExit]}`);
      break;
    }
    case "inline": {
      if (!arg) { note(`Inline maths: ${cfg.inlineMath}  (options: ${INLINE_MODES.join(", ")})`); break; }
      if (!INLINE_MODES.includes(arg as InlineMode)) { error(`inline mode must be one of ${INLINE_MODES.join(", ")}`); break; }
      cfg = saveConfig({ inlineMath: arg as InlineMode });
      redraw();
      note(`Inline maths: ${arg}`);
      break;
    }
    case "scale": {
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
      transcript.length = 0;
      process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
      banner();
      break;
    case "key": {
      convo.claude.setApiKey(await askForKey("Enter a new Anthropic API key."));
      break;
    }
    case "exit": case "quit": case "q":
      return "exit";
    default:
      error(`unknown command /${cmd} — try /help`);
  }
}

// ---- a turn --------------------------------------------------------------------------------------

// LM Studio's models, starting its server if needed; undefined if it can't be reached.
async function localModels(convo: Session) {
  try {
    return await convo.local.refresh();
  } catch (e) {
    if (!(e instanceof LocalServerDown) || !convo.local.startServer()) return undefined;
    return convo.local.refresh().catch(() => undefined);
  }
}

async function ask(convo: Session, input: string) {
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
      // LM Studio's server isn't running: start it once and retry.
      if (!(e instanceof LocalServerDown) || !convo.local.startServer()) throw e;
      label = "starting LM Studio";
      r = await send();
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
    if (e instanceof Anthropic.AuthenticationError) tellError("The API key was rejected — use /key to set a new one.");
    else if (e instanceof Anthropic.RateLimitError) tellError("Rate limited — wait a moment and try again.");
    else if (e instanceof Anthropic.BadRequestError) tellError(`Request rejected: ${e.message}`);
    else if (e instanceof Anthropic.APIConnectionError) tellError("Couldn't reach the Anthropic API — check your connection.");
    else if (e instanceof Anthropic.APIError) tellError(`API error ${e.status}: ${e.message}`);
    else if (e instanceof LocalServerDown) tellError(`${e.message} — open LM Studio or run: lms server start`);
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
if (isLocalModel(cfg.model)) await localModels(convo); // context size for the meter

for (;;) {
  const r = await prompt({
    status: () => status(convo),
    above: attachmentChips,
    placeholder: convo.turns.length ? "Follow up…" : "Ask a maths question, or attach a problem sheet with @file",
    history,
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
