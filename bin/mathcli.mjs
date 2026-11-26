#!/usr/bin/env node
// Launcher: run the precompiled build (dist/) with plain Node; fall back to the TypeScript
// source via tsx only when there is no build (e.g. a fresh git checkout before `npm run build`).
import { existsSync } from "node:fs";

const dist = new URL("../dist/cli.js", import.meta.url);
if (existsSync(dist)) {
  await import(dist.href);
} else {
  let register;
  try {
    ({ register } = await import("tsx/esm/api"));
  } catch {
    console.error("mathcli: no build found (dist/cli.js) and tsx is not installed.\nRun `npm install` (or `npm run build`) in the math-cli directory first.");
    process.exit(1);
  }
  register();
  await import("../src/cli.ts");
}
