import React, { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBot } from "@/lib/bot-context";
import {
  useClearBotLogs,
  useExecuteBotCommand,
  BotCommandRequestCommand,
  type LogEntry,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Terminal, Search, Download, Trash2, Pause, Play, Send } from "lucide-react";

const LEVELS: Array<{ id: LogEntry["level"]; label: string; cls: string; activeCls: string }> = [
  { id: "info", label: "INFO", cls: "text-[#3B82F6]", activeCls: "border-[#3B82F6]/60 bg-[#3B82F6]/10" },
  { id: "success", label: "OK", cls: "text-primary", activeCls: "border-primary/60 bg-primary/10" },
  { id: "warn", label: "WARN", cls: "text-[#EAB308]", activeCls: "border-[#EAB308]/60 bg-[#EAB308]/10" },
  { id: "error", label: "ERR", cls: "text-destructive", activeCls: "border-destructive/60 bg-destructive/10" },
];

const LEVEL_COLOR = Object.fromEntries(LEVELS.map((l) => [l.id, l.cls]));

export function LogPanel({ heightClass = "h-full" }: { heightClass?: string }) {
  const { logs, status } = useBot();
  const clearLogs = useClearBotLogs();
  const executeCommand = useExecuteBotCommand();
  const { toast } = useToast();

  const [enabledLevels, setEnabledLevels] = useState<Set<string>>(
    new Set(LEVELS.map((l) => l.id)),
  );
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [paused, setPaused] = useState(false);

  const [chatInput, setChatInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const historyIdxRef = useRef(-1);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs
      .filter((l) => enabledLevels.has(l.level))
      .filter((l) => category === "all" || (l.category ?? "system") === category)
      .filter((l) => !q || l.message.toLowerCase().includes(q))
      .slice(-300);
  }, [logs, enabledLevels, category, search]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && !paused && nearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [displayed, paused]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const toggleLevel = (id: string) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const downloadLogs = () => {
    const text = displayed
      .map(
        (l) =>
          `[${new Date(l.timestamp).toISOString()}] ${l.level.toUpperCase()} [${l.category ?? "system"}] ${l.message}`,
      )
      .join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `minecontrol-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    const message = chatInput.trim();
    if (!message) return;
    executeCommand.mutate(
      { data: { command: BotCommandRequestCommand.chat, message } },
      {
        onError: (err) =>
          toast({ title: "Chat failed", description: errMsg(err), variant: "destructive" }),
      },
    );
    setHistory((h) => [message, ...h].slice(0, 50));
    historyIdxRef.current = -1;
    setChatInput("");
  };

  const onChatKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(historyIdxRef.current + 1, history.length - 1);
      if (next >= 0 && history[next]) {
        historyIdxRef.current = next;
        setChatInput(history[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = historyIdxRef.current - 1;
      historyIdxRef.current = next;
      setChatInput(next >= 0 && history[next] ? history[next] : "");
    }
  };

  const botConnected = Boolean(status?.connected);

  return (
    <Card className={`border-primary/20 bg-black shadow-lg shadow-primary/5 flex flex-col overflow-hidden ${heightClass}`}>
      <CardHeader className="pb-2 border-b border-primary/10 shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
            <Terminal className="w-4 h-4" /> ACTIVITY & CHAT
            <span className="text-[10px] text-muted-foreground font-normal">
              {displayed.length}/{logs.length}
            </span>
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost" size="sm" className="h-6 w-6 p-0"
              title={paused ? "Resume auto-scroll" : "Pause auto-scroll"}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Download log" onClick={downloadLogs}>
              <Download className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost" size="sm" className="h-6 w-6 p-0 hover:text-destructive" title="Clear log"
              onClick={() =>
                clearLogs.mutate(undefined, {
                  onError: (err) => toast({ title: "Clear failed", description: errMsg(err), variant: "destructive" }),
                })
              }
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => toggleLevel(l.id)}
              className={`font-mono text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                enabledLevels.has(l.id)
                  ? `${l.activeCls} ${l.cls}`
                  : "border-border/50 text-muted-foreground/50"
              }`}
            >
              {l.label}
            </button>
          ))}
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-6 w-[110px] font-mono text-[10px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="task">Tasks</SelectItem>
              <SelectItem value="combat">Combat</SelectItem>
              <SelectItem value="connection">Connection</SelectItem>
              <SelectItem value="ai">AI brain</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative flex-1 min-w-[110px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter…"
              className="h-6 pl-6 font-mono text-[11px] bg-card"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 flex-1 overflow-hidden relative min-h-[180px]">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="absolute inset-0 overflow-y-auto p-3 space-y-0.5 font-mono text-xs"
        >
          {displayed.length === 0 && (
            <div className="text-muted-foreground animate-pulse p-1">
              {logs.length === 0 ? "Awaiting log stream…" : "No entries match the current filters."}
            </div>
          )}
          {displayed.map((log, i) => (
            <div key={i} className="flex gap-2.5 hover:bg-white/5 px-1 py-px rounded transition-colors break-words">
              <span className="text-muted-foreground shrink-0 opacity-50">
                {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className={`shrink-0 w-9 font-bold ${LEVEL_COLOR[log.level] ?? ""}`}>
                {log.level === "success" ? "OK" : log.level.toUpperCase()}
              </span>
              <span className="text-foreground/90">{log.message}</span>
            </div>
          ))}
        </div>
      </CardContent>

      <form onSubmit={sendChat} className="shrink-0 border-t border-primary/10 p-2 flex gap-2">
        <Input
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={onChatKeyDown}
          placeholder={
            botConnected
              ? "Chat as the bot… (/ for server commands, ↑ for history)"
              : "Connect the bot to chat"
          }
          disabled={!botConnected}
          className="font-mono text-xs h-8 bg-card"
          maxLength={256}
        />
        <Button type="submit" size="sm" className="h-8 font-mono text-xs" disabled={!botConnected || !chatInput.trim()}>
          <Send className="w-3.5 h-3.5 mr-1" /> SEND
        </Button>
      </form>
    </Card>
  );
}
