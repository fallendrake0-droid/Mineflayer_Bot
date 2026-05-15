import React from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useConnectBot, getGetBotStatusQueryKey } from "@workspace/api-client-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

const connectSchema = z.object({
  host: z.string().min(1, "Host is required"),
  port: z.coerce.number().optional().default(25565),
  username: z.string().min(1, "Username is required"),
  version: z.string().optional()
});

export function ConnectionForm() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const connectMutation = useConnectBot();
  
  const form = useForm<z.infer<typeof connectSchema>>({
    resolver: zodResolver(connectSchema),
    defaultValues: {
      host: "localhost",
      port: 25565,
      username: "MineBot",
      version: "1.20.1",
    },
  });

  const onSubmit = (values: z.infer<typeof connectSchema>) => {
    connectMutation.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        toast({ title: "Connecting..." });
      },
      onError: (error) => {
        toast({ title: "Failed to connect", description: String(error), variant: "destructive" });
      }
    });
  };

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader>
        <CardTitle className="font-mono text-primary text-xl tracking-tight">System.Connect()</CardTitle>
        <CardDescription className="text-muted-foreground font-mono text-xs">Initialize connection to Minecraft server payload</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="host"
                render={({ field }) => (
                  <FormItem>
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
                    <FormLabel className="font-mono text-xs text-muted-foreground">BOT_USERNAME</FormLabel>
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
                    <FormLabel className="font-mono text-xs text-muted-foreground">MC_VERSION</FormLabel>
                    <FormControl>
                      <Input placeholder="1.20.1" className="font-mono bg-card" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <Button 
              type="submit" 
              className="w-full font-mono font-bold tracking-widest mt-4"
              disabled={connectMutation.isPending}
            >
              {connectMutation.isPending ? "CONNECTING..." : "INITIALIZE_CONNECTION"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
