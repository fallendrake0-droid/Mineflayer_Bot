import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useBot } from "@/lib/bot-context";
import {
  useExecuteBotCommand,
  BotCommandRequestCommand,
  type InventoryItem,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Package, Shield, Sword, Wrench, Drumstick, Box, CircleDot } from "lucide-react";

const CATEGORY_STYLE: Record<string, { Icon: typeof Package; iconCls: string; cellCls: string }> = {
  armor: { Icon: Shield, iconCls: "text-sky-400", cellCls: "border-sky-500/40 bg-sky-500/5" },
  weapon: { Icon: Sword, iconCls: "text-red-400", cellCls: "border-red-500/40 bg-red-500/5" },
  tool: { Icon: Wrench, iconCls: "text-orange-400", cellCls: "border-orange-500/40 bg-orange-500/5" },
  food: { Icon: Drumstick, iconCls: "text-amber-500", cellCls: "border-amber-500/40 bg-amber-500/5" },
  block: { Icon: Box, iconCls: "text-zinc-300", cellCls: "border-zinc-500/40 bg-zinc-500/5" },
  other: { Icon: CircleDot, iconCls: "text-zinc-400", cellCls: "border-border bg-card/60" },
};

const ARMOR_SLOTS: Array<{ slot: number; label: string }> = [
  { slot: 5, label: "HEAD" },
  { slot: 6, label: "CHEST" },
  { slot: 7, label: "LEGS" },
  { slot: 8, label: "FEET" },
  { slot: 45, label: "OFF-HAND" },
];

export function InventoryPanel() {
  const { inventory, status } = useBot();
  const executeCommand = useExecuteBotCommand();
  const { toast } = useToast();

  const items = inventory?.items ?? [];
  const bySlot = new Map<number, InventoryItem>(items.map((i) => [i.slot, i]));
  const selectedSlot = inventory?.selectedSlot;
  const connected = Boolean(status?.connected);

  const act = (label: string, command: BotCommandRequestCommand, item: InventoryItem, count?: number) => {
    executeCommand.mutate(
      { data: { command, slot: item.slot, count } },
      {
        onSuccess: () => toast({ title: `${label}: ${item.displayName ?? item.name}` }),
        onError: (e) =>
          toast({ title: "Inventory action failed", description: errMsg(e), variant: "destructive" }),
      },
    );
  };

  const renderCell = (slot: number) => {
    const item = bySlot.get(slot);
    const isSelected = slot === selectedSlot;
    if (!item) {
      return (
        <div
          key={slot}
          className={`w-10 h-10 sm:w-11 sm:h-11 rounded border ${
            isSelected ? "border-primary/70 ring-1 ring-primary/50" : "border-zinc-800"
          } bg-zinc-950`}
          title={`Slot ${slot} (empty)`}
        />
      );
    }
    const style = CATEGORY_STYLE[item.category] ?? CATEGORY_STYLE.other;
    const label = item.displayName ?? item.name;
    return (
      <DropdownMenu key={slot}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!connected}
            className={`relative w-10 h-10 sm:w-11 sm:h-11 rounded border ${style.cellCls} ${
              isSelected ? "ring-2 ring-primary" : ""
            } flex flex-col items-center justify-center hover:ring-1 hover:ring-primary/60 transition-shadow disabled:opacity-60`}
            title={`${label} ×${item.count} — click for actions`}
          >
            <style.Icon className={`w-4.5 h-4.5 sm:w-5 sm:h-5 ${style.iconCls}`} />
            <span className="font-mono text-[8px] leading-none text-zinc-300 mt-0.5 max-w-full px-0.5 truncate">
              {item.name.replace(/^minecraft:/, "").replace(/_/g, " ")}
            </span>
            {item.count > 1 && (
              <span className="absolute bottom-0.5 right-1 font-mono text-[10px] font-bold text-white [text-shadow:1px_1px_0_#000]">
                {item.count}
              </span>
            )}
            {item.durability !== undefined && (
              <span className="absolute bottom-0 left-0 right-0 h-[3px] bg-zinc-800">
                <span
                  className="block h-full"
                  style={{
                    width: `${item.durability * 100}%`,
                    backgroundColor: `hsl(${Math.round(item.durability * 120)} 70% 45%)`,
                  }}
                />
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="font-mono text-xs">
          <DropdownMenuLabel>
            {label} <span className="text-muted-foreground">×{item.count}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => act("Equip", BotCommandRequestCommand.equipItem, item)}>
            Equip / hold
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => act(item.category === "food" ? "Eat" : "Use", BotCommandRequestCommand.useItem, item)}>
            {item.category === "food" ? "Eat" : "Use"}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => act("Drop one", BotCommandRequestCommand.tossItem, item, 1)}>
            Drop 1
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => act("Drop stack", BotCommandRequestCommand.tossItem, item)}
          >
            Drop whole stack
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const mainSlots = Array.from({ length: 27 }, (_, i) => 9 + i);
  const hotbarSlots = Array.from({ length: 9 }, (_, i) => 36 + i);

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10 flex flex-row items-center justify-between">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Package className="w-4 h-4" /> INVENTORY
          <span className="text-[10px] text-muted-foreground font-normal">
            {items.length} stacks · click an item for actions
          </span>
        </CardTitle>
        {inventory?.heldItem && (
          <span className="font-mono text-[10px] text-muted-foreground">
            HELD: <span className="text-primary">{inventory.heldItem}</span>
          </span>
        )}
      </CardHeader>
      <CardContent className="p-3 space-y-2">
        {/* Armor + off-hand */}
        <div className="flex gap-1 items-end">
          {ARMOR_SLOTS.map(({ slot, label }) => (
            <div key={slot} className="flex flex-col items-center gap-0.5">
              {renderCell(slot)}
              <span className="font-mono text-[8px] text-zinc-500">{label}</span>
            </div>
          ))}
          {items.length === 0 && (
            <span className="font-mono text-[11px] text-muted-foreground ml-3 pb-3">
              INVENTORY_EMPTY
            </span>
          )}
        </div>
        <div className="grid grid-cols-9 gap-1">{mainSlots.map(renderCell)}</div>
        <div className="grid grid-cols-9 gap-1 pt-1.5 border-t border-zinc-800">{hotbarSlots.map(renderCell)}</div>
      </CardContent>
    </Card>
  );
}
