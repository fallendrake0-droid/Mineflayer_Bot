import http from "http";
import net from "net";
import type { Duplex } from "stream";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { botManager, VIEWER_PORT } from "./lib/bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ---------------------------------------------------------------------------
// prismarine-viewer proxy
//
// The viewer runs its own tiny HTTP/socket.io server on VIEWER_PORT whenever
// the bot is connected. Proxying it under /viewer on this server means the
// dashboard can always embed it same-origin (Replit, localhost, previews…)
// without exposing a second public port.
// ---------------------------------------------------------------------------

function proxyViewerHttp(req: http.IncomingMessage, res: http.ServerResponse) {
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: VIEWER_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${VIEWER_PORT}` },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
    }
    res.end(
      "<html><body style='background:#0a0a0a;color:#a3a3a3;font-family:monospace;padding:2rem'>" +
        "<h3>Live view offline</h3><p>The bot is not connected, or the viewer is disabled in Settings.</p></body></html>",
    );
  });
  req.pipe(upstream);
}

function proxyViewerUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
  const upstream = net.connect(VIEWER_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket servers
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/viewer")) {
    proxyViewerHttp(req, res);
    return;
  }
  app(req, res);
});

const wss = new WebSocketServer({ noServer: true });
botManager.setWss(wss);

server.on("upgrade", (req, socket, head) => {
  let pathname = "";
  try {
    pathname = new URL(req.url ?? "", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else if (pathname.startsWith("/viewer")) {
    proxyViewerUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

interface AliveWebSocket {
  isAlive?: boolean;
}

wss.on("connection", (ws) => {
  logger.info("WebSocket client connected");
  (ws as AliveWebSocket).isAlive = true;
  ws.on("pong", () => {
    (ws as AliveWebSocket).isAlive = true;
  });

  // Send a full snapshot so a fresh dashboard is populated immediately.
  ws.send(JSON.stringify({ type: "status", data: botManager.getStatus() }));
  ws.send(JSON.stringify({ type: "logs", data: botManager.getLogs(150) }));
  ws.send(JSON.stringify({ type: "inventory", data: botManager.getInventoryResponse() }));
  ws.send(JSON.stringify({ type: "settings", data: botManager.getSettings() }));

  ws.on("close", () => {
    logger.info("WebSocket client disconnected");
  });
});

// Drop dead dashboard connections (closed laptop lids, lost networks…).
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    const alive = ws as typeof ws & AliveWebSocket;
    if (alive.isAlive === false) {
      ws.terminate();
      return;
    }
    alive.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on("close", () => clearInterval(heartbeat));

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled promise rejection");
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down…");
  botManager.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info({ path: "/ws" }, "WebSocket server listening");
  logger.info({ path: "/viewer", upstream: VIEWER_PORT }, "Live-view proxy ready");
});
