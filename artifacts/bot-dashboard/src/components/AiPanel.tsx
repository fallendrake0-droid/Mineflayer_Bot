import React, { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  useGetAiStatus,
  useGetAiConfig,
  useUpdateAiConfig,
  useAiGoal,
  useAiStop,
  useSetAiAutopilot,
  useListAiSkills,
  useGetAiSkill,
  useDeleteAiSkill,
  getGetAiStatusQueryKey,
  getListAiSkillsQueryKey,
  getGetAiSkillQueryKey,
} from "@workspace/api-client-react";
import { useBot } from "@/lib/bot-context";
import { useToast } from "@/hooks/use-toast";
import { errMsg } from "@/lib/errors";
import { Brain, Play, Square, KeyRound, Trash2, Eye, EyeOff, Loader2 } from "lucide-react";

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

export function AiPanel() {
  const { status: botStatus } = useBot();
  const connected = Boolean(botStatus?.connected);
  const { toast } = useToast();

  const statusQuery = useGetAiStatus({
    query: { queryKey: getGetAiStatusQueryKey(), refetchInterval: 2500 },
  });
  const configQuery = useGetAiConfig();
  const skillsQuery = useListAiSkills({
    query: { queryKey: getListAiSkillsQueryKey(), refetchInterval: 5000 },
  });
  const ai = statusQuery.data;
  const cfg = configQuery.data;

  const updateConfig = useUpdateAiConfig();
  const goalMutation = useAiGoal();
  const stopMutation = useAiStop();
  const autopilotMutation = useSetAiAutopilot();
  const deleteSkill = useDeleteAiSkill();

  const [goal, setGoal] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [viewSkill, setViewSkill] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const skillDetail = useGetAiSkill(viewSkill ?? "", {
    query: { queryKey: getGetAiSkillQueryKey(viewSkill ?? ""), enabled: !!viewSkill },
  });

  useEffect(() => {
    if (cfg) {
      setModel(cfg.model ?? "");
      setBaseUrl(cfg.baseUrl ?? "");
    }
  }, [cfg]);

  const configured = Boolean(ai?.configured ?? cfg?.hasKey);
  const enabled = ai?.enabled !== false;
  const busy = Boolean(ai?.goalActive);
  const skills = skillsQuery.data?.skills ?? [];

  const fail = (title: string) => (err: unknown) =>
    toast({ title, description: errMsg(err), variant: "destructive" });

  const saveConfig = () => {
    const data: { apiKey?: string; model?: string; baseUrl?: string } = {};
    if (apiKey.trim()) data.apiKey = apiKey.trim();
    if (model.trim() && model.trim() !== (cfg?.model ?? "")) data.model = model.trim();
    if (baseUrl.trim() && baseUrl.trim() !== (cfg?.baseUrl ?? "")) data.baseUrl = baseUrl.trim();
    if (Object.keys(data).length === 0) {
      toast({ title: "Nothing to save", description: "Paste an API key or change the model first." });
      return;
    }
    updateConfig.mutate(
      { data },
      {
        onSuccess: () => {
          setApiKey("");
          toast({ title: "AI configuration saved" });
          void configQuery.refetch();
          void statusQuery.refetch();
        },
        onError: fail("Could not save AI config"),
      },
    );
  };

  const sendGoal = () => {
    const g = goal.trim();
    if (!g) return;
    goalMutation.mutate(
      { data: { goal: g } },
      {
        onSuccess: () => {
          setGoal("");
          toast({ title: "Goal sent to AI brain" });
          void statusQuery.refetch();
        },
        onError: fail("AI goal rejected"),
      },
    );
  };

  const configForm = (
    <div className="space-y-2">
      <label className="block">
        <span className="font-mono text-[10px] text-muted-foreground">API KEY</span>
        <Input
          type="password"
          autoComplete="off"
          className={`${inputCls} mt-1`}
          placeholder={cfg?.hasKey ? "•••••• configured — paste to replace" : "Paste your AI API key"}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="font-mono text-[10px] text-muted-foreground">MODEL</span>
          <Input className={`${inputCls} mt-1`} placeholder="gemini-2.5-flash" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] text-muted-foreground">BASE URL</span>
          <Input className={`${inputCls} mt-1`} placeholder="https://…" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      </div>
      <Button size="sm" variant="secondary" className={`${btnCls} w-full justify-center`} onClick={saveConfig} disabled={updateConfig.isPending}>
        <KeyRound className="w-3 h-3 mr-1" /> SAVE PROVIDER CONFIG
      </Button>
      <p className="font-mono text-[10px] text-muted-foreground leading-relaxed">
        Free key (Gemini):{" "}
        <a className="text-primary underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
          aistudio.google.com/apikey
        </a>{" "}
        → "Create API key". Stored server-side only, never shown again.
      </p>
    </div>
  );

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Brain className="w-4 h-4" /> AI BRAIN
          <span className="ml-auto font-mono text-[10px] tracking-normal">
            {!configured ? (
              <span className="text-amber-400">NO API KEY</span>
            ) : busy ? (
              <span className="text-primary animate-pulse">WORKING…</span>
            ) : ai?.autopilot ? (
              <span className="text-primary animate-pulse">AUTOPILOT</span>
            ) : (
              <span className="text-muted-foreground">READY</span>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        {!configured ? (
          <>
            <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
              Give the bot an LLM brain: plain-English goals, autopilot play, and skills it writes
              for itself. Add an API key to switch it on.
            </p>
            {configForm}
          </>
        ) : (
          <>
            {!enabled && (
              <div className="font-mono text-[11px] text-amber-400 border border-amber-500/30 bg-amber-500/5 rounded px-2 py-1.5">
                AI brain is disabled — enable "AI brain" in AUTOMATION settings.
              </div>
            )}

            {ai?.currentGoal && (
              <div className="font-mono text-[11px] text-foreground border border-primary/30 bg-primary/5 rounded px-2 py-1.5 flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                <span className="truncate" title={ai.currentGoal}>{ai.currentGoal}</span>
              </div>
            )}
            {!ai?.currentGoal && ai?.lastOutcome && (
              <div className="font-mono text-[11px] text-muted-foreground truncate" title={ai.lastOutcome}>
                Last: {ai.lastOutcome}
              </div>
            )}

            <Section title="GIVE A GOAL (PLAIN ENGLISH)">
              <div className="flex gap-2">
                <Input
                  className={`${inputCls} flex-1`}
                  placeholder="e.g. chop 3 oak trees then build a shelter"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") sendGoal();
                  }}
                  disabled={!connected || busy || !enabled}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className={btnCls}
                  disabled={!connected || busy || !enabled || !goal.trim() || goalMutation.isPending}
                  onClick={sendGoal}
                  title={connected ? "Send goal to the AI brain" : "Connect the bot first"}
                >
                  <Play className="w-3 h-3 mr-1" /> GO
                </Button>
                {(busy || ai?.autopilot) && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className={btnCls}
                    onClick={() =>
                      stopMutation.mutate(undefined, {
                        onSuccess: () => void statusQuery.refetch(),
                        onError: fail("Stop failed"),
                      })
                    }
                  >
                    <Square className="w-3 h-3 mr-1" /> STOP AI
                  </Button>
                )}
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <div className="min-w-0">
                  <div className="font-mono text-xs text-foreground">Autopilot</div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    AI chooses its own goals & plays like a real player
                  </div>
                </div>
                <Switch
                  checked={Boolean(ai?.autopilot)}
                  disabled={!connected || !enabled || autopilotMutation.isPending}
                  onCheckedChange={(v) =>
                    autopilotMutation.mutate(
                      { data: { enabled: v } },
                      { onSuccess: () => void statusQuery.refetch(), onError: fail("Autopilot failed") },
                    )
                  }
                />
              </div>
              <div className="font-mono text-[10px] text-muted-foreground">
                {ai?.model} · {ai?.usage.calls ?? 0} AI calls · {ai?.usage.promptTokens ?? 0}+
                {ai?.usage.completionTokens ?? 0} tokens · in-game: !ai &lt;goal&gt;, !auto
              </div>
            </Section>

            <Section title={`SKILL LIBRARY (${skills.length})`}>
              {skills.length === 0 ? (
                <p className="font-mono text-[11px] text-muted-foreground leading-relaxed">
                  No skills yet. When a goal needs abilities the bot doesn't have, the AI writes
                  JavaScript skills here (sandboxed) and reuses them.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {skills.map((s) => (
                    <div key={s.name} className="border border-border/40 rounded px-2 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-foreground">{s.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground ml-auto shrink-0">
                          {s.runs} runs · ✓{s.successes} ✗{s.failures}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0"
                          title={viewSkill === s.name ? "Hide code" : "View code"}
                          onClick={() => setViewSkill(viewSkill === s.name ? null : s.name)}
                        >
                          {viewSkill === s.name ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        </Button>
                        {confirmDelete === s.name ? (
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-6 font-mono text-[10px] px-1.5"
                            onClick={() =>
                              deleteSkill.mutate(
                                { name: s.name },
                                {
                                  onSuccess: () => {
                                    setConfirmDelete(null);
                                    if (viewSkill === s.name) setViewSkill(null);
                                    void skillsQuery.refetch();
                                  },
                                  onError: fail("Delete failed"),
                                },
                              )
                            }
                          >
                            DELETE?
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                            title="Delete skill"
                            onClick={() => {
                              setConfirmDelete(s.name);
                              setTimeout(() => setConfirmDelete((cur) => (cur === s.name ? null : cur)), 3000);
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                      {s.description && (
                        <div className="font-mono text-[10px] text-muted-foreground truncate" title={s.description}>
                          {s.description}
                        </div>
                      )}
                      {viewSkill === s.name && (
                        <pre className="mt-2 max-h-56 overflow-auto rounded bg-card p-2 font-mono text-[10px] leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
                          {skillDetail.isLoading ? "Loading…" : (skillDetail.data?.code ?? "(unavailable)")}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="PROVIDER">{configForm}</Section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
