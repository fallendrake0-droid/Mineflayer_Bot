// Brain heartbeat / STOP-abort / parse-retry tests with a slow stub LLM.
// Run: cd artifacts/api-server && ../../scripts/node_modules/.bin/tsx ../../tests/brain-tests.cts
import * as http from "node:http";
import * as fs from "node:fs";
import { AiClient } from "../artifacts/api-server/src/lib/ai-client";
import { AiBrain } from "../artifacts/api-server/src/lib/ai-brain";
import { SkillLibrary } from "../artifacts/api-server/src/lib/ai-skills";

let pass = 0, fail = 0;
const t = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

const PLAN = JSON.stringify({ reasoning: "done thinking", steps: [], done: true });

async function stub(mode: "slow" | "garbage", delayMs = 0) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.on("error", () => {});
      const timer = setTimeout(() => {
        if (res.destroyed || res.writableEnded) return;
        try {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ message: { content: mode === "garbage" ? "Sure! Let me think about that for a while..." : PLAN } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }));
        } catch { /* socket already gone */ }
      }, delayMs);
      timer.unref?.();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  return { port, hits: () => hits, close: () => server.close() };
}

function mockHost(logs: string[]) {
  return {
    isConnected: () => true,
    shouldAbort: () => false,
    getContext: () => ({ position: { x: 0, y: 64, z: 0 }, health: 20, food: 20 }),
    executeAction: async (action: string) => ({ action, ok: true, detail: "ok" }),
    runSkill: async () => ({ action: "runSkill", ok: true, detail: "ok" }),
    say: () => {},
    log: (m: string) => { logs.push(m); },
    recentLogLines: () => [] as string[],
  } as any;
}

function mkBrain(port: number, logs: string[]) {
  const client = new AiClient(() => ({ apiKey: null, baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-1" }));
  const skills = new SkillLibrary("/tmp/brain-test-skills.json");
  return { brain: new AiBrain(client, skills, mockHost(logs)), client };
}

async function main() {
  fs.rmSync("/tmp/brain-test-skills.json", { force: true });

  {
    const s = await stub("slow", 10);
    const client = new AiClient(() => ({ apiKey: null, baseUrl: `http://127.0.0.1:${s.port}/v1`, model: "fake-1" }));
    const ctl = new AbortController();
    ctl.abort();
    let msg = "";
    try { await client.chat([{ role: "user", content: "x" }], { signal: ctl.signal }); } catch (e: any) { msg = e.message; }
    t("client: pre-aborted signal, no request made", /aborted by user/.test(msg) && s.hits() === 0);
    s.close();
  }

  {
    const s = await stub("slow", 10_000);
    const client = new AiClient(() => ({ apiKey: null, baseUrl: `http://127.0.0.1:${s.port}/v1`, model: "fake-1" }));
    const ctl = new AbortController();
    const start = Date.now();
    const p = client.chat([{ role: "user", content: "x" }], { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 250);
    let msg = "";
    try { await p; } catch (e: any) { msg = e.message; }
    t("client: mid-flight abort is fast + not retried", /aborted by user/.test(msg) && Date.now() - start < 3000 && s.hits() === 1);
    s.close();
  }

  {
    const s = await stub("slow", 6500);
    const logs: string[] = [];
    const { brain } = mkBrain(s.port, logs);
    const { outcome } = await brain.runGoal("test goal", { signal: new AbortController().signal });
    t("brain: slow goal completes", outcome === "done thinking");
    t("brain: thinking heartbeat logged", logs.some((l) => l.includes("AI: thinking")));
    s.close();
  }

  {
    const s = await stub("slow", 60_000);
    const logs: string[] = [];
    const { brain } = mkBrain(s.port, logs);
    const ctl = new AbortController();
    const start = Date.now();
    const p = brain.runGoal("test goal", { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 300);
    const { outcome } = await p;
    t("brain: STOP mid-think -> clean abort, fast", outcome === "aborted" && Date.now() - start < 3000);
    s.close();
  }

  {
    const s = await stub("garbage", 0);
    const logs: string[] = [];
    const { brain } = mkBrain(s.port, logs);
    let msg = "";
    try { await brain.runGoal("test goal", { signal: new AbortController().signal }); } catch (e: any) { msg = e.message; }
    t("brain: garbage x3 -> unparseable error", /unparseable plan three times/.test(msg) && s.hits() === 3);
    t("brain: local-model hint in error", /small local models/.test(msg));
    t("brain: retry attempts logged", logs.some((l) => l.includes("(2/3)")) && logs.some((l) => l.includes("(3/3)")));
    s.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("TEST ERROR", e); process.exit(2); });
