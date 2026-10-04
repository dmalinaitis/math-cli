// Inline math ($...$) is printed as text in the terminal font, so convert simple LaTeX to Unicode.
// Anything we can't express well is left readable rather than dropped.

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "ϕ",
  varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ",
  Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  nabla: "∇", partial: "∂", infty: "∞", cdot: "·", cdots: "⋯", ldots: "…", dots: "…", times: "×",
  div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈",
  equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", cup: "∪",
  cap: "∩", emptyset: "∅", varnothing: "∅", setminus: "∖", forall: "∀", exists: "∃", neg: "¬",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", oplus: "⊕", otimes: "⊗", circ: "∘", ast: "∗", star: "⋆",
  to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", iff: "⇔",
  Leftrightarrow: "⇔", leftrightarrow: "↔", mapsto: "↦", implies: "⟹", uparrow: "↑", downarrow: "↓",
  int: "∫", iint: "∬", iiint: "∭", oint: "∮", sum: "∑", prod: "∏", coprod: "∐",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", vert: "|", Vert: "‖",
  mid: "∣", parallel: "∥", perp: "⊥", angle: "∠", triangle: "△", hbar: "ℏ", ell: "ℓ", Re: "ℜ",
  Im: "ℑ", aleph: "ℵ", prime: "′", degree: "°", dagger: "†", top: "⊤", bot: "⊥",
  quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", "!": "", " ": " ",
  "{": "{", "}": "}", "%": "%", "$": "$", "&": "&", "_": "_", "#": "#",
  left: "", right: "", big: "", Big: "", bigg: "", Bigg: "", displaystyle: "", textstyle: "",
};
const FUNCS = ["sin", "cos", "tan", "sec", "csc", "cot", "sinh", "cosh", "tanh", "arcsin", "arccos",
  "arctan", "log", "ln", "exp", "lim", "sup", "inf", "max", "min", "det", "dim", "ker", "deg", "gcd",
  "arg", "Pr", "tr", "limsup", "liminf"];

const SUP: Record<string, string> = Object.fromEntries(
  [..."0123456789+-=()niabcdefghjklmoprstuvwxyzABDEGHIJKLMNOPRTUVW"].map((c, i) =>
    [c, [..."⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱᵃᵇᶜᵈᵉᶠᵍʰʲᵏˡᵐᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ"][i]]),
);
SUP["′"] = "′";
SUP["−"] = "⁻";
SUP["∗"] = "*";
const SUB: Record<string, string> = Object.fromEntries(
  [..."0123456789+-=()aehijklmnoprstuvx"].map((c, i) => [c, [..."₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"][i]]),
);
SUB["−"] = "₋";

function styled(text: string, base: number, lowerBase?: number, digitBase?: number): string {
  return [...text].map((c) => {
    if (c >= "A" && c <= "Z") return String.fromCodePoint(base + c.charCodeAt(0) - 65);
    if (c >= "a" && c <= "z" && lowerBase !== undefined) return String.fromCodePoint(lowerBase + c.charCodeAt(0) - 97);
    if (c >= "0" && c <= "9" && digitBase !== undefined) return String.fromCodePoint(digitBase + c.charCodeAt(0) - 48);
    return c;
  }).join("");
}
const BB: Record<string, string> = { C: "ℂ", H: "ℍ", N: "ℕ", P: "ℙ", Q: "ℚ", R: "ℝ", Z: "ℤ" };
const FONTS: Record<string, (s: string) => string> = {
  mathbf: (s) => styled(s, 0x1d400, 0x1d41a, 0x1d7ce),
  boldsymbol: (s) => styled(s, 0x1d400, 0x1d41a, 0x1d7ce),
  mathbb: (s) => [...s].map((c) => BB[c] ?? styled(c, 0x1d538, 0x1d552, 0x1d7d8)).join(""),
  mathcal: (s) => styled(s, 0x1d4d0),
  mathfrak: (s) => styled(s, 0x1d56c, 0x1d586),
  mathrm: (s) => s, text: (s) => s, textrm: (s) => s, operatorname: (s) => s, mathit: (s) => s,
};

class Parser {
  i = 0;
  lossy = false; // set when the text only approximates the typeset form (x_(ij), a/b, …)
  constructor(private s: string) {}

  group(): string {
    this.skipWs();
    if (this.s[this.i] === "{") {
      this.i++;
      const out = this.seq("}");
      this.i++;
      return out;
    }
    return this.atom();
  }

  skipWs() {
    while (this.s[this.i] === " ") this.i++;
  }

  // raw text of next {...} (for \text, font names)
  rawGroup(): string {
    this.skipWs();
    if (this.s[this.i] !== "{") return this.s[this.i++] ?? "";
    let depth = 0, start = ++this.i;
    for (; this.i < this.s.length; this.i++) {
      if (this.s[this.i] === "{") depth++;
      else if (this.s[this.i] === "}" && depth-- === 0) break;
    }
    return this.s.slice(start, this.i++);
  }

  script(table: Record<string, string>, mark: string): string {
    const body = this.group();
    const chars = [...body];
    if (chars.every((c) => table[c])) return chars.map((c) => table[c]).join("");
    this.lossy = true;
    // No Unicode sub/superscript form (e.g. Greek subscripts): g_μν reads better than g_(μν).
    return chars.length <= 3 && !/[\s+\-−=]/.test(body) ? mark + body : `${mark}(${body})`;
  }

  atom(): string {
    const c = this.s[this.i];
    if (c === undefined) return "";
    if (c === "\\") {
      this.i++;
      const m = /^([a-zA-Z]+|.)/.exec(this.s.slice(this.i));
      const name = m ? m[1] : "";
      this.i += name.length;
      if (name === "frac" || name === "dfrac" || name === "tfrac") {
        this.lossy = true;
        const a = this.group(), b = this.group();
        const wrap = (x: string) => ([...x].length > 1 && /[+\-−·× ]/.test(x) ? `(${x})` : x);
        return `${wrap(a)}/${wrap(b)}`;
      }
      if (name === "sqrt") {
        const g = this.group();
        if ([...g].length > 1) this.lossy = true;
        return [...g].length > 1 ? `√(${g})` : `√${g}`;
      }
      if (name === "begin") return this.environment(this.rawGroup());
      if (FONTS[name]) {
        const raw = name.startsWith("text") || name === "operatorname";
        const body = raw ? this.rawGroup() : this.group();
        const out = FONTS[name](body);
        // Mathematical Alphanumeric Symbols (𝐯, 𝓛, 𝔤 — U+1D400+) are missing from many terminal fonts,
        // so treat them as approximate: typeset as an image when possible.
        if ([...out].some((ch) => ch.codePointAt(0)! >= 0x1d400)) this.lossy = true;
        return out;
      }
      if (name === "hat") return this.group() + "̂";
      if (name === "bar" || name === "overline") return this.group() + "̅";
      if (name === "vec") return this.group() + "⃗";
      if (name === "dot") return this.group() + "̇";
      if (name === "ddot") return this.group() + "̈";
      if (name === "tilde") return this.group() + "̃";
      if (FUNCS.includes(name)) return name;
      if (name in SYMBOLS) return SYMBOLS[name];
      this.lossy = true;
      return `\\${name}`;
    }
    this.i++;
    if (c === "^") return this.script(SUP, "^");
    if (c === "_") return this.script(SUB, "_");
    if (c === "-") return "−";
    if (c === "'") return "′";
    if (c === "~") return " ";
    return c;
  }

  // \begin{pmatrix} 2 & 1 \\ 1 & 2 \end{pmatrix} → (2 1; 1 2). Always approximate.
  environment(env: string): string {
    this.lossy = true;
    const endTag = `\\end{${env}}`;
    const stop = this.s.indexOf(endTag, this.i);
    const body = this.s.slice(this.i, stop < 0 ? undefined : stop);
    this.i = stop < 0 ? this.s.length : stop + endTag.length;
    const cell = (c: string) => new Parser(c.trim()).seq().replace(/\s+/g, " ").trim();
    const rows = body.split(/\\\\/).map((r) => r.split("&").map(cell)).filter((r) => r.some(Boolean));
    const brackets: Record<string, [string, string]> = {
      pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"],
      matrix: ["", ""], smallmatrix: ["", ""], cases: ["{ ", ""],
    };
    if (env in brackets) {
      const sep = env === "cases" ? ", " : " ";
      const [l, r] = brackets[env];
      return l + rows.map((cells) => cells.join(sep)).join("; ") + r;
    }
    return rows.map((cells) => cells.join("")).join("; "); // aligned, gathered, …
  }

  seq(end?: string): string {
    let out = "";
    while (this.i < this.s.length && this.s[this.i] !== end) out += this.atom();
    return out;
  }
}

export function latexToUnicode(tex: string): string {
  return latexToUnicodeExact(tex).text;
}

// `exact` is false when the text only approximates the typeset form, i.e. it's worth an image instead.
export function latexToUnicodeExact(tex: string): { text: string; exact: boolean } {
  const p = new Parser(tex.trim());
  const text = p.seq().replace(/\s+/g, " ").trim();
  return { text, exact: !p.lossy };
}
