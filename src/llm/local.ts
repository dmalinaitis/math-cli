// Local models through LM Studio's OpenAI-compatible server (default http://localhost:1234).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../config.js";
import OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { extractText } from "unpdf";
import type { Attachment } from "./attachments.js";
import { SYSTEM_PROMPT, localModelId, type Backend, type RunResult, type SendOptions, type Turn, type TurnCallbacks } from "./types.js";

export interface LocalModel {
  id: string;
  vision: boolean;
  loaded: boolean;
  contextLength: number; // loaded context if loaded, else the model's maximum
}

export class LocalServerDown extends Error {}

// LM Studio's native REST API reports type (llm / vlm), load state and context lengths.
export async function listLocalModels(baseUrl: string): Promise<LocalModel[]> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new LocalServerDown(`LM Studio isn't reachable at ${baseUrl}`);
  }
  const { data } = (await res.json()) as { data: any[] };
  return data
    .filter((m) => m.type === "llm" || m.type === "vlm")
    .map((m) => ({
      id: m.id,
      vision: m.type === "vlm",
      loaded: m.state === "loaded",
      contextLength: m.loaded_context_length ?? m.max_context_length,
    }));
}

const CLEANUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "lmstudio-cleanup.mjs");

// LM Studio's CLI, installed alongside the app.
const LMS = [join(homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms"), "lms"].find(
  (p) => p === "lms" || existsSync(p),
)!;

export function startLocalServer(): boolean {
  return spawnSync(LMS, ["server", "start"], { encoding: "utf8", timeout: 30000 }).status === 0;
}

function lmStudioAppRunning(): boolean {
  if (process.platform !== "win32") return true; // unknown elsewhere: never quit it
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq LM Studio.exe", "/NH"], { encoding: "utf8" });
  return r.stdout.includes("LM Studio.exe");
}

export type LocalOnExit = "auto" | "always" | "keep";
export const LOCAL_ON_EXIT: LocalOnExit[] = ["auto", "always", "keep"];

// What was already running before mathcli touched LM Studio, so exit cleanup only undoes our own doing.
interface Before {
  app: boolean;
  server?: boolean;
  loaded?: Set<string>;
}

const pdfTextCache = new Map<string, string>();

async function pdfText(path: string): Promise<string> {
  if (!pdfTextCache.has(path)) {
    const { text } = await extractText(new Uint8Array(readFileSync(path)), { mergePages: true });
    pdfTextCache.set(path, text);
  }
  return pdfTextCache.get(path)!;
}

// Splits <think>…</think> out of streamed content, tolerating tags split across chunks.
class ThinkSplitter {
  private inThink = false;
  private carry = "";
  constructor(private onText: (s: string) => void, private onThink: (s: string) => void) {}
  push(s: string) {
    s = this.carry + s;
    this.carry = "";
    while (s) {
      const tag = this.inThink ? "</think>" : "<think>";
      const i = s.indexOf(tag);
      if (i >= 0) {
        this.emit(s.slice(0, i));
        this.inThink = !this.inThink;
        s = s.slice(i + tag.length);
        continue;
      }
      // Hold back a possible partial tag at the end.
      const keep = [...Array(tag.length - 1).keys()].map((k) => k + 1).reverse().find((k) => tag.startsWith(s.slice(-k))) ?? 0;
      this.emit(s.slice(0, s.length - keep));
      this.carry = s.slice(s.length - keep);
      s = "";
    }
  }
  flush() {
    this.emit(this.carry);
    this.carry = "";
  }
  private emit(s: string) {
    if (s) (this.inThink ? this.onThink : this.onText)(s);
  }
}

export class LocalBackend implements Backend {
  private client: OpenAI;
  models: LocalModel[] = [];

  private before?: Before;
  private used = new Set<string>(); // models this session sent messages to
  private startedServer = false;

  constructor(private baseUrl: string) {
    this.client = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: "lm-studio" });
  }

  async refresh(): Promise<LocalModel[]> {
    this.before ??= { app: lmStudioAppRunning() };
    this.models = await listLocalModels(this.baseUrl);
    if (this.before.server === undefined) {
      this.before.server = !this.startedServer;
      this.before.loaded = new Set(this.models.filter((m) => m.loaded).map((m) => m.id));
    }
    return this.models;
  }

  // Start LM Studio's server (waking the app if needed); remembered so exit cleanup can stop it again.
  startServer(): boolean {
    this.before ??= { app: lmStudioAppRunning() };
    const ok = startLocalServer();
    if (ok) this.startedServer = true;
    return ok;
  }

  // Commands that undo what this session did in LM Studio (see LocalOnExit), or none.
  private cleanupCommands(mode: LocalOnExit): string[][] {
    if (mode === "keep" || !this.before || (!this.used.size && !this.startedServer)) return [];
    const always = mode === "always";
    const cmds: string[][] = [];
    if (always) cmds.push(["unload", "--all"]);
    else for (const id of this.used) if (!this.before.loaded?.has(id)) cmds.push(["unload", id]);
    if (always || this.startedServer) cmds.push(["server", "stop"]);
    if (always || !this.before.app) cmds.push(["quit-app"]);
    return cmds;
  }

  // Run the cleanup in a detached process: it must outlive this one, because closing the terminal
  // window gives us only a moment before Windows ends the process.
  cleanupOnExit(mode: LocalOnExit) {
    const cmds = this.cleanupCommands(mode);
    if (!cmds.length) return;
    // Plain node + argv: no shell, so no quoting of paths or model ids.
    spawn(process.execPath, [CLEANUP_SCRIPT, LMS, join(CONFIG_DIR, "cleanup.log"), JSON.stringify(cmds)], {
      detached: true, stdio: "ignore", windowsHide: true,
    }).unref();
  }

  private async userContent(t: Turn, vision: boolean, model: string, cb: TurnCallbacks, fresh: boolean): Promise<ChatCompletionContentPart[]> {
    const parts: ChatCompletionContentPart[] = [];
    for (const a of t.attachments) parts.push(...(await this.attachmentParts(a, vision, model, cb, fresh)));
    parts.push({ type: "text", text: t.text || "(see attachment)" });
    return parts;
  }

  private async attachmentParts(a: Attachment, vision: boolean, model: string, cb: TurnCallbacks, fresh: boolean): Promise<ChatCompletionContentPart[]> {
    if (a.kind === "image") {
      if (!vision) {
        if (fresh) cb.onNotice?.(`${model} can't read images — ${a.name} was skipped. Try a vision model (/model) or Claude.`);
        return [];
      }
      const b = a.block as { source: { media_type: string; data: string } };
      return [{ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }];
    }
    // Local models don't read PDFs natively: send the text layer.
    const body = a.kind === "pdf" ? await pdfText(a.path) : readFileSync(a.path, "utf8");
    if (a.kind === "pdf" && fresh && body.replace(/\s/g, "").length < 200) {
      cb.onNotice?.(`${a.name} has little or no text layer (scanned?) — the local model can't see its contents. Claude reads PDFs as images.`);
    }
    return [{ type: "text", text: `<document name="${a.name}">\n${body}\n</document>` }];
  }

  async run(turns: Turn[], opts: SendOptions, cb: TurnCallbacks): Promise<RunResult> {
    const id = localModelId(opts.model);
    this.used.add(id);
    if (!this.models.length) await this.refresh();
    const info = this.models.find((m) => m.id === id);
    if (!info) throw new Error(`LM Studio has no model "${id}" — /model lists what's installed.`);

    const messages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }];
    for (const [i, t] of turns.entries()) {
      messages.push({ role: "user", content: await this.userContent(t, info.vision, id, cb, i === turns.length - 1) });
      if (t.reply) messages.push({ role: "assistant", content: t.reply.text });
    }

    let text = "";
    let thinkingStarted = false;
    const think = (s: string) => {
      if (!thinkingStarted) { thinkingStarted = true; cb.onThinkingStart?.(); }
      cb.onThinking?.(s);
    };
    const splitter = new ThinkSplitter((s) => { text += s; cb.onText(s); }, think);
    let usage: OpenAI.CompletionUsage | undefined;
    let finish: string | null = null;

    try {
      const stream = await this.client.chat.completions.create(
        { model: id, messages, stream: true, stream_options: { include_usage: true } },
        { signal: opts.signal },
      );
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices[0];
        if (!choice) continue;
        // LM Studio reports separated reasoning as reasoning_content (or reasoning) when the model's
        // reasoning parser is on; otherwise it arrives inline as <think>…</think>.
        const d = choice.delta as { content?: string; reasoning_content?: string; reasoning?: string };
        const r = d.reasoning_content ?? d.reasoning;
        if (r) think(r);
        if (d.content) splitter.push(d.content);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      splitter.flush();
    } catch (e) {
      if (opts.signal.aborted) return { stopReason: null, servedBy: opts.model, aborted: true, costUsd: 0 };
      if (e instanceof OpenAI.APIConnectionError) throw new LocalServerDown(`LM Studio isn't reachable at ${this.baseUrl}`);
      throw e;
    }

    // The model is loaded now — pick up its actual context length for the meter.
    await this.refresh().catch(() => {});
    const loaded = this.models.find((m) => m.id === id) ?? info;
    return {
      stopReason: finish === "length" ? "max_tokens" : finish,
      servedBy: opts.model,
      aborted: false,
      reply: { text, model: opts.model },
      costUsd: 0,
      contextTokens: usage?.total_tokens,
      contextWindow: loaded.contextLength,
    };
  }
}
