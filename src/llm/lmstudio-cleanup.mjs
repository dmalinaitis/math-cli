// Detached helper run by mathcli on exit: undo what the session did in LM Studio.
//   node lmstudio-cleanup.mjs <lms path> <log file> '<json: [["unload","id"], ["server","stop"], ["quit-app"]]>'
// It runs as its own process so it survives the terminal window closing.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const [lms, log, json] = process.argv.slice(2);
const say = (s) => {
  try { appendFileSync(log, `${new Date().toISOString()} ${s}\n`); } catch { /* ignore */ }
};

for (const cmd of JSON.parse(json)) {
  if (cmd[0] === "quit-app") {
    const r = process.platform === "win32"
      ? spawnSync("taskkill", ["/IM", "LM Studio.exe", "/T", "/F"], { encoding: "utf8", windowsHide: true })
      : { status: 0, stdout: "skipped (not Windows)" };
    say(`quit LM Studio: ${r.status === 0 ? "ok" : (r.stderr || r.stdout || "").trim()}`);
  } else {
    const r = spawnSync(lms, cmd, { encoding: "utf8", windowsHide: true, timeout: 30000 });
    say(`lms ${cmd.join(" ")}: ${r.status === 0 ? "ok" : (r.stderr || r.stdout || String(r.error)).trim()}`);
  }
}
