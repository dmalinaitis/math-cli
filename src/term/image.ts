// Emit a PNG at the cursor using a terminal graphics protocol, sized in whole cells.
import type { GraphicsProtocol } from "./caps.js";

export function imageEscape(png: Buffer, cols: number, rows: number, proto: GraphicsProtocol): string {
  const b64 = png.toString("base64");
  if (proto === "iterm2") {
    return `\x1b]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1:${b64}\x07`;
  }
  if (proto === "kitty") {
    // Kitty wants the payload in <=4096-byte chunks; C=0 lets the cursor move past the image.
    const chunks = b64.match(/.{1,4096}/g) ?? [];
    return chunks
      .map((c, i) => {
        const more = i < chunks.length - 1 ? 1 : 0;
        const head = i === 0 ? `a=T,f=100,q=2,c=${cols},r=${rows},m=${more}` : `m=${more}`;
        return `\x1b_G${head};${c}\x1b\\`;
      })
      .join("");
  }
  return "";
}

// An image `rows` tall starting at column `indent`, leaving the cursor at the start of the line after it.
export function imageBlock(png: Buffer, cols: number, rows: number, proto: GraphicsProtocol, indent: number): string {
  return (
    // Reserve the vertical space first so the image never scrolls itself off the top.
    "\n".repeat(rows) + `\x1b[${rows}A` +
    // Terminals disagree on where the cursor ends up after an image, so save/restore it.
    "\x1b7" + " ".repeat(indent) + imageEscape(png, cols, rows, proto) + "\x1b8" +
    `\r\x1b[${rows}B`
  );
}

export function printImage(png: Buffer, cols: number, rows: number, proto: GraphicsProtocol, indent: number): void {
  process.stdout.write(imageBlock(png, cols, rows, proto, indent));
}
