// Text measurement, plus inline-image placeholders.
//
// An inline image travels through markdown formatting and word wrapping as a short placeholder token
// (two private-use characters around an id). visibleLen counts it as the image's width in cells, so
// wrapping stays exact; expandLine swaps it for the real escape sequence when the line is printed.

const OPEN = "", CLOSE = "";
const PLACEHOLDER = /(\d+)/g;
const images: { esc: string; cols: number }[] = [];
const ids = new Map<string, number>();

export function placeholder(esc: string, cols: number): string {
  let id = ids.get(esc);
  if (id === undefined) {
    id = images.push({ esc, cols }) - 1;
    ids.set(esc, id);
  }
  return OPEN + id + CLOSE;
}

// Visible width: strip ANSI, ignore combining marks (x̂, v⃗), count code points; placeholders count as their image width.
export function visibleLen(s: string): number {
  s = s.replace(PLACEHOLDER, (_m, id) => "x".repeat(images[Number(id)].cols));
  return [...s.replace(/\x1b\[[\d;]*m/g, "").replace(/\p{M}/gu, "")].length;
}

// Replace placeholders in a line (which starts at column 1) with the image escape, then put the cursor
// explicitly after the image — terminals differ on where an inline image leaves it.
export function expandLine(line: string): string {
  return line.replace(PLACEHOLDER, (_m, id, offset: number) => {
    const img = images[Number(id)];
    const col = visibleLen(line.slice(0, offset)); // 0-based column where the image starts
    return `${img.esc}\x1b[${col + img.cols + 1}G`;
  });
}

// Forget every inline image (e.g. on /clear). Only call between answers: placeholders already handed out become invalid.
export function clearImagePlaceholders(): void {
  images.length = 0;
  ids.clear();
}
