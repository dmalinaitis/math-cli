// Local models through LM Studio's OpenAI-compatible server (default http://localhost:1234).
// The openai and unpdf packages are loaded on first use, so they cost nothing at startup.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "../config.js";
import type OpenAI from "openai";
import type { ChatCompletionContentPart, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Attachment } from "./attachments.js";
import { SYSTEM_PROMPT, localModelId, type Backend, type RunResult, type SendOptions, type Turn, type TurnCallbacks } from "./types.js";

export interface LocalModel {
  id: string;
  vision: boolean;
  loaded: boolean;
  contextLength: number; // loaded context if loaded, else the model's maximum
}

export class LocalServerDown extends Error {}
export class LocalAuthError extends Error {}
export class LocalTimeout extends Error {}

export const normalizeBaseUrl = (u: string) => u.trim().replace(/\/+$/, "");

// Only ever start, stop or kill LM Studio when it runs on this machine (not a remote/Tailscale host).
export function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return h === "localhost" || h === "[::1]" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
  } catch {
    return false;
  }
}

const DEFAULT_CONTEXT = 32768;

// LM Studio's native REST API reports type (llm / vlm), load state and context lengths. Tries the
// 0.4+ API, then the legacy one, then the plain OpenAI-compatible list.
export async function listLocalModels(baseUrl: string, timeoutMs = 2000): Promise<LocalModel[]> {
  baseUrl = normalizeBaseUrl(baseUrl);
  const headers: Record<string, string> = {};
  if (process.env.LM_API_TOKEN) headers.Authorization = `Bearer ${process.env.LM_API_TOKEN}`;

  // Parsed JSON body, or undefined for a non-2xx (e.g. 404 on an older LM Studio) or non-JSON reply.
  let lastStatus = 0;
  const get = async (path: string): Promise<any> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new LocalServerDown(`LM Studio isn't reachable at ${baseUrl}`);
    }
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) {
      throw new LocalAuthError(
        `LM Studio at ${baseUrl} refused the request (HTTP ${res.status}) — set LM_API_TOKEN to its API token, or turn off authentication in LM Studio.`,
      );
    }
    if (res.status >= 500) throw new LocalServerDown(`LM Studio at ${baseUrl} returned HTTP ${res.status}`);
    if (!res.ok) return undefined;
    return res.json().catch(() => undefined);
  };

  let answered = false; // some endpoint gave a valid (possibly empty) list

  const v1 = await get("/api/v1/models");
  if (Array.isArray(v1?.models)) {
    answered = true;
    const models: LocalModel[] = v1.models
      .filter((m: any) => m.type === "llm" || m.type === "vlm")
      .map((m: any) => ({
        id: m.key ?? m.id,
        vision: Boolean(m.capabilities?.vision || m.type === "vlm"),
        loaded: Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0,
        contextLength: m.loaded_instances?.[0]?.config?.context_length ?? m.max_context_length ?? DEFAULT_CONTEXT,
      }));
    if (models.length) return models;
  }

  const v0 = await get("/api/v0/models");
  if (Array.isArray(v0?.data)) {
    answered = true;
    const models: LocalModel[] = v0.data
      .filter((m: any) => m.type === "llm" || m.type === "vlm")
      .map((m: any) => ({
        id: m.id,
        vision: m.type === "vlm",
        loaded: m.state === "loaded",
        contextLength: m.loaded_context_length ?? m.max_context_length ?? DEFAULT_CONTEXT,
      }));
    if (models.length) return models;
  }

  const oai = await get("/v1/models");
  if (Array.isArray(oai?.data)) {
    return oai.data
      .filter((m: any) => typeof m.id === "string" && !/embed/i.test(m.id))
      .map((m: any) => ({
        id: m.id,
        vision: /vl|vision|qwen3\.5|gemma-?3|gemma-?4/i.test(m.id),
        loaded: true,
        contextLength: DEFAULT_CONTEXT,
      }));
  }
  if (answered) return [];
  throw new Error(`${baseUrl} doesn't look like an LM Studio server (HTTP ${lastStatus} from its models API)`);
}

const CLEANUP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "lmstudio-cleanup.mjs");

// LM Studio's CLI, installed alongside the app.
const LMS = [join(homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms"), "lms"].find(
  (p) => p === "lms" || existsSync(p),
)!;

// Run `lms server start` without blocking the event loop (so the spinner and Ctrl+C keep working),
// then wait briefly until the server actually answers.
export async function startLocalServer(signal?: AbortSignal, baseUrl = "http://localhost:1234"): Promise<boolean> {
  baseUrl = normalizeBaseUrl(baseUrl);
  if (!isLoopbackUrl(baseUrl) || signal?.aborted) return false;
  const started = await new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const child = spawn(LMS, ["server", "start"], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); finish(false); }, 30000);
    const onAbort = () => { child.kill(); finish(false); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
  if (!started) return false;
  for (let i = 0; i < 12 && !signal?.aborted; i++) {
    try {
      await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(250) });
      return true; // any HTTP answer (even 401) means it's up
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

// Whether the LM Studio app is running (Windows only; elsewhere unknown, so we never quit it).
function lmStudioAppRunning(): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile("tasklist", ["/FI", "IMAGENAME eq LM Studio.exe", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? true : (stdout ?? "").includes("LM Studio.exe"));
    });
  });
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
    const { extractText } = await import("unpdf");
    const { text } = await extractText(new Uint8Array(readFileSync(path)), { mergePages: true });
    pdfTextCache.set(path, text);
  }
  return pdfTextCache.get(path)!;
}

// Splits <think>…</think> out of streamed content, tolerating tags split across chunks. A stray
// </think> outside thinking (prompt templates that prefill <think>) is dropped rather than shown.
export class ThinkSplitter {
  private inThink = false;
  private carry = "";
  constructor(private onText: (s: string) => void, private onThink: (s: string) => void) {}
  push(s: string) {
    s = this.carry + s;
    this.carry = "";
    while (s) {
      const tags = this.inThink ? ["</think>"] : ["<think>", "</think>"];
      let i = -1, tag = "";
      for (const tg of tags) {
        const j = s.indexOf(tg);
        if (j >= 0 && (i < 0 || j < i)) { i = j; tag = tg; }
      }
      if (i >= 0) {
        this.emit(s.slice(0, i));
        this.inThink = tag === "<think>";
        s = s.slice(i + tag.length);
        continue;
      }
      // Hold back a possible partial tag at the end.
      let keep = 0;
      for (const tg of tags) {
        for (let k = Math.min(tg.length - 1, s.length); k > keep; k--) {
          if (s.endsWith(tg.slice(0, k))) { keep = k; break; }
        }
      }
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

type OpenAISdk = typeof import("openai");
let openaiLoading: Promise<OpenAISdk> | undefined;
const loadOpenAI = () => (openaiLoading ??= import("openai"));

export class LocalBackend implements Backend {
  private client?: OpenAI;
  models: LocalModel[] = [];

  private baseUrl: string;
  private before?: Before;
  private appProbe?: Promise<boolean>;
  private used = new Set<string>(); // models this session sent messages to
  private startedServer = false;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  get isLoopback() {
    return isLoopbackUrl(this.baseUrl);
  }

  private async getClient(): Promise<OpenAI> {
    if (!this.client) {
      const { default: OpenAI } = await loadOpenAI();
      // No retries: a refused connection should surface at once (we start the server and retry ourselves).
      this.client = new OpenAI({ baseURL: `${this.baseUrl}/v1`, apiKey: process.env.LM_API_TOKEN || "lm-studio", maxRetries: 0 });
    }
    return this.client;
  }

  // Record whether the LM Studio app was already running before this session touched it.
  private async snapshot(): Promise<Before> {
    this.appProbe ??= this.isLoopback ? lmStudioAppRunning() : Promise.resolve(true);
    const app = await this.appProbe;
    return (this.before ??= { app });
  }

  async refresh(timeoutMs?: number): Promise<LocalModel[]> {
    const before = await this.snapshot();
    this.models = await listLocalModels(this.baseUrl, timeoutMs);
    if (before.server === undefined) {
      before.server = !this.startedServer;
      before.loaded = new Set(this.models.filter((m) => m.loaded).map((m) => m.id));
    }
    return this.models;
  }

  // Start LM Studio's server (waking the app if needed); remembered so exit cleanup can stop it again.
  // Never for a remote LM Studio: that isn't ours to start.
  async startServer(signal?: AbortSignal): Promise<boolean> {
    if (!this.isLoopback) return false;
    await this.snapshot();
    const ok = await startLocalServer(signal, this.baseUrl);
    if (ok) this.startedServer = true;
    return ok;
  }

  // Commands that undo what this session did in LM Studio (see LocalOnExit), or none.
  private cleanupCommands(mode: LocalOnExit): string[][] {
    if (mode === "keep" || !this.isLoopback || !this.before || (!this.used.size && !this.startedServer)) return [];
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
      const client = await this.getClient();
      const stream = await client.chat.completions.create(
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
      const { APIConnectionError, APIConnectionTimeoutError } = await loadOpenAI();
      // Check the timeout first: it's a subclass of APIConnectionError, but means "slow", not "down".
      if (e instanceof APIConnectionTimeoutError) {
        throw new LocalTimeout(`LM Studio at ${this.baseUrl} took too long to answer — the model may still be loading; try again in a moment.`);
      }
      if (e instanceof APIConnectionError) throw new LocalServerDown(`LM Studio isn't reachable at ${this.baseUrl}`);
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
