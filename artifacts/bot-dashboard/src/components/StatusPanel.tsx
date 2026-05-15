import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useBotWebsocket } from "@/hooks/use-bot-websocket";
import { useGetBotStatus, useDisconnectBot, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

export function StatusPanel() {
  const { status: wsStatus, isConnected: wsConnected } = useBotWebsocket();
  
  const { data: restStatus } = useGetBotStatus({ 
    query: { refetchInterval: 2000, queryKey: getGetBotStatusQueryKey() } 
  });
  
  const disconnectMutation = useDisconnectBot();
  const queryClient = useQueryClient();

  const status = wsStatus || restStatus;
  const isConnected = wsConnected || status?.connected;

  const handleDisconnect = () => {
    disconnectMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    });
  };

  if (!status) return null;

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10 flex flex-row items-center justify-between">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-primary shadow-[0_0_8px_rgba(34,197,94,0.8)] animate-pulse' : 'bg-destructive'}`} />
          SYS_STATUS: {isConnected ? 'ONLINE' : 'OFFLINE'}
        </CardTitle>
        {isConnected && (
          <Button variant="ghost" size="sm" className="h-6 font-mono text-xs text-destructive hover:bg-destructive/20 hover:text-destructive" onClick={handleDisconnect}>
            DISCONNECT
          </Button>
        )}
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-muted-foreground">HEALTH</span>
              <span className="text-primary">{status.health ?? 0}/20</span>
            </div>
            <Progress value={((status.health ?? 0) / 20) * 100} className="h-2" />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-muted-foreground">FOOD</span>
              <span className="text-[#EAB308]">{status.food ?? 0}/20</span>
            </div>
            <Progress value={((status.food ?? 0) / 20) * 100} className="h-2 [&>div]:bg-[#EAB308]" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 bg-muted/20 p-3 rounded border border-border/50">
          <div>
            <div className="text-[10px] text-muted-foreground font-mono mb-1">COORDINATES</div>
            <div className="font-mono text-sm tracking-wider text-primary">
              X:{Math.floor(status.position?.x ?? 0)} Y:{Math.floor(status.position?.y ?? 0)} Z:{Math.floor(status.position?.z ?? 0)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground font-mono mb-1">CURRENT_TASK</div>
            <div className="font-mono text-sm text-foreground truncate">
              {status.currentTask || "IDLE"}
            </div>
          </div>
        </div>
        
        <div>
          <div className="text-[10px] text-muted-foreground font-mono mb-1 flex justify-between">
            <span>NEARBY_ENTITIES</span>
            <span>{status.players?.length ?? 0} DETECTED</span>
          </div>
          <div className="font-mono text-xs bg-card p-2 rounded border border-border/50 max-h-24 overflow-y-auto">
            {status.players && status.players.length > 0 ? (
              <ul className="space-y-1">
                {status.players.map((p, i) => <li key={i} className="text-secondary-foreground">- {p}</li>)}
              </ul>
            ) : (
              <span className="text-muted-foreground">NO_ENTITIES_FOUND</span>
            )}
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
