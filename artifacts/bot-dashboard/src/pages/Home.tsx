import React from "react";
import { ConnectionForm } from "@/components/ConnectionForm";
import { StatusPanel } from "@/components/StatusPanel";
import { PlayersPanel } from "@/components/PlayersPanel";
import { CommandPanel } from "@/components/CommandPanel";
import { ControlPad } from "@/components/ControlPad";
import { LogPanel } from "@/components/LogPanel";
import { InventoryPanel } from "@/components/InventoryPanel";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ViewerPanel } from "@/components/ViewerPanel";
import { StatsStrip } from "@/components/StatsStrip";
import { AiPanel } from "@/components/AiPanel";
import { useBot } from "@/lib/bot-context";
import { useDisconnectBot } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Wifi, WifiOff, Loader2 } from "lucide-react";

const STATE_STYLES: Record<string, { label: string; cls: string }> = {
  connected: { label: "LINK_ESTABLISHED", cls: "text-primary" },
  connecting: { label: "CONNECTING…", cls: "text-amber-400" },
  reconnecting: { label: "RECONNECTING…", cls: "text-orange-400" },
  disconnected: { label: "LINK_SEVERED", cls: "text-destructive" },
};

function Header() {
  const { status, wsConnected } = useBot();
  const state = status?.connectionState ?? (status?.connected ? "connected" : "disconnected");
  const style = STATE_STYLES[state] ?? STATE_STYLES.disconnected;

  return (
    <header className="flex items-center justify-between border-b border-primary/20 pb-4 gap-4 flex-wrap">
      <div>
        <h1 className="text-3xl font-bold font-mono tracking-tighter text-primary">
          MINECONTROL<span className="text-muted-foreground animate-pulse">_</span>
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          Autonomous Agent Control Matrix
        </p>
      </div>
      <div className="text-xs font-mono text-muted-foreground text-right space-y-1">
        <div className="flex items-center gap-2 justify-end">
          <span>v2.0</span>
          <span
            className={`flex items-center gap-1 ${wsConnected ? "text-primary" : "text-destructive"}`}
            title={wsConnected ? "Dashboard link OK" : "Dashboard link down — is the API server running?"}
          >
            {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {wsConnected ? "API ONLINE" : "API OFFLINE"}
          </span>
        </div>
        <div className={style.cls}>
          {style.label}
          {state === "reconnecting" && status?.reconnectAttempts
            ? ` (attempt ${status.reconnectAttempts})`
            : ""}
        </div>
        {status?.connected && (
          <div>
            {status.username} @ {status.host}:{status.port} · MC {status.version ?? "?"}
          </div>
        )}
      </div>
    </header>
  );
}

function ConnectingBanner() {
  const { status } = useBot();
  const disconnectMutation = useDisconnectBot();
  const state = status?.connectionState;
  if (state !== "connecting" && state !== "reconnecting") return null;
  return (
    <div className="flex items-center gap-3 border border-amber-500/40 bg-amber-500/5 rounded px-4 py-3 font-mono text-sm">
      <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
      <span className="text-foreground">
        {state === "reconnecting"
          ? `Lost connection — auto-reconnect attempt ${status?.reconnectAttempts ?? 0}…`
          : `Connecting to ${status?.host}:${status?.port}…`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 font-mono text-[11px] text-destructive hover:bg-destructive/20"
        onClick={() => disconnectMutation.mutate(undefined)}
      >
        CANCEL
      </Button>
    </div>
  );
}

export function Home() {
  const { status } = useBot();
  const isConnected = Boolean(status?.connected);

  return (
    <div className="min-h-[100dvh] w-full bg-background text-foreground p-4 lg:p-6 font-sans selection:bg-primary/30">
      <div className="max-w-[1700px] mx-auto flex flex-col gap-5">
        <Header />
        <ConnectingBanner />

        {!isConnected ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
            <div className="flex flex-col gap-5">
              <ConnectionForm />
              <AiPanel />
            </div>
            <LogPanel heightClass="h-[520px]" />
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
            {/* Left rail: vitals, players, automation */}
            <div className="xl:col-span-3 flex flex-col gap-5">
              <StatusPanel />
              <PlayersPanel />
              <SettingsPanel />
            </div>

            {/* Center: eyes, stats, inventory, log/chat */}
            <div className="xl:col-span-6 flex flex-col gap-5">
              <ViewerPanel />
              <StatsStrip />
              <InventoryPanel />
              <LogPanel heightClass="h-[430px]" />
            </div>

            {/* Right rail: commands + driving */}
            <div className="xl:col-span-3 flex flex-col gap-5">
              <AiPanel />
              <CommandPanel />
              <ControlPad />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
