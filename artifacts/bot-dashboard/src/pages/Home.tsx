import React from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { StatusPanel } from "@/components/StatusPanel";
import { CommandPanel } from "@/components/CommandPanel";
import { LogPanel } from "@/components/LogPanel";
import { InventoryPanel } from "@/components/InventoryPanel";
import { useGetBotStatus, getGetBotStatusQueryKey } from "@workspace/api-client-react";

export function Home() {
  const { data: status } = useGetBotStatus({
    query: { refetchInterval: 2000, queryKey: getGetBotStatusQueryKey() }
  });

  const isConnected = status?.connected || false;

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground p-4 lg:p-8 font-sans selection:bg-primary/30">
      <div className="max-w-[1600px] mx-auto flex flex-col gap-6">
        
        <header className="flex items-center justify-between border-b border-primary/20 pb-4">
          <div>
            <h1 className="text-3xl font-bold font-mono tracking-tighter text-primary">
              MINECONTROL<span className="text-muted-foreground animate-pulse">_</span>
            </h1>
            <p className="text-muted-foreground font-mono text-sm mt-1">Autonomous Agent Control Matrix</p>
          </div>
          <div className="text-xs font-mono text-muted-foreground text-right">
            <div>v1.0.0-ALPHA</div>
            <div className={isConnected ? "text-primary" : "text-destructive"}>
              {isConnected ? "LINK_ESTABLISHED" : "LINK_SEVERED"}
            </div>
          </div>
        </header>

        {!isConnected ? (
          <div className="max-w-xl mx-auto w-full mt-12">
            <ConnectionForm />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[calc(100vh-140px)] min-h-[600px]">
            <div className="lg:col-span-4 flex flex-col gap-6 h-full">
              <StatusPanel />
              <div className="flex-1 min-h-[300px]">
                <CommandPanel />
              </div>
            </div>
            
            <div className="lg:col-span-8 flex flex-col gap-6 h-full">
              <div className="flex-1 min-h-[300px]">
                <LogPanel />
              </div>
              <div className="h-[240px] shrink-0">
                <InventoryPanel />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
