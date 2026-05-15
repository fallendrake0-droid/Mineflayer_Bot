import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetBotInventory, getGetBotInventoryQueryKey } from "@workspace/api-client-react";
import { Package, Shield, PenTool } from "lucide-react";

export function InventoryPanel() {
  const { data } = useGetBotInventory({
    query: { refetchInterval: 3000, queryKey: getGetBotInventoryQueryKey() }
  });

  const items = data?.items || [];
  
  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Package className="w-4 h-4" /> INVENTORY
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        {items.length === 0 ? (
          <div className="font-mono text-xs text-muted-foreground text-center p-4 border border-dashed border-border rounded">
            INVENTORY_EMPTY
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {items.map((item, i) => (
              <div key={i} className={`p-2 rounded border font-mono text-[10px] flex flex-col items-center justify-center relative group
                ${item.isArmor ? 'border-blue-500/30 bg-blue-500/5' : 
                  item.isTool ? 'border-orange-500/30 bg-orange-500/5' : 
                  'border-border bg-card'}
              `}>
                <div className="absolute top-1 left-1 opacity-50">S{item.slot}</div>
                {item.isArmor && <Shield className="w-4 h-4 text-blue-500 mb-1 opacity-80" />}
                {item.isTool && <PenTool className="w-4 h-4 text-orange-500 mb-1 opacity-80" />}
                {(!item.isArmor && !item.isTool) && <div className="w-4 h-4 bg-muted mb-1 opacity-30 rounded-sm" />}
                
                <span className="truncate w-full text-center mt-1" title={item.name}>{item.name.replace('minecraft:', '')}</span>
                <span className="font-bold text-primary absolute bottom-1 right-1">x{item.count}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
