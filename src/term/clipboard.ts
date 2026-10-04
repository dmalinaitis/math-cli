// System clipboard access. Terminals only paste text (Ctrl+Shift+V in WezTerm); reading the clipboard
// ourselves on Ctrl+V also lets us accept screenshots and files copied in Explorer as attachments.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClipboardContent =
  | { kind: "text"; text: string }
  | { kind: "image"; path: string }
  | { kind: "files"; paths: string[] }
  | { kind: "empty" };

const clipDir = () => {
  const dir = join(tmpdir(), "mathcli-clipboard");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const ps = (script: string) =>
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script], { encoding: "utf8", timeout: 5000 });

export function readClipboard(): ClipboardContent {
  if (process.platform === "win32") {
    const png = join(clipDir(), `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    const r = ps(`
      [Console]::OutputEncoding = [Text.Encoding]::UTF8
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $c = [System.Windows.Forms.Clipboard]
      if ($c::ContainsFileDropList()) { 'FILES'; $c::GetFileDropList() }
      elseif ($c::ContainsImage()) { $c::GetImage().Save('${png}', [System.Drawing.Imaging.ImageFormat]::Png); 'IMAGE' }
      elseif ($c::ContainsText()) { 'TEXT'; $c::GetText() }
      else { 'EMPTY' }`);
    if (r.status !== 0 || !r.stdout) return { kind: "empty" };
    const [head, ...rest] = r.stdout.replace(/\r\n/g, "\n").split("\n");
    if (head === "IMAGE") return { kind: "image", path: png };
    if (head === "FILES") return { kind: "files", paths: rest.filter(Boolean) };
    if (head === "TEXT") return { kind: "text", text: rest.join("\n").replace(/\n$/, "") };
    return { kind: "empty" };
  }
  const cmd = process.platform === "darwin" ? ["pbpaste"] : ["xclip", "-selection", "clipboard", "-o"];
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  return r.status === 0 && r.stdout ? { kind: "text", text: r.stdout } : { kind: "empty" };
}

export function writeClipboard(text: string): boolean {
  if (process.platform === "win32") {
    const file = join(mkdtempSync(join(tmpdir(), "mathcli-")), "clip.txt");
    writeFileSync(file, text, "utf8");
    return ps(`Get-Content -Raw -Encoding UTF8 '${file}' | Set-Clipboard`).status === 0;
  }
  const cmd = process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
  return spawnSync(cmd[0], cmd.slice(1), { input: text }).status === 0;
}
