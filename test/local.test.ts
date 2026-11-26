// LM Studio backend: think-tag splitting, model discovery across API versions, loopback detection.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { LocalAuthError, LocalServerDown, ThinkSplitter, isLoopbackUrl, listLocalModels, normalizeBaseUrl } from "../src/llm/local.js";

function split(chunks: string[]) {
  let text = "", think = "";
  const s = new ThinkSplitter((x) => (text += x), (x) => (think += x));
  for (const c of chunks) s.push(c);
  s.flush();
  return { text, think };
}

test("ThinkSplitter: whole tags", () => {
  assert.deepEqual(split(["<think>secret</think>answer"]), { text: "answer", think: "secret" });
});

test("ThinkSplitter: tags split across chunks", () => {
  assert.deepEqual(split(["<thi", "nk>x</thi", "nk>answer"]), { text: "answer", think: "x" });
  assert.deepEqual(split(["<think>secret", "</thi", "nk>answer"]), { text: "answer", think: "secret" });
  assert.deepEqual(split(["<", "think>a<", "/think>b"]), { text: "b", think: "a" });
});

test("ThinkSplitter: char by char gives the same result", () => {
  const all = "pre <think>step 1 < 2</think>The answer is $x<y$.";
  assert.deepEqual(split([...all]), split([all]));
  assert.deepEqual(split([all]), { text: "pre The answer is $x<y$.", think: "step 1 < 2" });
});

test("ThinkSplitter: stray leading </think> (prefilled <think>) is dropped", () => {
  assert.deepEqual(split(["</think>answer"]), { text: "answer", think: "" });
  assert.deepEqual(split(["</thi", "nk>\n\nanswer"]), { text: "\n\nanswer", think: "" });
});

test("ThinkSplitter: a lone '<' at the end is flushed as text", () => {
  assert.deepEqual(split(["a <"]), { text: "a <", think: "" });
});

test("isLoopbackUrl", () => {
  for (const u of ["http://localhost:1234", "http://127.0.0.1:1234/", "http://[::1]:1234", "http://127.1.2.3"]) assert.ok(isLoopbackUrl(u), u);
  for (const u of ["http://100.64.0.5:1234", "http://my-pc.tailnet.ts.net:1234", "http://192.168.1.10:1234", "not a url"]) assert.ok(!isLoopbackUrl(u), u);
  assert.equal(normalizeBaseUrl("http://localhost:1234//"), "http://localhost:1234");
});

// ---- listLocalModels against a mock server ------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler = (_req, res) => res.writeHead(404).end();
let base = "";
const server = createServer((req, res) => handler(req, res));
const json = (res: ServerResponse, body: unknown, status = 200) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`; // trailing slash: must be normalised
});
after(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

test("listLocalModels: LM Studio 0.4+ /api/v1/models", async () => {
  const seen: string[] = [];
  handler = (req, res) => {
    seen.push(req.url!);
    if (req.url !== "/api/v1/models") return res.writeHead(404).end();
    json(res, {
      models: [
        { type: "llm", key: "qwen/qwen3-8b", max_context_length: 40960, loaded_instances: [{ id: "qwen/qwen3-8b", config: { context_length: 8192 } }], capabilities: { vision: false } },
        { type: "vlm", key: "google/gemma-3-12b", max_context_length: 131072, loaded_instances: [] },
        { type: "llm", key: "plain", capabilities: { vision: true } },
        { type: "embedding", key: "nomic-embed" },
      ],
    });
  };
  assert.deepEqual(await listLocalModels(base), [
    { id: "qwen/qwen3-8b", vision: false, loaded: true, contextLength: 8192 },
    { id: "google/gemma-3-12b", vision: true, loaded: false, contextLength: 131072 },
    { id: "plain", vision: true, loaded: false, contextLength: 32768 },
  ]);
  assert.deepEqual(seen, ["/api/v1/models"]);
});

test("listLocalModels: falls back to legacy /api/v0/models", async () => {
  handler = (req, res) => {
    if (req.url !== "/api/v0/models") return res.writeHead(404).end();
    json(res, {
      data: [
        { id: "mistral", type: "llm", state: "loaded", loaded_context_length: 4096, max_context_length: 32768 },
        { id: "llava", type: "vlm", state: "not-loaded", max_context_length: 8192 },
        { id: "embed", type: "embeddings" },
      ],
    });
  };
  assert.deepEqual(await listLocalModels(base), [
    { id: "mistral", vision: false, loaded: true, contextLength: 4096 },
    { id: "llava", vision: true, loaded: false, contextLength: 8192 },
  ]);
});

test("listLocalModels: falls back to OpenAI-compatible /v1/models", async () => {
  handler = (req, res) => {
    if (req.url === "/api/v1/models") return json(res, { models: [] }); // valid but empty
    if (req.url !== "/v1/models") return res.writeHead(404).end();
    json(res, { data: [{ id: "qwen2.5-vl-7b" }, { id: "llama-3.1-8b" }, { id: "text-embedding-nomic" }] });
  };
  assert.deepEqual(await listLocalModels(base), [
    { id: "qwen2.5-vl-7b", vision: true, loaded: true, contextLength: 32768 },
    { id: "llama-3.1-8b", vision: false, loaded: true, contextLength: 32768 },
  ]);
});

test("listLocalModels: strips control characters from model ids", async () => {
  handler = (req, res) => {
    if (req.url !== "/api/v1/models") return res.writeHead(404).end();
    json(res, { models: [{ type: "llm", key: "evil\x1b]52;c;eA==\x07-model" }] });
  };
  assert.deepEqual((await listLocalModels(base)).map((m) => m.id), ["evil]52;c;eA==-model"]);
});

test("listLocalModels: sends LM_API_TOKEN as a bearer token", async () => {
  let auth: string | undefined;
  handler = (req, res) => { auth = req.headers.authorization; json(res, { models: [] }); };
  process.env.LM_API_TOKEN = "tok123";
  try {
    await listLocalModels(base);
  } finally {
    delete process.env.LM_API_TOKEN;
  }
  assert.equal(auth, "Bearer tok123");
});

test("listLocalModels: 401 is an auth error, not 'no models'", async () => {
  handler = (_req, res) => json(res, { error: "unauthorized" }, 401);
  await assert.rejects(listLocalModels(base), LocalAuthError);
});

test("listLocalModels: 503 means the server is down", async () => {
  handler = (_req, res) => res.writeHead(503).end();
  await assert.rejects(listLocalModels(base), LocalServerDown);
});

test("listLocalModels: unreachable server", async () => {
  // Bind then close to get a port nothing listens on.
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  await assert.rejects(listLocalModels(`http://127.0.0.1:${port}`, 500), LocalServerDown);
});

test("listLocalModels: a hung server times out as down", async () => {
  handler = () => {}; // never answers
  await assert.rejects(listLocalModels(base, 200), LocalServerDown);
});
