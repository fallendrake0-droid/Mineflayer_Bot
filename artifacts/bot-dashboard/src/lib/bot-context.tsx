import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  BotInventoryResponse,
  BotSettings,
  BotStatus,
  LogEntry,
} from "@workspace/api-client-react";

interface BotContextValue {
  status: BotStatus | null;
  logs: LogEntry[];
  inventory: BotInventoryResponse | null;
  settings: BotSettings | null;
  /** True when the dashboard's own WebSocket to the API server is up. */
  wsConnected: boolean;
  setSettingsLocal: (settings: BotSettings) => void;
}

const BotContext = createContext<BotContextValue>({
  status: null,
  logs: [],
  inventory: null,
  settings: null,
  wsConnected: false,
  setSettingsLocal: () => {},
});

const MAX_LOGS = 400;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/**
 * One shared WebSocket for the whole dashboard (the v1 UI opened a separate
 * socket per panel and *also* polled REST every 2s). Reconnects with
 * exponential backoff; the server sends a full snapshot on connect.
 */
export function BotProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [inventory, setInventory] = useState<BotInventoryResponse | null>(null);
  const [settings, setSettings] = useState<BotSettings | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const attemptsRef = useRef(0);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      ws = new WebSocket(wsUrl());

      ws.onopen = () => {
        attemptsRef.current = 0;
        setWsConnected(true);
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (disposed) return;
        const delay = Math.min(10_000, 1000 * 2 ** attemptsRef.current);
        attemptsRef.current++;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // ignore
        }
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type: string;
            data: unknown;
          };
          switch (message.type) {
            case "status":
              setStatus(message.data as BotStatus);
              break;
            case "log":
              setLogs((prev) => {
                const next = [...prev, message.data as LogEntry];
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
              });
              break;
            case "logs":
              setLogs((message.data as LogEntry[]).slice(-MAX_LOGS));
              break;
            case "inventory":
              setInventory(message.data as BotInventoryResponse);
              break;
            case "settings":
              setSettings(message.data as BotSettings);
              break;
          }
        } catch {
          // ignore malformed frames
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  const setSettingsLocal = useCallback((next: BotSettings) => {
    setSettings(next);
  }, []);

  return (
    <BotContext.Provider
      value={{ status, logs, inventory, settings, wsConnected, setSettingsLocal }}
    >
      {children}
    </BotContext.Provider>
  );
}

export function useBot(): BotContextValue {
  return useContext(BotContext);
}
