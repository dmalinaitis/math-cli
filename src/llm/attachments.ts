// Turn local files into Claude content blocks: images, PDFs (native document input), and text/LaTeX sources.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

type Block = Anthropic.Beta.BetaImageBlockParam | Anthropic.Beta.BetaRequestDocumentBlock;

export interface Attachment {
  path: string;
  name: string;
  kind: "image" | "pdf" | "text";
  bytes: number;
  block: Block;
}

const IMAGE_TYPES: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const TEXT_EXTS = new Set([".txt", ".md", ".tex", ".bib", ".csv", ".json", ".py", ".m", ".r", ".jl", ".ts", ".js", ".sty"]);
const MAX_IMAGE = 5 * 1024 * 1024; // API per-image limit
const MAX_PDF = 30 * 1024 * 1024; // keep under the 32 MB request limit

export class AttachmentError extends Error {}

export function unquotePath(p: string): string {
  return p.trim().replace(/^["']|["']$/g, "").replace(/^file:\/\/\/?/, "");
}

export function isAttachablePath(p: string): boolean {
  const full = resolve(unquotePath(p));
  if (!existsSync(full) || !statSync(full).isFile()) return false;
  const ext = extname(full).toLowerCase();
  return ext in IMAGE_TYPES || ext === ".pdf" || TEXT_EXTS.has(ext);
}

export function loadAttachment(raw: string): Attachment {
  const path = resolve(unquotePath(raw));
  if (!existsSync(path)) throw new AttachmentError(`file not found: ${raw}`);
  const st = statSync(path);
  if (!st.isFile()) throw new AttachmentError(`not a file: ${raw}`);
  const ext = extname(path).toLowerCase();
  const name = basename(path);

  if (ext in IMAGE_TYPES) {
    if (st.size > MAX_IMAGE) throw new AttachmentError(`${name} is over 5 MB — resize or crop it first`);
    return {
      path, name, kind: "image", bytes: st.size,
      block: { type: "image", source: { type: "base64", media_type: IMAGE_TYPES[ext], data: readFileSync(path).toString("base64") } },
    };
  }
  if (ext === ".pdf") {
    if (st.size > MAX_PDF) throw new AttachmentError(`${name} is over 30 MB`);
    return {
      path, name, kind: "pdf", bytes: st.size,
      block: { type: "document", title: name, source: { type: "base64", media_type: "application/pdf", data: readFileSync(path).toString("base64") } },
    };
  }
  if (TEXT_EXTS.has(ext)) {
    return {
      path, name, kind: "text", bytes: st.size,
      block: { type: "document", title: name, source: { type: "text", media_type: "text/plain", data: readFileSync(path, "utf8") } },
    };
  }
  throw new AttachmentError(`unsupported file type ${ext || "(none)"} — use png/jpg/gif/webp, pdf, or text/LaTeX`);
}

// Pull @file references out of a prompt: @notes.pdf, @"C:\path with spaces\sheet.png"
const AT_REF = /(^|\s)@("([^"]+)"|'([^']+)'|(\S+))/g;

export function extractRefs(input: string): { text: string; refs: string[] } {
  const refs: string[] = [];
  const text = input.replace(AT_REF, (m, lead, _q, dq, sq, bare) => {
    const p = dq ?? sq ?? bare;
    if (!isAttachablePath(p)) return m; // leave e.g. "@everyone" or typos in place; caller reports missing files
    refs.push(p);
    return lead;
  });
  return { text: text.trim(), refs };
}
