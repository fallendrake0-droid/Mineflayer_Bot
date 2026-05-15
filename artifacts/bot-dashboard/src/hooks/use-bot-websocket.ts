import React, { useEffect, useState, useRef } from "react";
import type { BotStatus, LogEntry } from "@workspace/api-client-react";

export function useBotWebsocket() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      const wsUrl = window.location.origin.replace(/^http/, 'ws') + '/ws';
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
      };

      ws.onclose = () => {
        setIsConnected(false);
        // Try to reconnect
        reconnectTimeout = setTimeout(connect, 3000);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          
          if (message.type === "status") {
            setStatus(message.data);
          } else if (message.type === "log") {
            setLogs((prevLogs) => {
              const newLogs = [...prevLogs, message.data];
              return newLogs.slice(-100); // keep last 100
            });
          } else if (message.type === "logs") {
            setLogs(message.data.slice(-100));
          }
        } catch (e) {
          console.error("Failed to parse websocket message", e);
        }
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      if (ws) {
        ws.close();
      }
    };
  }, []);

  return { status, logs, isConnected };
}
