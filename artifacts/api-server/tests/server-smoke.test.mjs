import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const TEST_TOKEN = "ci-dashboard-token-not-for-production";
const entryPoint = fileURLToPath(new URL("../dist/index.mjs", import.meta.url));

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API server exited early (${child.exitCode}): ${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);
      if (response.ok) return;
    } catch {
      // The listener may not have started yet.
    }
    await delay(100);
  }
  throw new Error(`API server did not become healthy in time: ${output()}`);
}

function connectWebSocket(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const opened = new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, opened };
}

test("built API protects bot/AI routes and WebSocket telemetry", async () => {
  const port = await getFreePort();
  const child = spawn(process.execPath, [entryPoint], {
    env: {
      ...process.env,
      PORT: String(port),
      DASHBOARD_TOKEN: TEST_TOKEN,
      AI_PROVIDER: "local",
      MINEFLAYER_COMMAND_ALLOWLIST: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.setEncoding("utf8").on("data", (part) => { output = (output + part).slice(-8000); });
  child.stderr.setEncoding("utf8").on("data", (part) => { output = (output + part).slice(-8000); });

  let deniedSocket;
  let authorisedSocket;
  try {
    await waitForHealth(port, child, () => output);
    const base = `http://127.0.0.1:${port}`;

    const statusWithoutAuth = await fetch(`${base}/api/bot/status`);
    assert.equal(statusWithoutAuth.status, 401, "bot state must require auth");

    const verify = await fetch(`${base}/api/auth/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(verify.status, 204, "correct dashboard token should verify");

    const statusWithAuth = await fetch(`${base}/api/bot/status`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(statusWithAuth.status, 200);
    assert.equal((await statusWithAuth.json()).connected, false);

    const providersResponse = await fetch(`${base}/api/ai/providers`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(providersResponse.status, 200);
    const providerBody = await providersResponse.json();
    assert.ok(providerBody.providers.some((item) => item.name === "local"));

    const chatResponse = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "local", prompt: "Suggest a safe next task." }),
    });
    assert.equal(chatResponse.status, 200);
    const chatBody = await chatResponse.json();
    assert.equal(chatBody.provider, "local");
    assert.equal(chatBody.usedFallback, false);
    assert.ok(typeof chatBody.text === "string" && chatBody.text.length > 0);

    const invalidProvider = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "not-a-provider", prompt: "hello" }),
    });
    assert.equal(invalidProvider.status, 400);

    // An unauthenticated socket must not receive the initial status/log payload.
    const denied = connectWebSocket(port);
    deniedSocket = denied.socket;
    await denied.opened;
    const unsolicitedMessages = [];
    deniedSocket.on("message", (data) => unsolicitedMessages.push(data.toString()));
    await delay(100);
    assert.equal(unsolicitedMessages.length, 0);
    const deniedClose = once(deniedSocket, "close");
    deniedSocket.send(JSON.stringify({ type: "auth", token: "wrong-token" }));
    const [closeCode] = await deniedClose;
    assert.equal(closeCode, 1008, "incorrect WebSocket token should be rejected");

    const authorised = connectWebSocket(port);
    authorisedSocket = authorised.socket;
    await authorised.opened;
    const frames = [];
    const gotFrames = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for authenticated WebSocket payloads")), 3000);
      authorisedSocket.on("message", (data) => {
        frames.push(JSON.parse(data.toString()));
        if (frames.some((frame) => frame.type === "authenticated") &&
            frames.some((frame) => frame.type === "status") &&
            frames.some((frame) => frame.type === "logs")) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    authorisedSocket.send(JSON.stringify({ type: "auth", token: TEST_TOKEN }));
    await gotFrames;
    assert.ok(frames.some((frame) => frame.type === "authenticated"));
    assert.ok(frames.some((frame) => frame.type === "status"));
    assert.ok(frames.some((frame) => frame.type === "logs"));
  } finally {
    for (const socket of [deniedSocket, authorisedSocket]) {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        try { socket.close(); } catch { /* already closed */ }
      }
    }
    child.kill("SIGTERM");
    if (child.exitCode === null) {
      await Promise.race([
        once(child, "exit"),
        delay(3000).then(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }),
      ]);
    }
  }
});
