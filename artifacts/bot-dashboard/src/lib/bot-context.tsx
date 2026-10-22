import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  BotInventoryResponse,
  BotSettings,
  BotStatus,
  LogEntry,
} from "@workspace/api-client-react";

/** LogEntry plus a client-side stable id (the API has no log ids; React
 * needs durable keys as the list is filtered/sliced). */
export type UiLogEntry = LogEntry & { uiId: number };

let nextLogUiId = 1;
const withUiId = (entry: LogEntry): UiLogEntry => ({ ...entry, uiId: nextLogUiId++ });

interface BotContextValue {
  status: BotStatus | null;
  logs: UiLogEntry[];
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
  const [logs, setLogs] = useState<UiLogEntry[]>([]);
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
                const next = [...prev, withUiId(message.data as LogEntry)];
                return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
              });
              break;
            case "logs":
              setLogs((message.data as LogEntry[]).map(withUiId).slice(-MAX_LOGS));
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

  const value = useMemo<BotContextValue>(
    () => ({ status, logs, inventory, settings, wsConnected, setSettingsLocal }),
    [status, logs, inventory, settings, wsConnected, setSettingsLocal],
  );

  return <BotContext.Provider value={value}>{children}</BotContext.Provider>;
}

export function useBot(): BotContextValue {
  return useContext(BotContext);
}
