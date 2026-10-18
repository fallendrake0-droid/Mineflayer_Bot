import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useConnectBot } from "@workspace/api-client-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useBot } from "@/lib/bot-context";
import { errMsg } from "@/lib/errors";
import {
  loadProfiles,
  removeProfile,
  upsertProfile,
  type ServerProfile,
} from "@/lib/profiles";
import { Plug, Server, Trash2 } from "lucide-react";

const connectSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().int().min(1).max(65535).default(25565),
  username: z
    .string()
    .min(1, "Username is required")
    .max(16, "Minecraft usernames are at most 16 characters")
    .regex(/^[A-Za-z0-9_]+$/, "Letters, numbers and underscores only"),
  version: z.string().optional(),
  owner: z.string().optional(),
});

type ConnectValues = z.infer<typeof connectSchema>;

const VERSION_SUGGESTIONS = [
  "auto",
  "1.21.4", "1.21.1", "1.20.6", "1.20.4", "1.20.1",
  "1.19.4", "1.19.2", "1.18.2", "1.17.1", "1.16.5",
  "1.12.2", "1.8.8",
];

export function ConnectionForm() {
  const { toast } = useToast();
  const { status } = useBot();
  const connectMutation = useConnectBot();
  const [profiles, setProfiles] = useState<ServerProfile[]>(() => loadProfiles());
  const [remember, setRemember] = useState(true);

  const last = profiles[0];
  const form = useForm<ConnectValues>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      host: last?.host ?? "localhost",
      port: last?.port ?? 25565,
      username: last?.username ?? "MineBot",
      version: last?.version ?? "auto",
      owner: last?.owner ?? "",
    },
  });

  const doConnect = (values: ConnectValues) => {
    const payload = {
      host: values.host.trim(),
      port: values.port,
      username: values.username.trim(),
      version: values.version?.trim() || "auto",
      owner: values.owner?.trim() || undefined,
    };
    connectMutation.mutate(
      { data: payload },
      {
        onSuccess: () => {
          if (remember) {
            setProfiles(
              upsertProfile({
                host: payload.host,
                port: payload.port,
                username: payload.username,
                version: payload.version,
                owner: payload.owner,
              }),
            );
          }
          toast({ title: `Connected as ${payload.username}` });
        },
        onError: (error) => {
          toast({
            title: "Connection failed",
            description: errMsg(error),
            variant: "destructive",
          });
        },
      },
    );
  };

  const connectWithProfile = (profile: ServerProfile) => {
    form.reset({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      version: profile.version,
      owner: profile.owner ?? "",
    });
    doConnect({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      version: profile.version,
      owner: profile.owner ?? "",
    });
  };

  const isBusy =
    connectMutation.isPending ||
    status?.connectionState === "connecting" ||
    status?.connectionState === "reconnecting";

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader>
        <CardTitle className="font-mono text-primary text-xl tracking-tight flex items-center gap-2">
          <Plug className="w-5 h-5" /> Connect Bot
        </CardTitle>
        <CardDescription className="text-muted-foreground font-mono text-xs">
          Join any offline-mode Minecraft Java server. Use version "auto" unless the server is picky.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(doConnect)} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="host"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel className="font-mono text-xs text-muted-foreground">HOST</FormLabel>
                    <FormControl>
                      <Input placeholder="localhost" className="font-mono bg-card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs text-muted-foreground">PORT</FormLabel>
                    <FormControl>
                      <Input type="number" placeholder="25565" className="font-mono bg-card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs text-muted-foreground">BOT USERNAME</FormLabel>
                    <FormControl>
                      <Input placeholder="MineBot" className="font-mono bg-card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="version"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="font-mono text-xs text-muted-foreground">MC VERSION</FormLabel>
                    <FormControl>
                      <>
                        <Input
                          placeholder="auto"
                          className="font-mono bg-card"
                          list="mc-version-suggestions"
                          {...field}
                        />
                        <datalist id="mc-version-suggestions">
                          {VERSION_SUGGESTIONS.map((v) => (
                            <option key={v} value={v} />
                          ))}
                        </datalist>
                      </>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="owner"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="font-mono text-xs text-muted-foreground">
                    YOUR IN-GAME NAME (OPTIONAL)
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. Steve — lets only you use !chat commands"
                      className="font-mono bg-card"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground cursor-pointer select-none">
              <Checkbox
                checked={remember}
                onCheckedChange={(v) => setRemember(v === true)}
              />
              Remember this server
            </label>

            <Button
              type="submit"
              className="w-full font-mono font-bold tracking-widest"
              disabled={isBusy}
            >
              {status?.connectionState === "reconnecting"
                ? `RECONNECTING (attempt ${status.reconnectAttempts ?? 0})…`
                : isBusy
                  ? "CONNECTING…"
                  : "CONNECT"}
            </Button>
          </form>
        </Form>

        {profiles.length > 0 && (
          <div>
            <div className="font-mono text-xs text-muted-foreground mb-2 flex items-center gap-2">
              <Server className="w-3.5 h-3.5" /> SAVED SERVERS
            </div>
            <div className="space-y-2">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 border border-border/60 rounded px-3 py-2 bg-card/50"
                >
                  <button
                    type="button"
                    className="flex-1 text-left font-mono text-xs hover:text-primary transition-colors disabled:opacity-50"
                    disabled={isBusy}
                    onClick={() => connectWithProfile(p)}
                    title="Connect"
                  >
                    <span className="text-foreground font-semibold">{p.username}</span>
                    <span className="text-muted-foreground">
                      {" "}→ {p.host}:{p.port} · MC {p.version}
                    </span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setProfiles(removeProfile(p.id))}
                    title="Remove saved server"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
