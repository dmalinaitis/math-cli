// Claude backend: streaming, attachments, adaptive thinking, refusal fallback, cost and context tracking.
import type Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT, type Backend, type RunResult, type SendOptions, type Turn, type TurnCallbacks } from "./types.js";

const PRICES: Record<string, { in: number; out: number; cacheRead: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-fable-5-1": { in: 10, out: 50, cacheRead: 0.25 },
  "claude-haiku-4-5": { in: 1, out: 5, cacheRead: 0.1 },
};

export const claudeContextWindow = (model: string) => (model.startsWith("claude-haiku") ? 200_000 : 1_000_000);

function toMessages(turns: Turn[]): Anthropic.Beta.BetaMessageParam[] {
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of turns) {
    // Documents and images go before the question, as the API recommends.
    messages.push({ role: "user", content: [...t.attachments.map((a) => a.block), { type: "text", text: t.text || "(see attachment)" }] });
    // Replay Claude's own content blocks unchanged (append-only history); other models' replies as text.
    if (t.reply) messages.push({ role: "assistant", content: t.reply.claudeContent ?? t.reply.text });
  }
  return messages;
}

// The SDK is loaded on first use, so startup (and local-only sessions) never pay for it.
type AnthropicSdk = typeof import("@anthropic-ai/sdk");
let sdk: AnthropicSdk | undefined;
let sdkLoading: Promise<AnthropicSdk> | undefined;
export async function getAnthropic(): Promise<AnthropicSdk["default"]> {
  sdkLoading ??= import("@anthropic-ai/sdk").then((m) => (sdk = m));
  return (await sdkLoading).default;
}

export type ClaudeErrorKind = "auth" | "permission" | "rate-limit" | "bad-request" | "connection" | "api";

// Classify an error thrown by the Anthropic SDK, without the caller importing it. Undefined if it
// isn't an SDK error (if the SDK was never loaded, nothing can have come from it).
export function classifyClaudeError(e: unknown): { kind: ClaudeErrorKind; status?: number; message: string } | undefined {
  const A = sdk?.default;
  if (!A || !(e instanceof A.APIError)) return undefined;
  const kind: ClaudeErrorKind =
    e instanceof A.AuthenticationError ? "auth"
    : e instanceof A.PermissionDeniedError ? "permission"
    : e instanceof A.RateLimitError ? "rate-limit"
    : e instanceof A.BadRequestError ? "bad-request"
    : e instanceof A.APIConnectionError ? "connection"
    : "api";
  return { kind, status: e.status, message: e.message };
}

export class ClaudeBackend implements Backend {
  private client?: Anthropic;
  private apiKey?: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || undefined;
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
    this.client = undefined;
  }

  get hasKey() {
    return !!this.apiKey;
  }

  private async getClient(): Promise<Anthropic> {
    if (!this.apiKey) throw new Error("No Anthropic API key — use /key to add one, or /model local for a local model.");
    if (!this.client) {
      const A = await getAnthropic();
      this.client = new A({ apiKey: this.apiKey });
    }
    return this.client;
  }

  async run(turns: Turn[], opts: SendOptions, cb: TurnCallbacks): Promise<RunResult> {
    const client = await this.getClient();
    const isHaiku = opts.model.startsWith("claude-haiku");
    const stream = client.beta.messages.stream(
      {
        model: opts.model,
        max_tokens: 64000,
        system: SYSTEM_PROMPT,
        messages: toMessages(turns),
        cache_control: { type: "ephemeral" }, // re-sent PDFs and history are read from cache on later turns
        ...(isHaiku
          ? {}
          : {
              thinking: { type: "adaptive", display: opts.showThinking ? "summarized" : "omitted" },
              output_config: { effort: opts.effort },
              // If a safety classifier declines a legitimate maths question, re-run it on Anthropic's
              // recommended fallback model instead of failing.
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            }),
      },
      { signal: opts.signal },
    );

    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_start" && ev.content_block.type === "thinking") cb.onThinkingStart?.();
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") cb.onText(ev.delta.text);
          else if (ev.delta.type === "thinking_delta") cb.onThinking?.(ev.delta.thinking);
        }
      }
      const msg = await stream.finalMessage();
      const u = msg.usage;
      const p = PRICES[msg.model] ?? PRICES["claude-opus-5-5"];
      const costUsd =
        ((u.input_tokens ?? 0) * p.in +
          (u.cache_creation_input_tokens ?? 0) * p.in * 1.25 +
          (u.cache_read_input_tokens ?? 0) * p.cacheRead +
          (u.output_tokens ?? 0) * p.out) /
        1e6;
      const contextTokens =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      const base = { servedBy: msg.model, aborted: false, costUsd, contextTokens, contextWindow: claudeContextWindow(opts.model) };

      if (msg.stop_reason === "refusal") {
        const d = msg.stop_details;
        return { ...base, stopReason: msg.stop_reason, refused: d?.explanation ?? d?.category ?? "declined" };
      }
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { ...base, stopReason: msg.stop_reason, reply: { text, model: msg.model, claudeContent: msg.content } };
    } catch (e) {
      if (e instanceof (await getAnthropic()).APIUserAbortError || opts.signal.aborted) {
        return { stopReason: null, servedBy: opts.model, aborted: true, costUsd: 0 };
      }
      throw e;
    }
  }

  // Cheap auth check: fetch the model's metadata.
  static async verifyKey(apiKey: string, model: string): Promise<void> {
    const A = await getAnthropic();
    await new A({ apiKey }).models.retrieve(model);
  }
}
