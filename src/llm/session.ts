// The conversation: provider-neutral history, routed per message to Claude or a local model.
import { readFileSync } from "node:fs";
import { ClaudeBackend, claudeContextWindow } from "./claude.js";
import { LocalBackend } from "./local.js";
import type { Attachment } from "./attachments.js";
import { isLocalModel, type RunResult, type SendOptions, type Turn, type TurnCallbacks } from "./types.js";

export class Session {
  turns: Turn[] = [];
  costUsd = 0;
  contextTokens = 0; // how much of the context window the conversation occupies after the last reply
  contextWindow?: number;

  constructor(readonly claude: ClaudeBackend, readonly local: LocalBackend) {}

  reset() {
    this.turns = [];
    this.contextTokens = 0;
  }

  // Context window of a model, for the meter before any reply has reported one.
  windowFor(model: string): number | undefined {
    if (!isLocalModel(model)) return claudeContextWindow(model);
    return this.local.models.find((m) => `local:${m.id}` === model)?.contextLength;
  }

  async send(text: string, attachments: Attachment[], opts: SendOptions, cb: TurnCallbacks): Promise<RunResult> {
    const turn: Turn = { text, attachments };
    this.turns.push(turn);
    try {
      const r = process.env.MATHCLI_FAKE_ANSWER
        ? await fakeRun(opts, cb)
        : await (isLocalModel(opts.model) ? this.local : this.claude).run(this.turns, opts, cb);
      if (r.reply && !r.aborted) turn.reply = r.reply;
      else this.turns.pop(); // refused or interrupted: drop the unanswered question
      this.costUsd += r.costUsd;
      if (r.contextTokens !== undefined) this.contextTokens = r.contextTokens;
      if (r.contextWindow) this.contextWindow = r.contextWindow;
      return r;
    } catch (e) {
      this.turns.pop();
      throw e;
    }
  }
}

// Dev: MATHCLI_FAKE_ANSWER=<file.md> replays a canned answer instead of calling a model.
async function fakeRun(opts: SendOptions, cb: TurnCallbacks): Promise<RunResult> {
  const answer = readFileSync(process.env.MATHCLI_FAKE_ANSWER!, "utf8");
  for (let i = 0; i < answer.length && !opts.signal.aborted; i += 8) {
    cb.onText(answer.slice(i, i + 8));
    await new Promise((r) => setTimeout(r, 40));
  }
  return { stopReason: "end_turn", servedBy: opts.model, aborted: opts.signal.aborted, reply: { text: answer, model: opts.model }, costUsd: 0, contextTokens: 1200 };
}
