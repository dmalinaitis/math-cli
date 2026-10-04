#!/usr/bin/env node
// Launcher: run the TypeScript source directly via tsx, from any directory.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
