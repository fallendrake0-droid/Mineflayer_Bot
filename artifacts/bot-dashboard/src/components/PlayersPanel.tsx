import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBot } from "@/lib/bot-context";
import {
  useExecuteBotCommand,
  BotCommandRequestCommand,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Users, Footprints, Sword, PackageMinus } from "lucide-react";

export function PlayersPanel() {
  const { status } = useBot();
  const executeCommand = useExecuteBotCommand();
  const { toast } = useToast();

  const players = status?.players ?? [];

  const run = (command: BotCommandRequestCommand, target: string, label: string) => {
    executeCommand.mutate(
      { data: { command, target } },
      {
        onSuccess: () => toast({ title: `${label} ${target}` }),
        onError: (e) =>
          toast({ title: "Command failed", description: errMsg(e), variant: "destructive" }),
      },
    );
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Users className="w-4 h-4" /> PLAYERS ONLINE
          </span>
          <span className="text-muted-foreground text-xs">{players.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3">
        {players.length === 0 ? (
          <div className="font-mono text-xs text-muted-foreground text-center p-3 border border-dashed border-border rounded">
            NO OTHER PLAYERS
          </div>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {players.map((p) => (
              <div
                key={p.username}
                className="flex items-center gap-2 rounded border border-border/50 bg-card/50 px-2 py-1.5"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-xs text-foreground truncate">{p.username}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {p.distance !== undefined ? `${p.distance} blocks away` : "out of range"}
                    {p.ping !== undefined ? ` · ${p.ping}ms` : ""}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title={`Follow ${p.username}`}
                  disabled={p.distance === undefined}
                  onClick={() => run(BotCommandRequestCommand.follow, p.username, "Following")}
                >
                  <Footprints className="w-3.5 h-3.5 text-primary" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title={`Give loot to ${p.username}`}
                  onClick={() => run(BotCommandRequestCommand.dropItems, p.username, "Giving loot to")}
                >
                  <PackageMinus className="w-3.5 h-3.5 text-amber-400" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  title={`Hit ${p.username} once`}
                  disabled={p.distance === undefined}
                  onClick={() => run(BotCommandRequestCommand.hitPlayer, p.username, "Hitting")}
                >
                  <Sword className="w-3.5 h-3.5 text-red-400" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
