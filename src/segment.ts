// Split LLM markdown into prose and display-math blocks. Inline $...$ stays inside prose.
export type Segment = { kind: "text"; text: string } | { kind: "display"; tex: string };

const DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;

export function segment(md: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of md.matchAll(DISPLAY)) {
    if (m.index! > last) out.push({ kind: "text", text: md.slice(last, m.index) });
    out.push({ kind: "display", tex: (m[1] ?? m[2]).trim() });
    last = m.index! + m[0].length;
  }
  if (last < md.length) out.push({ kind: "text", text: md.slice(last) });
  return out;
}

// $...$ or \(...\) inside a line of prose. A lone "$5" price shouldn't match: require no space after the opening $.
export const INLINE = /\$(?!\s)((?:\\\$|[^$\n])+?)\$|\\\(([\s\S]+?)\\\)/g;
