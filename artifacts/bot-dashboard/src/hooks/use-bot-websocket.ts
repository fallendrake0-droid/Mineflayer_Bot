import React, { useEffect, useState, useRef } from "react";
import type { BotStatus, LogEntry } from "@workspace/api-client-react";
import { getStoredDashboardToken } from "@/lib/dashboard-auth";

export function useBotWebsocket() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;

      const token = getStoredDashboardToken();
      if (!token) {
        setIsConnected(false);
        return;
      }

      let authenticated = false;
      const wsUrl = window.location.origin.replace(/^http/, "ws") + "/ws";
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // The server sends no status or logs until it validates this first message.
        ws?.send(JSON.stringify({ type: "auth", token }));
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (!disposed) {
          reconnectTimeout = setTimeout(connect, 3000);
        }
      };

      ws.onerror = () => {
        setIsConnected(false);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === "authenticated") {
            authenticated = true;
            setIsConnected(true);
            return;
          }

          // Ignore any payload received before the authentication acknowledgement.
          if (!authenticated) return;

          if (message.type === "status") {
            setStatus(message.data);
          } else if (message.type === "log") {
            setLogs((previous) => [...previous, message.data].slice(-100));
          } else if (message.type === "logs" && Array.isArray(message.data)) {
            setLogs(message.data.slice(-100));
          }
        } catch {
          // Invalid WebSocket payloads are ignored; credentials are never logged.
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      wsRef.current = null;
    };
  }, []);

  return { status, logs, isConnected };
}
