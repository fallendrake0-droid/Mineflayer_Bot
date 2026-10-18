import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useBot } from "@/lib/bot-context";
import { useUpdateBotSettings } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Video, ExternalLink, RefreshCw, Camera } from "lucide-react";

/**
 * Live 3D view from prismarine-viewer, embedded same-origin via the API
 * server's /viewer proxy. Falls back to a direct-port link for setups where
 * the proxy path isn't reachable.
 */
export function ViewerPanel() {
  const { status, settings, setSettingsLocal } = useBot();
  const updateSettings = useUpdateBotSettings();
  const { toast } = useToast();
  const [frameKey, setFrameKey] = useState(0);

  const viewerOn = Boolean(status?.viewerEnabled);
  const sessionKey = status?.stats?.sessionStartedAt ?? "";

  // Re-mount the iframe after each (re)connect so it attaches to the new
  // viewer instance instead of showing a stale black canvas.
  useEffect(() => {
    if (!viewerOn) return undefined;
    const t = setTimeout(() => setFrameKey((k) => k + 1), 600);
    return () => clearTimeout(t);
  }, [viewerOn, sessionKey]);

  const proxiedUrl = `${window.location.origin}${status?.viewerPath ?? "/viewer/"}`;
  const directUrl = `${window.location.protocol}//${window.location.hostname}:${status?.viewerPort ?? 3007}/viewer/`;
  const firstPerson = settings?.viewerFirstPerson ?? true;

  const applySettings = (data: { viewerEnabled?: boolean; viewerFirstPerson?: boolean }) => {
    updateSettings.mutate(
      { data },
      {
        onSuccess: (next) => {
          setSettingsLocal(next);
          // Viewer restarts server-side; reload the frame shortly after.
          setTimeout(() => setFrameKey((k) => k + 1), 900);
        },
        onError: (e) =>
          toast({ title: "Viewer setting failed", description: errMsg(e), variant: "destructive" }),
      },
    );
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5 overflow-hidden">
      <CardHeader className="pb-2 border-b border-primary/10 flex flex-row items-center justify-between">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Video className="w-4 h-4" /> LIVE VIEW
          {viewerOn && (
            <span className="flex items-center gap-1 text-[10px] text-red-400 border border-red-400/40 rounded px-1.5 py-px">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> REC
            </span>
          )}
          <span className="text-[10px] text-muted-foreground font-normal">
            {firstPerson ? "FIRST-PERSON" : "ORBIT (drag to look)"}
          </span>
        </CardTitle>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 font-mono text-[11px]"
            title={firstPerson ? "Switch to orbit camera" : "Switch to first-person camera"}
            onClick={() => applySettings({ viewerFirstPerson: !firstPerson })}
          >
            <Camera className="w-3.5 h-3.5 mr-1" /> {firstPerson ? "ORBIT" : "FIRST-PERSON"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Reload view"
            onClick={() => setFrameKey((k) => k + 1)}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            title="Open full-screen in a new tab"
            onClick={() => window.open(proxiedUrl, "_blank", "noopener")}
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="relative aspect-video bg-[#05070a]">
          {viewerOn ? (
            <iframe
              key={frameKey}
              src={proxiedUrl}
              title="Bot live view"
              className="absolute inset-0 w-full h-full border-0"
              allow="fullscreen"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center p-6">
              <Video className="w-8 h-8 text-muted-foreground/50" />
              <p className="font-mono text-xs text-muted-foreground max-w-xs">
                {settings?.viewerEnabled
                  ? "The viewer didn't start. It may need a moment after connecting — try Reload."
                  : "Live view is disabled. Enable it to watch the world through the bot's eyes."}
              </p>
              {!settings?.viewerEnabled && (
                <Button
                  size="sm"
                  className="font-mono text-xs"
                  onClick={() => applySettings({ viewerEnabled: true })}
                >
                  ENABLE LIVE VIEW
                </Button>
              )}
              <a
                href={directUrl}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-[11px] text-primary/80 hover:underline"
              >
                or open the viewer directly on port {status?.viewerPort ?? 3007}
              </a>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
