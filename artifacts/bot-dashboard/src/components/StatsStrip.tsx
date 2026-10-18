import React from "react";
import { useBot } from "@/lib/bot-context";
import { Pickaxe, TreePine, Axe, Sword, Package, Skull, Route } from "lucide-react";

const TILES = [
  { key: "blocksMined", label: "MINED", Icon: Pickaxe, color: "text-sky-400" },
  { key: "logsChopped", label: "LOGS", Icon: Axe, color: "text-amber-500" },
  { key: "treesChopped", label: "TREES", Icon: TreePine, color: "text-emerald-400" },
  { key: "mobsKilled", label: "KILLS", Icon: Sword, color: "text-red-400" },
  { key: "itemsCollected", label: "PICKUPS", Icon: Package, color: "text-violet-400" },
  { key: "distanceWalked", label: "METRES", Icon: Route, color: "text-cyan-300" },
  { key: "deaths", label: "DEATHS", Icon: Skull, color: "text-zinc-400" },
] as const;

export function StatsStrip() {
  const { status } = useBot();
  const stats = status?.stats;
  if (!stats) return null;

  return (
    <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
      {TILES.map(({ key, label, Icon, color }) => (
        <div
          key={key}
          className="border border-primary/15 bg-black rounded px-2 py-2 text-center shadow shadow-primary/5"
        >
          <Icon className={`w-4 h-4 mx-auto ${color}`} />
          <div className="font-mono text-sm font-bold text-foreground mt-1">
            {stats[key] ?? 0}
          </div>
          <div className="font-mono text-[9px] text-muted-foreground tracking-wider">{label}</div>
        </div>
      ))}
    </div>
  );
}
