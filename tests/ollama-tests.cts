// AI client tests: local-URL detection, keyless config, retries, OOM/404 hints.
// Run: cd artifacts/api-server && ../../scripts/node_modules/.bin/tsx ../../tests/ollama-tests.cts
import * as http from "node:http";
import { AiClient, isLocalAiBaseUrl } from "../artifacts/api-server/src/lib/ai-client";
import { sanitizeMovePacketParams } from "../artifacts/api-server/src/lib/bot-utils";

let pass = 0, fail = 0;
const t = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

for (const [u, exp] of [
  ["http://localhost:11434/v1", true],
  ["http://127.0.0.1:11434/v1", true],
  ["http://[::1]:1234/v1", true],
  ["http://192.168.1.50:11434/v1", true],
  ["http://10.0.0.5:11434/v1", true],
  ["http://172.20.0.2:11434/v1", true],
  ["http://172.32.0.2:11434/v1", false],
  ["http://my-pc.local:11434/v1", true],
  ["https://generativelanguage.googleapis.com/v1beta/openai", false],
  ["https://api.openai.com/v1", false],
  ["not-a-url", false],
] as Array<[string, boolean]>) {
  t(`isLocal ${u} -> ${exp}`, isLocalAiBaseUrl(u) === exp);
}

const mk = (cfg: any) => new AiClient(() => cfg);
t("configured: key+cloud", mk({ apiKey: "k", baseUrl: "https://api.openai.com/v1", model: "m" }).configured === true);
t("configured: no key+cloud", mk({ apiKey: null, baseUrl: "https://api.openai.com/v1", model: "m" }).configured === false);
t("configured: no key+local (Ollama)", mk({ apiKey: null, baseUrl: "http://localhost:11434/v1", model: "m" }).configured === true);

const FB = { x: 10, y: 65, z: -20, yaw: 1.5, pitch: 0.2 };
const bigYaw: any = { yaw: 725, pitch: 120 };
const rep = sanitizeMovePacketParams("look", bigYaw, FB);
t("normalize: values fixed but not flagged repaired", rep === false && bigYaw.yaw === 5 && bigYaw.pitch === 90);
const nanYaw: any = { yaw: NaN, pitch: 0 };
t("normalize: NaN still flagged repaired", sanitizeMovePacketParams("look", nanYaw, FB) === true && nanYaw.yaw === 1.5);

async function main() {
  let hits = 0;
  let lastAuth = "";
  let mode: "flaky503" | "bad400" | "oom" | "notfound" | "ok" = "flaky503";
  const server = http.createServer((req, res) => {
    hits++;
    lastAuth = String(req.headers.authorization ?? "");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (mode === "flaky503" && hits < 3) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "high demand" }));
        return;
      }
      if (mode === "bad400") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad request" }));
        return;
      }
      if (mode === "oom") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "llama-server reported out-of-memory during startup: ggml_aligned_malloc: insufficient memory (attempted to allocate 4685.30 MB)\nggml_backend_cpu_buffer_type_alloc_buffer: failed to allocate buffer of size 4912898304" } }));
        return;
      }
      if (mode === "notfound") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: 'model "fake-1" not found, try pulling it first' } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"say":"hi","done":true,"steps":[]}' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  const client = mk({ apiKey: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-1" });

  const out = await client.chat([{ role: "user", content: "hi" }]);
  t("retry: 503 x2 then success (3 hits)", hits === 3 && out.content.includes('"done":true'));
  t("keyless local sends Bearer local", lastAuth === "Bearer local");

  mode = "bad400"; hits = 0;
  let threw400 = false;
  try { await client.chat([{ role: "user", content: "hi" }]); } catch (e: any) { threw400 = /HTTP 400/.test(e.message); }
  t("no retry on 400 (1 hit)", threw400 && hits === 1);

  mode = "oom"; hits = 0;
  let oomMsg = "";
  try { await client.chat([{ role: "user", content: "hi" }]); } catch (e: any) { oomMsg = e.message; }
  t("OOM: friendly message", /ran out of memory while loading/.test(oomMsg) && /llama3\.2:3b/.test(oomMsg));
  t("OOM: no retry (1 hit)", hits === 1);

  mode = "notfound"; hits = 0;
  let nfMsg = "";
  try { await client.chat([{ role: "user", content: "hi" }]); } catch (e: any) { nfMsg = e.message; }
  t("404 local: ollama pull hint", /not installed/.test(nfMsg) && /ollama pull fake-1/.test(nfMsg) && hits === 1);

  mode = "ok"; hits = 0;
  const cloud = mk({ apiKey: null, baseUrl: "https://example.invalid/v1", model: "m" });
  let msg = "";
  try { await cloud.chat([{ role: "user", content: "x" }]); } catch (e: any) { msg = e.message; }
  t("no key + cloud rejected pre-flight", /not configured/.test(msg));

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("TEST ERROR", e); process.exit(2); });
