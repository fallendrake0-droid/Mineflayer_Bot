import http from "http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { botManager } from "./lib/bot";
import { isValidDashboardToken } from "./middlewares/auth";

const rawPort = process.env["PORT"] ?? "3000";
const port = Number(rawPort);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

botManager.setWss(wss);

// WebSockets cannot reliably attach an Authorization header in browsers, so
// require a short first-message token handshake. No status/log data is sent
// until the socket is authorised, and BotManager broadcasts only to sockets
// marked as authorised.
wss.on("connection", (ws) => {
  let authenticated = false;
  const authTimer = setTimeout(() => {
    if (!authenticated && ws.readyState === ws.OPEN) {
      ws.close(1008, "Authentication required");
    }
  }, 5000);

  ws.on("message", (data, isBinary) => {
    if (authenticated) return;

    let message: unknown;
    try {
      if (isBinary) throw new Error("Binary auth messages are not supported");
      message = JSON.parse(data.toString());
    } catch {
      ws.close(1008, "Authentication required");
      return;
    }

    const record = message && typeof message === "object"
      ? message as Record<string, unknown>
      : null;
    const token = record?.["type"] === "auth" && typeof record["token"] === "string"
      ? record["token"]
      : null;

    if (!isValidDashboardToken(token)) {
      ws.close(1008, "Unauthorized");
      return;
    }

    authenticated = true;
    clearTimeout(authTimer);
    botManager.authorizeWebSocket(ws);
    ws.send(JSON.stringify({ type: "authenticated", data: true }));
    ws.send(JSON.stringify({ type: "status", data: botManager.getStatus() }));
    ws.send(JSON.stringify({ type: "logs", data: botManager.getLogs(50) }));
    logger.info("Authenticated WebSocket client connected");
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    botManager.unauthorizeWebSocket(ws);
    if (authenticated) logger.info("WebSocket client disconnected");
  });

  ws.on("error", (err) => {
    logger.warn({ err }, "WebSocket client error");
  });
});

wss.on("error", (err) => {
  logger.error({ err }, "WebSocket server error");
});

botManager.registerChatCommands();

server.on("error", (err) => {
  logger.error({ err }, "HTTP server error");
});

server.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "Server listening");
  logger.info({ path: "/ws" }, "WebSocket server listening");
});
