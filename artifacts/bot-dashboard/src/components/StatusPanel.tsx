import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBot } from "@/lib/bot-context";
import { useDisconnectBot, useExecuteBotCommand, BotCommandRequestCommand } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import {
  Heart,
  Drumstick,
  Sun,
  Moon,
  Sunset,
  Sunrise,
  CloudRain,
  Copy,
  Square,
  Unplug,
  Compass,
  Sparkles,
  Signal,
} from "lucide-react";

/** A row of 10 Minecraft-style icons, each filled proportionally. */
function IconMeter({
  value,
  Icon,
  filledClass,
}: {
  value: number; // 0–20
  Icon: typeof Heart;
  filledClass: string;
}) {
  return (
    <div className="flex gap-[1px]">
      {Array.from({ length: 10 }, (_, i) => {
        const frac = Math.max(0, Math.min(1, value / 2 - i));
        return (
          <span key={i} className="relative inline-block w-[15px] h-[15px] shrink-0">
            <Icon className="absolute inset-0 w-[15px] h-[15px] text-zinc-800" fill="currentColor" />
            {frac > 0 && (
              <span className="absolute inset-0 overflow-hidden" style={{ width: `${frac * 100}%` }}>
                <Icon className={`w-[15px] h-[15px] ${filledClass}`} fill="currentColor" />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function TimeIcon({ timeOfDay }: { timeOfDay?: string }) {
  const cls = "w-3.5 h-3.5";
  switch (timeOfDay) {
    case "night":
      return <Moon className={`${cls} text-indigo-300`} />;
    case "sunset":
      return <Sunset className={`${cls} text-orange-400`} />;
    case "sunrise":
      return <Sunrise className={`${cls} text-amber-300`} />;
    default:
      return <Sun className={`${cls} text-yellow-300`} />;
  }
}

export function StatusPanel() {
  const { status } = useBot();
  const disconnectMutation = useDisconnectBot();
  const executeCommand = useExecuteBotCommand();
  const { toast } = useToast();
  const [, tick] = useState(0);

  // 1s ticker so the uptime clock stays live between status broadcasts.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  if (!status) return null;

  const health = status.health ?? 0;
  const food = status.food ?? 0;
  const pos = status.position;
  const task = status.currentTask || "idle";
  const isBusy = task !== "idle";
  const startedAt = status.stats?.sessionStartedAt
    ? new Date(status.stats.sessionStartedAt).getTime()
    : null;
  const uptime = startedAt ? (Date.now() - startedAt) / 1000 : (status.uptimeSeconds ?? 0);

  const copyCoords = () => {
    if (!pos) return;
    const text = `${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)}`;
    navigator.clipboard?.writeText(text).then(
      () => toast({ title: `Copied ${text}` }),
      () => toast({ title: "Could not copy", variant: "destructive" }),
    );
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10 flex flex-row items-center justify-between">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              status.connected
                ? "bg-primary shadow-[0_0_8px_rgba(34,197,94,0.8)] animate-pulse"
                : "bg-destructive"
            }`}
          />
          {status.username ?? "BOT"} · {status.connectionState?.toUpperCase() ?? (status.connected ? "CONNECTED" : "OFFLINE")}
        </CardTitle>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 font-mono text-[11px] text-destructive hover:bg-destructive/20 hover:text-destructive"
            disabled={!isBusy}
            onClick={() =>
              executeCommand.mutate(
                { data: { command: BotCommandRequestCommand.stop } },
                { onError: (e) => toast({ title: "Stop failed", description: errMsg(e), variant: "destructive" }) },
              )
            }
          >
            <Square className="w-3 h-3 mr-1" /> STOP
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 font-mono text-[11px] text-destructive hover:bg-destructive/20 hover:text-destructive"
            disabled={disconnectMutation.isPending}
            onClick={() =>
              disconnectMutation.mutate(undefined, {
                onError: (e) => toast({ title: "Disconnect failed", description: errMsg(e), variant: "destructive" }),
              })
            }
          >
            <Unplug className="w-3 h-3 mr-1" /> DISCONNECT
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-muted-foreground">HEALTH</span>
              <span className={health <= 6 ? "text-red-400 animate-pulse font-bold" : "text-red-400"}>
                {Math.ceil(health)}/20
              </span>
            </div>
            <IconMeter value={health} Icon={Heart} filledClass="text-red-500" />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-muted-foreground">FOOD</span>
              <span className="text-orange-400">{Math.floor(food)}/20</span>
            </div>
            <IconMeter value={food} Icon={Drumstick} filledClass="text-orange-500" />
          </div>
        </div>

        {/* XP bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-[11px] font-mono">
            <span className="text-muted-foreground flex items-center gap-1">
              <Sparkles className="w-3 h-3 text-lime-400" /> LEVEL {status.xpLevel ?? 0}
            </span>
            <span className="text-muted-foreground">{Math.round((status.xpProgress ?? 0) * 100)}%</span>
          </div>
          <div className="h-1.5 rounded bg-zinc-800 overflow-hidden">
            <div
              className="h-full bg-lime-400 transition-all duration-500"
              style={{ width: `${(status.xpProgress ?? 0) * 100}%` }}
            />
          </div>
        </div>

        {/* Task */}
        <div className={`rounded border p-2.5 font-mono ${isBusy ? "border-primary/40 bg-primary/5" : "border-border/50 bg-muted/10"}`}>
          <div className="text-[10px] text-muted-foreground">CURRENT TASK</div>
          <div className="text-sm text-foreground truncate" title={task}>
            {isBusy && <span className="inline-block w-2 h-2 rounded-full bg-primary animate-pulse mr-2" />}
            {task}
          </div>
          {status.taskDetail && (
            <div className="text-[11px] text-primary mt-0.5">{status.taskDetail}</div>
          )}
        </div>

        {/* Position & world */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs font-mono">
          <div>
            <div className="text-[10px] text-muted-foreground">POSITION</div>
            <button
              type="button"
              onClick={copyCoords}
              className="flex items-center gap-1.5 text-primary hover:underline"
              title="Copy coordinates"
            >
              {pos ? `${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : "—"}
              <Copy className="w-3 h-3 opacity-60" />
            </button>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">FACING</div>
            <div className="flex items-center gap-1 text-foreground">
              <Compass className="w-3.5 h-3.5 text-muted-foreground" />
              {status.facing ?? "—"}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">WORLD</div>
            <div className="text-foreground flex items-center gap-1.5">
              {status.dimension ?? "overworld"}
              <TimeIcon timeOfDay={status.timeOfDay} />
              {status.isRaining && <CloudRain className="w-3.5 h-3.5 text-sky-400" />}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">SESSION</div>
            <div className="text-foreground flex items-center gap-2">
              <span>{formatDuration(uptime)}</span>
              {status.ping !== undefined && (
                <span className="flex items-center gap-0.5 text-muted-foreground" title="Ping">
                  <Signal className="w-3 h-3" />
                  {status.ping}ms
                </span>
              )}
            </div>
          </div>
        </div>

        {status.heldItem && (
          <div className="text-[11px] font-mono text-muted-foreground">
            HOLDING: <span className="text-foreground">{status.heldItem}</span>
            <span className="mx-2 opacity-40">|</span>
            MODE: <span className="text-foreground">{status.gameMode ?? "survival"}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
