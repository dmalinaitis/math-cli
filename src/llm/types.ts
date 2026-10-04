// Shared types for chat backends (Claude, local models via LM Studio).
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "../config.js";
import type { Attachment } from "./attachments.js";

export const SYSTEM_PROMPT = `You are a mathematics assistant working at university level, answering inside a terminal that typesets LaTeX.

How your answers are rendered:
- Display math written as $$...$$ (on its own lines) is typeset as an image. Use it for anything with structure: fractions, sums, integrals, limits, matrices, aligned derivations, cases.
- Inline math written as $...$ is typeset small inside the line of text, so keep it to short expressions (symbols, variables, $x^2$, $g_{\\mu\\nu}$, $f(x)$). Move anything taller into display math.
- Never use \\( \\) or \\[ \\] delimiters. The renderer is MathJax: amsmath/amssymb environments work (aligned, cases, pmatrix, gathered); TikZ, \\label/\\ref and macros defined in one block and used in another do not.
- Markdown headings, lists, **bold**, \`code\` and fenced code blocks render well. Avoid tables.

When the user attaches images or PDFs (problem sheets, lecture notes, handwritten work), read them carefully. If the handwriting or a symbol is ambiguous, say what you read it as before relying on it.

Be rigorous: state assumptions, don't skip steps that a student would need, and check the final result (substitute back, test a special case, or check dimensions) when it's cheap to do so.`;

// One question and (once answered) its reply. The history is provider-neutral so the model can be
// switched mid-conversation; Claude replies also keep their raw content blocks (thinking included),
// which are replayed unchanged to Claude on later turns.
export interface Turn {
  text: string;
  attachments: Attachment[];
  reply?: { text: string; model: string; claudeContent?: Anthropic.Beta.BetaContentBlock[] };
}

export interface SendOptions {
  model: string; // "claude-…" or "local:<LM Studio model id>"
  effort: Effort;
  showThinking: boolean;
  signal: AbortSignal;
}

export interface TurnCallbacks {
  onThinkingStart?: () => void;
  onThinking?: (delta: string) => void;
  onText: (delta: string) => void;
  onNotice?: (text: string) => void; // e.g. "PDF has no text layer"
}

export interface RunResult {
  stopReason: string | null;
  refused?: string; // refusal category / explanation
  servedBy: string;
  aborted: boolean;
  reply?: Turn["reply"]; // absent when refused or aborted before any text
  costUsd: number;
  contextTokens?: number; // tokens the conversation now occupies (prompt + reply)
  contextWindow?: number;
}

export interface Backend {
  run(turns: Turn[], opts: SendOptions, cb: TurnCallbacks): Promise<RunResult>;
}

export const isLocalModel = (model: string) => model.startsWith("local:");
export const localModelId = (model: string) => model.replace(/^local:/, "");
