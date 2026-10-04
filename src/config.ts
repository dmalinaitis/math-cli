// User config lives in ~/.mathcli/config.json (C:\Users\<you>\.mathcli\config.json on Windows).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const MODELS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  fable: "claude-fable-5-1",
  haiku: "claude-haiku-4-5",
};

export interface Config {
  anthropicApiKey?: string;
  model: string;
  effort: Effort;
  mathScale: number; // display-math size relative to the terminal font
  showThinking: boolean; // print Claude's summarised reasoning (dim) before the answer
  inlineMath: InlineMode; // auto: Unicode when exact, typeset image otherwise
  theme: string; // built-in (royal, white, midnight, mocha) or ~/.mathcli/themes/<name>.json
  opacity: number; // WezTerm window opacity while mathcli runs, 0.3–1
  blur: boolean; // acrylic blur behind a translucent window (Windows 11)
  localModel: string; // LM Studio model id used by "/model local"
  lmstudioUrl: string; // LM Studio server
  // On exit — auto: undo what mathcli did (unload models it loaded, stop the server / quit LM Studio if
  // it started them); always: unload everything and quit LM Studio; keep: leave it running.
  localOnExit: "auto" | "always" | "keep";
}

export type InlineMode = "auto" | "image" | "unicode";
export const INLINE_MODES: InlineMode[] = ["auto", "image", "unicode"];

const DEFAULTS: Config = {
  model: MODELS.opus,
  effort: "high",
  mathScale: 1.5,
  showThinking: false,
  inlineMath: "auto",
  theme: "royal",
  opacity: 1,
  blur: true,
  localModel: "qwen/qwen3.5-9b",
  lmstudioUrl: "http://localhost:1234",
  localOnExit: "auto",
};

export const CONFIG_DIR = join(homedir(), ".mathcli");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(patch: Partial<Config>): Config {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return next;
}

// Env var wins so a key can be supplied per-shell without touching the file.
export function resolveApiKey(cfg: Config): { key?: string; source?: "env" | "config" } {
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, source: "env" };
  if (cfg.anthropicApiKey) return { key: cfg.anthropicApiKey, source: "config" };
  return {};
}
