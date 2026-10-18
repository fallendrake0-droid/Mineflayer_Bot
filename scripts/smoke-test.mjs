/**
 * MineControl smoke test.
 *
 * Boots the built API server on a scratch port and verifies the REST API,
 * the WebSocket snapshot stream and the /viewer proxy — without needing a
 * Minecraft server. Run `pnpm run build` first, then `pnpm run smoke`.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 5099;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(label, ok, extra = "") {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 20_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/healthz`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  return false;
}

async function main() {
  console.log("Starting API server…");
  const server = spawn(
    "node",
    ["--enable-source-maps", path.join(root, "artifacts/api-server/dist/index.mjs")],
    {
      env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  try {
    check("server becomes healthy", await waitForHealth(), serverLog.slice(-300));

    const status = await (await fetch(`${BASE}/api/bot/status`)).json();
    check("GET /api/bot/status", status.connected === false && status.connectionState === "disconnected");
    check("status includes session stats", typeof status.stats?.blocksMined === "number");
    check("status includes viewer info", status.viewerPath === "/viewer/");

    const settings = await (await fetch(`${BASE}/api/bot/settings`)).json();
    check("GET /api/bot/settings", typeof settings.autoEat === "boolean");

    const updated = await (
      await fetch(`${BASE}/api/bot/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ antiAfk: true, autoEatThreshold: 12 }),
      })
    ).json();
    check("PUT /api/bot/settings", updated.antiAfk === true && updated.autoEatThreshold === 12);

    const cmdRes = await fetch(`${BASE}/api/bot/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "mine", resource: "diamond" }),
    });
    check("command without bot => 400", cmdRes.status === 400);

    const badConnect = await fetch(`${BASE}/api/bot/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "", username: "" }),
    });
    check("connect validation => 400", badConnect.status === 400);

    const inventory = await (await fetch(`${BASE}/api/bot/inventory`)).json();
    check("GET /api/bot/inventory", Array.isArray(inventory.items));

    const viewerRes = await fetch(`${BASE}/viewer/`);
    check(
      "GET /viewer/ proxy responds (502 offline page, or 200 if a viewer is up)",
      viewerRes.status === 502 || viewerRes.status === 200,
      `status ${viewerRes.status}`,
    );

    // WebSocket snapshot stream
    const messages = await new Promise((resolve) => {
      const got = [];
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const done = () => {
        try {
          ws.close();
        } catch {}
        resolve(got);
      };
      ws.onmessage = (ev) => {
        try {
          got.push(JSON.parse(ev.data).type);
        } catch {}
        if (got.length >= 4) done();
      };
      ws.onerror = done;
      setTimeout(done, 5000);
    });
    check(
      "WS /ws sends status+logs+inventory+settings snapshot",
      ["status", "logs", "inventory", "settings"].every((t) => messages.includes(t)),
      `got: ${messages.join(", ")}`,
    );
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    server.kill("SIGKILL");
  }

  if (failures > 0) {
    console.log(`\nSMOKE TEST FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("\nSMOKE TEST PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
