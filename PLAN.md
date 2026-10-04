# Math CLI — plan

A terminal chat for university-level maths where LaTeX is typeset properly, in the style of
Codex CLI's math rendering.

## Decisions
- **Terminal:** WezTerm (Windows). Images via the iTerm2 protocol (on by default in WezTerm);
  Kitty protocol also implemented for Kitty/Ghostty.
- **Language:** TypeScript on Node 22. MathJax runs in-process (no TeX install), resvg rasterises.
- **Rendering split:** display math `$$…$$` → image sized to the terminal's cell grid and coloured
  to its foreground; inline `$…$` → Unicode text when exact (𝐮, ∇, x², ℝⁿ), else a one-row typeset
  image. Unparseable LaTeX falls back to source.
- **Models:** Claude first (native image + PDF input), default Opus 5.5. Then OpenAI, then local models via
  LM Studio's OpenAI-compatible server (already installed).
- **Local on RTX 5080 16 GB:** Qwen3-30B-A3B at Q4 (MoE, a few layers on CPU) or a ~14B dense
  model for maths reasoning; Qwen-VL ~7–8B for images/handwriting. Good for coursework,
  weaker than frontier on long proofs → keep Claude as the default for hard problems.

## Phases
0. **Rendering spike** ✅ — `npm run spike` in WezTerm; `npm run render` writes PNGs.
1. **MVP** ✅ — `mathcli`: streaming chat with Claude (Opus 5.5, effort high, server-side refusal
   fallback), streaming markdown + math renderer, `@file` / drag-drop / `/attach` for images, PDFs,
   .tex; live prompt box + status line with running cost; `/model` `/effort` `/thinking` `/scale`
   `/copy` `/copy-latex` `/clear` `/key`.
1b. **Inline maths** ✅ — exact Unicode stays text; anything else (sub/superscripts Unicode can't express,
   fractions, roots) becomes a one-row typeset image on the text baseline. `/inline auto|image|unicode`.
2. **Local models** ✅ — LM Studio (OpenAI-compatible API): `/model local|<name>`, live model list with
   vision/context/loaded state, auto-starts the server, images to vision models, PDFs as extracted text,
   provider-neutral history (switch models mid-chat), context meter in the status line.
2b. **Compaction** (next) — summarise older turns as the meter nears the limit (Claude: server-side
   compaction beta; local: client-side summary). OpenAI as a provider if wanted.
3. **Customisation** ✅ — themes (royal default, white, midnight, mocha, custom JSON in ~/.mathcli/themes),
   `/theme`, `/opacity`, `/blur`; WezTerm window background/gradient/opacity/acrylic via a SetUserVar
   bridge (`scripts/wezterm-mathcli.lua`, enabled by `/setup-terminal`).
4. **Extras** — export (.md/.tex/PDF), equation numbering, SymPy step-checking tool, re-render on resize, inline plots.

## Layout
- `src/math/render.ts` LaTeX → SVG → PNG, padded to whole cells, cached
- `src/math/unicode.ts` inline LaTeX → Unicode
- `src/term/caps.ts` terminal queries (cell px, fg/bg, protocol)
- `src/term/image.ts` iTerm2 / Kitty image escapes
- `src/segment.ts` split markdown into prose / display math
