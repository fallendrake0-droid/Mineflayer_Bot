import http from "http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { botManager } from "./lib/bot";

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

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/ws" });

botManager.setWss(wss);

wss.on("connection", (ws) => {
  logger.info("WebSocket client connected");
  const status = botManager.getStatus();
  ws.send(JSON.stringify({ type: "status", data: status }));

  const recentLogs = botManager.getLogs(50);
  ws.send(JSON.stringify({ type: "logs", data: recentLogs }));

  ws.on("close", () => {
    logger.info("WebSocket client disconnected");
  });
});

// Register in-game chat commands once bot is connected
botManager.registerChatCommands();

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  logger.info({ path: "/ws" }, "WebSocket server listening");
});
