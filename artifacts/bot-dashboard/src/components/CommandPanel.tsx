import React, { useState } from "react";
import { useExecuteBotCommand } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BotCommandRequestCommand, BotCommandRequestResource, BotCommandRequestTreeType } from "@workspace/api-client-react";
import { Play, Square, Crosshair, Pickaxe, PackageMinus, Hammer, ArrowUp, Hand, ToggleRight, TreePine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function CommandPanel() {
  const executeCommand = useExecuteBotCommand();
  const { toast } = useToast();
  
  const [followTarget, setFollowTarget] = useState("");
  const [hitTarget, setHitTarget] = useState("");
  const [hitPlayerTarget, setHitPlayerTarget] = useState("");
  const [dropTarget, setDropTarget] = useState("");
  const [mineResource, setMineResource] = useState<BotCommandRequestResource>(BotCommandRequestResource.stone);
  const [treeType, setTreeType] = useState<BotCommandRequestTreeType>(BotCommandRequestTreeType.any);

  const handleCommand = (
    command: BotCommandRequestCommand,
    target?: string,
    resource?: BotCommandRequestResource,
    treeTypeVal?: BotCommandRequestTreeType
  ) => {
    executeCommand.mutate({ data: { command, target, resource, treeType: treeTypeVal } }, {
      onSuccess: () => {
        toast({ title: `Command ${command} executed` });
      },
      onError: (err) => {
        toast({ title: "Command failed", description: String(err), variant: "destructive" });
      }
    });
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Play className="w-4 h-4" /> COMMAND_MATRIX
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        
        {/* Core Actions */}
        <div className="grid grid-cols-2 gap-2">
          <Button
            data-testid="button-stop"
            variant="destructive"
            className="font-mono text-xs w-full justify-start gap-2"
            onClick={() => handleCommand(BotCommandRequestCommand.stop)}
          >
            <Square className="w-4 h-4" /> STOP_ACTION
          </Button>
          <Button
            data-testid="button-killmobs"
            variant="outline"
            className="font-mono text-xs w-full justify-start gap-2 border-primary/30 hover:bg-primary/10"
            onClick={() => handleCommand(BotCommandRequestCommand.killMobs)}
          >
            <Crosshair className="w-4 h-4" /> KILL_MOBS
          </Button>
          <Button
            data-testid="button-buildbase"
            variant="outline"
            className="font-mono text-xs w-full justify-start gap-2 border-primary/30 hover:bg-primary/10"
            onClick={() => handleCommand(BotCommandRequestCommand.buildBase)}
          >
            <Hammer className="w-4 h-4" /> BUILD_BASE
          </Button>
          <Button
            data-testid="button-climb"
            variant="outline"
            className="font-mono text-xs w-full justify-start gap-2 border-primary/30 hover:bg-primary/10"
            onClick={() => handleCommand(BotCommandRequestCommand.climb)}
          >
            <ArrowUp className="w-4 h-4" /> CLIMB_UP
          </Button>
          <Button
            data-testid="button-pulllever"
            variant="outline"
            className="font-mono text-xs w-full justify-start gap-2 border-primary/30 hover:bg-primary/10 col-span-2"
            onClick={() => handleCommand(BotCommandRequestCommand.pullLever)}
          >
            <ToggleRight className="w-4 h-4" /> PULL_LEVER
          </Button>
        </div>

        <div className="h-px w-full bg-border/50" />

        {/* Targeted Actions */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              data-testid="input-hit-target"
              placeholder="Target entity..."
              className="font-mono text-xs h-8 bg-card"
              value={hitTarget}
              onChange={e => setHitTarget(e.target.value)}
            />
            <Button
              data-testid="button-hit"
              size="sm"
              variant="secondary"
              className="font-mono text-xs whitespace-nowrap h-8"
              onClick={() => handleCommand(BotCommandRequestCommand.hit, hitTarget)}
            >
              <Hand className="w-3 h-3 mr-2" /> HIT
            </Button>
          </div>
          
          <div className="flex gap-2">
            <Input
              data-testid="input-follow-target"
              placeholder="Player name..."
              className="font-mono text-xs h-8 bg-card"
              value={followTarget}
              onChange={e => setFollowTarget(e.target.value)}
            />
            <Button
              data-testid="button-follow"
              size="sm"
              variant="secondary"
              className="font-mono text-xs whitespace-nowrap h-8"
              onClick={() => handleCommand(BotCommandRequestCommand.follow, followTarget)}
            >
              FOLLOW
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              data-testid="input-hitplayer-target"
              placeholder="Player name..."
              className="font-mono text-xs h-8 bg-card"
              value={hitPlayerTarget}
              onChange={e => setHitPlayerTarget(e.target.value)}
            />
            <Button
              data-testid="button-hitplayer"
              size="sm"
              variant="secondary"
              className="font-mono text-xs whitespace-nowrap h-8"
              onClick={() => handleCommand(BotCommandRequestCommand.hitPlayer, hitPlayerTarget)}
            >
              HIT_PLAYER
            </Button>
          </div>

          <div className="flex gap-2">
            <Input
              data-testid="input-drop-target"
              placeholder="Player name (optional)"
              className="font-mono text-xs h-8 bg-card"
              value={dropTarget}
              onChange={e => setDropTarget(e.target.value)}
            />
            <Button
              data-testid="button-drop"
              size="sm"
              variant="secondary"
              className="font-mono text-xs whitespace-nowrap h-8"
              onClick={() => handleCommand(BotCommandRequestCommand.dropItems, dropTarget)}
            >
              <PackageMinus className="w-3 h-3 mr-2" /> DROP_ITEMS
            </Button>
          </div>

          <div className="flex gap-2">
            <Select value={mineResource} onValueChange={(v) => setMineResource(v as BotCommandRequestResource)}>
              <SelectTrigger data-testid="select-mine-resource" className="h-8 font-mono text-xs">
                <SelectValue placeholder="Resource" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="iron">Iron</SelectItem>
                <SelectItem value="diamond">Diamond</SelectItem>
                <SelectItem value="gold">Gold</SelectItem>
                <SelectItem value="redstone">Redstone</SelectItem>
                <SelectItem value="lapis">Lapis</SelectItem>
                <SelectItem value="stone">Stone</SelectItem>
              </SelectContent>
            </Select>
            <Button
              data-testid="button-mine"
              size="sm"
              variant="secondary"
              className="font-mono text-xs whitespace-nowrap h-8"
              onClick={() => handleCommand(BotCommandRequestCommand.mine, undefined, mineResource)}
            >
              <Pickaxe className="w-3 h-3 mr-2" /> MINE
            </Button>
          </div>

          <div className="h-px w-full bg-border/30" />

          {/* Chop Tree */}
          <div className="flex gap-2">
            <Select value={treeType} onValueChange={(v) => setTreeType(v as BotCommandRequestTreeType)}>
              <SelectTrigger data-testid="select-tree-type" className="h-8 font-mono text-xs">
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
            <Button
              data-testid="button-choptree"
              size="sm"
              className="font-mono text-xs whitespace-nowrap h-8 bg-emerald-700 hover:bg-emerald-600 text-white"
              onClick={() => handleCommand(BotCommandRequestCommand.chopTree, undefined, undefined, treeType)}
            >
              <TreePine className="w-3 h-3 mr-2" /> CHOP_TREE
            </Button>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
