// Detached helper run by mathcli on exit: undo what the session did in LM Studio.
//   node lmstudio-cleanup.mjs <lms path> <log file> '<json: [["unload","id"], ["server","stop"], ["quit-app"]]>'
// It runs as its own process so it survives the terminal window closing.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const [lms, log, json] = process.argv.slice(2);
// Full paths: on Windows a bare name is looked up in the current directory first.
const sys32 = (exe) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
try { mkdirSync(dirname(log), { recursive: true }); } catch { /* ignore */ }
const say = (s) => {
  try { appendFileSync(log, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ }
};

for (const cmd of JSON.parse(json)) {
  if (cmd[0] === "quit-app") {
    // Ask politely first (lets LM Studio save its state/index), then force it.
    const kill = (force) =>
      spawnSync(sys32("taskkill.exe"), ["/IM", "LM Studio.exe", "/T", ...(force ? ["/F"] : [])], { encoding: "utf8", windowsHide: true, timeout: 15000 });
    let r = { status: 0, stdout: "skipped (not Windows)" };
    const running = () =>
      (spawnSync(sys32("tasklist.exe"), ["/FI", "IMAGENAME eq LM Studio.exe", "/NH"], { encoding: "utf8", windowsHide: true, timeout: 3000 }).stdout ?? "")
        .includes("LM Studio.exe");
    if (process.platform === "win32") {
      r = kill(false);
      // It may only hide to the tray: give it ~5 s to exit, then force it.
      for (let i = 0; i < 10 && r.status === 0 && running(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (r.status !== 0 || running()) r = kill(true);
    }
    say(`quit LM Studio: ${r.status === 0 ? "ok" : (r.stderr || r.stdout || "").trim()}`);
  } else {
    const r = spawnSync(lms, cmd, { encoding: "utf8", windowsHide: true, timeout: 30000 });
    say(`lms ${cmd.join(" ")}: ${r.status === 0 ? "ok" : (r.stderr || r.stdout || String(r.error)).trim()}`);
  }
}
