import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useBot } from "@/lib/bot-context";
import { useUpdateBotSettings, type BotSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Settings2 } from "lucide-react";

const TOGGLES: Array<{ key: keyof BotSettings; label: string; hint: string }> = [
  { key: "autoEat", label: "Auto-eat", hint: "Eat the best food when hungry or hurt" },
  { key: "autoEquipArmor", label: "Auto-equip armor", hint: "Wear the best armor in inventory" },
  { key: "autoDefend", label: "Auto-defend", hint: "Fight back when attacked" },
  { key: "autoCollectDrops", label: "Collect drops", hint: "Pick up drops after working/fighting" },
  { key: "autoReconnect", label: "Auto-reconnect", hint: "Reconnect after kicks/drops (with backoff)" },
  { key: "antiAfk", label: "Anti-AFK", hint: "Look around & hop while idle" },
  { key: "chatCommandsEnabled", label: "Chat commands", hint: "Allow !commands from in-game chat" },
  { key: "aiEnabled", label: "AI brain", hint: "LLM goals, autopilot & self-written skills" },
  { key: "aiChatEnabled", label: "AI chat", hint: "Owners can talk to the AI in plain chat" },
  { key: "viewerEnabled", label: "Live view", hint: "prismarine-viewer 3D view (uses some CPU)" },
  { key: "viewerFirstPerson", label: "First-person camera", hint: "Off = orbit camera in the live view" },
];

export function SettingsPanel() {
  const { settings, setSettingsLocal } = useBot();
  const updateSettings = useUpdateBotSettings();
  const { toast } = useToast();

  const [threshold, setThreshold] = useState("");
  const [maxAttempts, setMaxAttempts] = useState("");
  const [owners, setOwners] = useState("");

  useEffect(() => {
    if (settings) {
      setThreshold(String(settings.autoEatThreshold ?? 14));
      setMaxAttempts(String(settings.maxReconnectAttempts ?? 10));
      setOwners((settings.chatCommandOwners ?? []).join(", "));
    }
  }, [settings]);

  const save = (data: Partial<BotSettings>, silent = false) => {
    updateSettings.mutate(
      { data },
      {
        onSuccess: (next) => {
          setSettingsLocal(next);
          if (!silent) toast({ title: "Settings saved" });
        },
        onError: (e) =>
          toast({ title: "Settings failed", description: errMsg(e), variant: "destructive" }),
      },
    );
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Settings2 className="w-4 h-4" /> AUTOMATION
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-1">
        {TOGGLES.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center justify-between gap-3 py-1.5">
            <div className="min-w-0">
              <div className="font-mono text-xs text-foreground">{label}</div>
              <div className="font-mono text-[10px] text-muted-foreground truncate" title={hint}>
                {hint}
              </div>
            </div>
            <Switch
              checked={Boolean(settings?.[key])}
              onCheckedChange={(v) => save({ [key]: v }, true)}
              disabled={updateSettings.isPending}
            />
          </div>
        ))}

        <div className="grid grid-cols-2 gap-3 pt-2">
          <label className="block">
            <span className="font-mono text-[10px] text-muted-foreground">EAT AT FOOD ≤</span>
            <Input
              className="font-mono text-xs h-8 bg-card mt-1"
              inputMode="numeric"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              onBlur={() => {
                const n = parseInt(threshold, 10);
                if (!Number.isNaN(n)) save({ autoEatThreshold: n }, true);
              }}
            />
          </label>
          <label className="block">
            <span className="font-mono text-[10px] text-muted-foreground">MAX RECONNECTS (0=∞)</span>
            <Input
              className="font-mono text-xs h-8 bg-card mt-1"
              inputMode="numeric"
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
              onBlur={() => {
                const n = parseInt(maxAttempts, 10);
                if (!Number.isNaN(n)) save({ maxReconnectAttempts: n }, true);
              }}
            />
          </label>
        </div>

        <div className="pt-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            CHAT COMMAND OWNERS (comma-separated, empty = everyone)
          </span>
          <div className="flex gap-2 mt-1">
            <Input
              className="font-mono text-xs h-8 bg-card"
              placeholder="Steve, Alex"
              value={owners}
              onChange={(e) => setOwners(e.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              className="font-mono text-xs h-8"
              onClick={() =>
                save({
                  chatCommandOwners: owners
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            >
              SAVE
            </Button>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground mt-2 leading-relaxed">
            Owners can control the bot from in-game chat:{" "}
            <span className="text-foreground">!help !come !mine diamond 8 !chop !guard !stop</span>
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
