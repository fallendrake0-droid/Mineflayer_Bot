import React, { useState } from "react";
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
import {
  useExecuteBotCommand,
  BotCommandRequestCommand,
  BotCommandRequestResource,
  BotCommandRequestTreeType,
  type BotCommandRequest,
} from "@workspace/api-client-react";
import { useBot } from "@/lib/bot-context";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import {
  Square,
  Crosshair,
  Pickaxe,
  PackageMinus,
  Hammer,
  ArrowUp,
  Hand,
  ToggleRight,
  TreePine,
  Navigation,
  Footprints,
  Shield,
  Compass,
  UtensilsCrossed,
  BedDouble,
  Sparkles,
  Archive,
  Grab,
} from "lucide-react";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] tracking-[0.2em] text-muted-foreground border-b border-border/40 pb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

const inputCls = "font-mono text-xs h-8 bg-card";
const btnCls = "font-mono text-xs whitespace-nowrap h-8";

export function CommandPanel() {
  const executeCommand = useExecuteBotCommand();
  const { status } = useBot();
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const players = status?.players ?? [];
  const firstPlayer = players[0]?.username ?? "";

  const [gotoX, setGotoX] = useState("");
  const [gotoY, setGotoY] = useState("");
  const [gotoZ, setGotoZ] = useState("");
  const [followTarget, setFollowTarget] = useState("");
  const [hitTarget, setHitTarget] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [mineResource, setMineResource] = useState<BotCommandRequestResource>(BotCommandRequestResource.iron);
  const [mineCount, setMineCount] = useState("16");
  const [treeType, setTreeType] = useState<BotCommandRequestTreeType>(BotCommandRequestTreeType.any);
  const [treeCount, setTreeCount] = useState("1");
  const [climbCount, setClimbCount] = useState("10");
  const [buildSize, setBuildSize] = useState("5");

  const run = (label: string, data: BotCommandRequest) => {
    setPending(label);
    executeCommand.mutate(
      { data },
      {
        onSuccess: () => toast({ title: label }),
        onError: (err) =>
          toast({ title: "Command failed", description: errMsg(err), variant: "destructive" }),
        onSettled: () => setPending(null),
      },
    );
  };

  const num = (v: string) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  };

  const playerSelect = (
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
    testId: string,
  ) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger data-testid={testId} className="h-8 font-mono text-xs flex-1">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {players.length === 0 ? (
          <SelectItem value="__none" disabled>
            No players online
          </SelectItem>
        ) : (
          players.map((p) => (
            <SelectItem key={p.username} value={p.username}>
              {p.username}
              {p.distance !== undefined ? ` (${p.distance} blk)` : ""}
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Sparkles className="w-4 h-4" /> COMMAND CENTER
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <Button
          data-testid="button-stop"
          variant="destructive"
          className="font-mono text-xs w-full justify-center gap-2"
          onClick={() => run("Stopped", { command: BotCommandRequestCommand.stop })}
        >
          <Square className="w-4 h-4" /> STOP EVERYTHING
        </Button>

        <Section title="MOVEMENT">
          <div className="flex gap-1.5">
            <Input className={inputCls} placeholder="X" inputMode="numeric" value={gotoX} onChange={(e) => setGotoX(e.target.value)} />
            <Input className={inputCls} placeholder="Y (opt)" inputMode="numeric" value={gotoY} onChange={(e) => setGotoY(e.target.value)} />
            <Input className={inputCls} placeholder="Z" inputMode="numeric" value={gotoZ} onChange={(e) => setGotoZ(e.target.value)} />
            <Button
              size="sm"
              variant="secondary"
              className={btnCls}
              disabled={!gotoX || !gotoZ}
              onClick={() =>
                run("Going to coordinates", {
                  command: BotCommandRequestCommand.goto,
                  x: Number(gotoX),
                  y: gotoY ? Number(gotoY) : undefined,
                  z: Number(gotoZ),
                })
              }
            >
              <Navigation className="w-3 h-3 mr-1" /> GO
            </Button>
          </div>
          <div className="flex gap-2">
            {playerSelect(followTarget || firstPlayer, setFollowTarget, "Follow player…", "select-follow-target")}
            <Button
              size="sm" variant="secondary" className={btnCls}
              disabled={!(followTarget || firstPlayer)}
              onClick={() => run(`Following ${followTarget || firstPlayer}`, { command: BotCommandRequestCommand.follow, target: followTarget || firstPlayer })}
            >
              <Footprints className="w-3 h-3 mr-1" /> FOLLOW
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Wandering", { command: BotCommandRequestCommand.wander })}>
              <Compass className="w-3.5 h-3.5 mr-1.5" /> WANDER
            </Button>
            <div className="flex gap-1.5">
              <Input className={inputCls} inputMode="numeric" value={climbCount} onChange={(e) => setClimbCount(e.target.value)} title="Blocks to pillar up" />
              <Button size="sm" variant="outline" className={`${btnCls} border-primary/30 hover:bg-primary/10`}
                onClick={() => run("Pillaring up", { command: BotCommandRequestCommand.climb, count: num(climbCount) })}>
                <ArrowUp className="w-3.5 h-3.5 mr-1" /> PILLAR
              </Button>
            </div>
          </div>
        </Section>

        <Section title="WORK">
          <div className="flex gap-2">
            <Select value={mineResource} onValueChange={(v) => setMineResource(v as BotCommandRequestResource)}>
              <SelectTrigger data-testid="select-mine-resource" className="h-8 font-mono text-xs flex-1">
                <SelectValue placeholder="Resource" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="coal">Coal</SelectItem>
                <SelectItem value="iron">Iron</SelectItem>
                <SelectItem value="copper">Copper</SelectItem>
                <SelectItem value="gold">Gold</SelectItem>
                <SelectItem value="redstone">Redstone</SelectItem>
                <SelectItem value="lapis">Lapis</SelectItem>
                <SelectItem value="diamond">Diamond</SelectItem>
                <SelectItem value="emerald">Emerald</SelectItem>
                <SelectItem value="stone">Stone</SelectItem>
                <SelectItem value="obsidian">Obsidian</SelectItem>
                <SelectItem value="ancient_debris">Ancient Debris</SelectItem>
              </SelectContent>
            </Select>
            <Input className={`${inputCls} w-16`} inputMode="numeric" value={mineCount} onChange={(e) => setMineCount(e.target.value)} title="How many blocks to mine" />
            <Button size="sm" variant="secondary" className={btnCls}
              onClick={() => run(`Mining ${mineResource}`, { command: BotCommandRequestCommand.mine, resource: mineResource, count: num(mineCount) })}>
              <Pickaxe className="w-3 h-3 mr-1" /> MINE
            </Button>
          </div>

          <div className="flex gap-2">
            <Select value={treeType} onValueChange={(v) => setTreeType(v as BotCommandRequestTreeType)}>
              <SelectTrigger data-testid="select-tree-type" className="h-8 font-mono text-xs flex-1">
                <SelectValue placeholder="Tree type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Any tree</SelectItem>
                <SelectItem value="oak">Oak</SelectItem>
                <SelectItem value="birch">Birch</SelectItem>
                <SelectItem value="spruce">Spruce</SelectItem>
                <SelectItem value="jungle">Jungle</SelectItem>
                <SelectItem value="acacia">Acacia</SelectItem>
                <SelectItem value="dark_oak">Dark Oak</SelectItem>
                <SelectItem value="mangrove">Mangrove</SelectItem>
                <SelectItem value="cherry">Cherry</SelectItem>
              </SelectContent>
            </Select>
            <Input className={`${inputCls} w-16`} inputMode="numeric" value={treeCount} onChange={(e) => setTreeCount(e.target.value)} title="How many trees" />
            <Button size="sm" className={`${btnCls} bg-emerald-700 hover:bg-emerald-600 text-white`}
              onClick={() => run("Chopping trees", { command: BotCommandRequestCommand.chopTree, treeType, count: num(treeCount) })}>
              <TreePine className="w-3 h-3 mr-1" /> CHOP
            </Button>
          </div>

          <div className="flex gap-2">
            <Input className={`${inputCls} flex-1`} inputMode="numeric" value={buildSize} onChange={(e) => setBuildSize(e.target.value)}
              placeholder="Shelter size (3–11)" title="Outer size in blocks" />
            <Button size="sm" variant="secondary" className={btnCls}
              onClick={() => run("Building shelter", { command: BotCommandRequestCommand.buildBase, size: num(buildSize) })}>
              <Hammer className="w-3 h-3 mr-1" /> BUILD SHELTER
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Collecting drops", { command: BotCommandRequestCommand.collectItems })}>
              <Grab className="w-3.5 h-3.5 mr-1.5" /> COLLECT DROPS
            </Button>
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Depositing to chest", { command: BotCommandRequestCommand.depositItems })}>
              <Archive className="w-3.5 h-3.5 mr-1.5" /> DEPOSIT LOOT
            </Button>
          </div>

          <div className="flex gap-2">
            {playerSelect(dropTarget, setDropTarget, "Give loot to… (optional)", "select-drop-target")}
            <Button size="sm" variant="secondary" className={btnCls}
              onClick={() => run("Dropping loot", { command: BotCommandRequestCommand.dropItems, target: dropTarget || undefined })}>
              <PackageMinus className="w-3 h-3 mr-1" /> DROP LOOT
            </Button>
          </div>
        </Section>

        <Section title="COMBAT & SURVIVAL">
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-red-500/40 hover:bg-red-500/10`}
              onClick={() => run("Hunting mobs", { command: BotCommandRequestCommand.killMobs })}>
              <Crosshair className="w-3.5 h-3.5 mr-1.5 text-red-400" /> KILL MOBS
            </Button>
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Guarding area", { command: BotCommandRequestCommand.guard })}>
              <Shield className="w-3.5 h-3.5 mr-1.5 text-sky-400" /> GUARD HERE
            </Button>
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Eating", { command: BotCommandRequestCommand.eat })}>
              <UtensilsCrossed className="w-3.5 h-3.5 mr-1.5 text-orange-400" /> EAT
            </Button>
            <Button size="sm" variant="outline" className={`${btnCls} justify-start border-primary/30 hover:bg-primary/10`}
              onClick={() => run("Going to sleep", { command: BotCommandRequestCommand.sleep })}>
              <BedDouble className="w-3.5 h-3.5 mr-1.5 text-indigo-300" /> SLEEP
            </Button>
          </div>
          <div className="flex gap-2">
            <Input className={`${inputCls} flex-1`} placeholder="Entity/mob name (e.g. zombie)…" value={hitTarget}
              onChange={(e) => setHitTarget(e.target.value)} />
            <Button size="sm" variant="secondary" className={btnCls} disabled={!hitTarget.trim()}
              onClick={() => run(`Hitting ${hitTarget}`, { command: BotCommandRequestCommand.hit, target: hitTarget.trim() })}>
              <Hand className="w-3 h-3 mr-1" /> HIT ONCE
            </Button>
          </div>
          <Button size="sm" variant="outline" className={`${btnCls} w-full justify-start border-primary/30 hover:bg-primary/10`}
            onClick={() => run("Using lever/button", { command: BotCommandRequestCommand.pullLever })}>
            <ToggleRight className="w-3.5 h-3.5 mr-1.5" /> PULL NEAREST LEVER / BUTTON
          </Button>
        </Section>

        {pending && (
          <div className="font-mono text-[11px] text-muted-foreground animate-pulse">
            Sending: {pending}…
          </div>
        )}
      </CardContent>
    </Card>
  );
}
