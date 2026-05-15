import React, { useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBotWebsocket } from "@/hooks/use-bot-websocket";
import { useGetBotLogs, getGetBotLogsQueryKey } from "@workspace/api-client-react";
import { Terminal } from "lucide-react";

export function LogPanel() {
  const { logs: wsLogs } = useBotWebsocket();
  const { data: restLogs } = useGetBotLogs(
    { limit: 100 },
    { query: { refetchInterval: 2000, queryKey: getGetBotLogsQueryKey({ limit: 100 }) } }
  );

  const logs = wsLogs.length > 0 ? wsLogs : (restLogs?.logs || []);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const getLevelColor = (level: string) => {
    switch (level) {
      case "info": return "text-[#3B82F6]";
      case "warn": return "text-[#EAB308]";
      case "error": return "text-destructive";
      case "success": return "text-primary";
      default: return "text-foreground";
    }
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5 flex flex-col h-full overflow-hidden">
      <CardHeader className="pb-2 border-b border-primary/10 shrink-0">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Terminal className="w-4 h-4" /> ACTIVITY_STREAM
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1 overflow-hidden relative">
        <div ref={scrollRef} className="absolute inset-0 overflow-y-auto p-4 space-y-1 font-mono text-xs">
          {logs.length === 0 && (
            <div className="text-muted-foreground animate-pulse">Awaiting log stream...</div>
          )}
          {logs.map((log, i) => (
            <div key={i} className="flex gap-3 hover:bg-white/5 p-0.5 rounded transition-colors break-words">
              <span className="text-muted-foreground shrink-0 opacity-50">
                [{new Date(log.timestamp).toLocaleTimeString()}]
              </span>
              <span className={`shrink-0 w-12 font-bold ${getLevelColor(log.level)}`}>
                {log.level.toUpperCase()}
              </span>
              <span className="text-foreground/90">{log.message}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
