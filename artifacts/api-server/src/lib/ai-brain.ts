/**
 * The AI brain: turns natural-language goals into executed bot actions.
 *
 * Loop (ReAct-style, Voyager-inspired):
 *   context → LLM plan (JSON steps / new skill) → execute → feedback → …
 *
 * The brain is deliberately decoupled from BotManager through BrainHost:
 * the manager supplies state snapshots, executes built-in actions (each
 * as a normal cancellable task), runs skills, and owns abort semantics.
 */
import { type AiClient, type AiChatMessage, extractJsonObject } from "./ai-client";
import { type SkillLibrary, screenSkillCode, validateSkillName } from "./ai-skills";
import { RESOURCES, TREE_TYPES } from "./bot-data";

export interface BrainStepResult {
  action: string;
  ok: boolean;
  detail: string;
}

export interface BrainHost {
  isConnected(): boolean;
  shouldAbort(): boolean;
  getContext(): Record<string, unknown>;
  executeAction(action: string, args: Record<string, unknown>): Promise<BrainStepResult>;
  runSkill(
    skill: { name: string; code: string },
    args: Record<string, unknown>,
  ): Promise<BrainStepResult>;
  say(message: string): void;
  log(message: string, level?: "info" | "warn" | "error" | "success"): void;
  recentLogLines(count: number): string[];
}

interface AiPlanStep {
  action: string;
  args: Record<string, unknown>;
}

interface AiPlan {
  say?: string;
  done: boolean;
  reasoning?: string;
  steps: AiPlanStep[];
  newSkill?: { name: string; description: string; code: string };
}

const MAX_STEPS_PER_ROUND = 5;
const MAX_HISTORY_ENTRIES = 14;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePlan(raw: Record<string, unknown>): AiPlan | null {
  const steps: AiPlanStep[] = [];
  if (Array.isArray(raw.steps)) {
    for (const entry of raw.steps.slice(0, MAX_STEPS_PER_ROUND)) {
      const step = asRecord(entry);
      if (typeof step.action === "string" && step.action) {
        steps.push({ action: step.action, args: asRecord(step.args) });
      }
    }
  }
  let newSkill: AiPlan["newSkill"];
  if (raw.newSkill && typeof raw.newSkill === "object") {
    const ns = asRecord(raw.newSkill);
    if (typeof ns.name === "string" && typeof ns.code === "string") {
      newSkill = {
        name: ns.name,
        description: typeof ns.description === "string" ? ns.description : "",
        code: ns.code,
      };
    }
  }
  const say = typeof raw.say === "string" ? raw.say : undefined;
  const done = raw.done === true;
  if (steps.length === 0 && !newSkill && !done && !say) return null;
  return {
    say,
    done,
    reasoning: typeof raw.reasoning === "string" ? raw.reasoning : undefined,
    steps,
    newSkill,
  };
}

function buildSystemPrompt(skillCatalog: Array<{ name: string; description: string }>): string {
  const resources = Object.keys(RESOURCES).join(", ");
  const trees = Object.keys(TREE_TYPES).join(", ");
  const skills =
    skillCatalog.length > 0
      ? skillCatalog.map((s) => `- ${s.name}: ${s.description}`).join("\n")
      : "(none yet — you can create some with newSkill)";

  return `You are the brain of a Minecraft Java Edition bot playing on a survival server. You think, talk and act like a helpful human player. You never control the game directly — you reply with ONE JSON plan at a time and the bot executes it, then reports back with fresh state.

RESPONSE FORMAT — reply with ONLY this JSON object, nothing else:
{
  "reasoning": "one short sentence: what you are doing and why",
  "say": "optional short in-game chat message (friendly, human, max 200 chars; don't spam)",
  "steps": [ { "action": "...", "args": { } } ],   // up to ${MAX_STEPS_PER_ROUND}, executed in order
  "newSkill": { "name": "snake_case", "description": "one line", "code": "..." },  // optional, see below
  "done": false   // true (with no steps) only when the goal is fully achieved or clearly impossible
}

BUILT-IN ACTIONS:
- say {message} — chat in game
- goto {x, y, z} — pathfind to coordinates (y optional)
- come {player} — walk to a player's current position
- follow {player} — keep following (ongoing; plan it as the last step)
- mine {resource, count} — resource one of: ${resources}. Needs a suitable pickaxe in inventory. count 1-256
- chop {treeType, count} — treeType one of: ${trees}, or "any". count = number of trees (1-64)
- killMobs {} — attack all nearby hostile mobs
- attack {target} — attack one named entity/player once
- guard {} — stay and defend this spot (ongoing)
- wander {} — stroll around exploring (ongoing)
- eat {} — eat the best food in inventory
- sleep {} — find the nearest bed and sleep (night only)
- build {size} — build a small shelter (size 3-9, default 5); needs building blocks in inventory
- climb {blocks} — pillar up N blocks (needs throwaway blocks)
- collect {} — pick up nearby dropped items
- deposit {} — put inventory into the nearest chest/barrel (keeps tools/food/armor)
- giveTo {player} — walk to the player and drop non-essential items for them
- dropItem {item, count} — toss items on the ground
- equip {item} — equip an item/armor piece by name
- pullLever {} — flip the nearest lever/button
- wait {seconds} — idle briefly (max 60)
- runSkill {name, args} — run one of YOUR saved skills (list below)

SAVED SKILLS:
${skills}

WRITING NEW SKILLS (how you learn complex tasks):
When built-in actions can't do the job (precise building, farming patterns, sorting, exploring strategies, combining sensing + acting), include ONE "newSkill" with JavaScript code. It runs immediately; if it errors, you get the error back and may send a corrected version with the SAME name. Reuse skills via runSkill instead of rewriting them.
Skill code runs in a sealed sandbox with a single \`api\` object (all helpers throw if the user presses STOP):
- api.say(msg), api.log(msg)
- await api.sleep(ms) — max 30000; api.checkpoint() — call in every loop iteration
- api.pos() -> {x,y,z}; api.health() (0-20); api.food() (0-20); api.heldItem() -> name|null
- api.inventory() -> [{name, count, slot}]
- api.blockAt(x,y,z) -> block name ("air" if empty, null if unknown)
- api.findBlocks(nameOrNames, maxDist=32, count=8) -> [{x,y,z}] nearest first
- api.entities(maxDist=32) -> [{name, type, distance, x, y, z}]
- api.playerPos(username) -> {x,y,z}|null
- await api.goto(x,y,z,range=1) -> boolean
- await api.dig(x,y,z) -> boolean (walks into range, digs)
- await api.collect(radius=12) -> number collected
- await api.place(itemName,x,y,z) -> "placed"|"present"|"failed"
- await api.equip(itemName, dest="hand") -> boolean;  await api.toss(itemName, count?) -> boolean
- await api.eat();  await api.attackNearest(maxDist=16) -> boolean;  await api.lookAt(x,y,z)
- api.timeOfDay() -> "day"|"sunset"|"night"|"sunrise"
- api.args — the args object from runSkill
Rules: top-level await is fine; ALWAYS await helpers (never busy-loop); return a short string result; max runtime 3 minutes; NO require/import/process/fetch/eval — they are blocked and the skill will be rejected.
Example skill:
const logs = api.findBlocks(["oak_log","birch_log","spruce_log"], 32, 6);
if (!logs.length) return "no trees nearby";
for (const b of logs) { api.checkpoint(); await api.dig(b.x, b.y, b.z); }
await api.collect(10);
return "gathered wood";

PLAY WELL:
- Keep steps small and verifiable; check state between rounds instead of assuming success.
- Eat when food is low; avoid fights at low health; seek shelter/bed at night if exposed.
- Modest counts per step (e.g. mine 16, not 256) so you can react to problems.
- If a step fails twice for the same reason, change approach or write a skill; if truly impossible (missing tool, unreachable), say so and finish (done=true).
- Prefer built-in actions and existing skills over writing new code.
- When the goal is "(autopilot)", choose your own worthwhile next goal like a real survival player: secure food and wood, progress tools (wood→stone→iron), build shelter before night, explore, help nearby players. Finish that goal, then you'll be asked again.
- Be a good citizen: don't grief, don't steal from players' chests, greet players you meet.`;
}

export class AiBrain {
  readonly usage = { calls: 0, promptTokens: 0, completionTokens: 0 };

  private readonly client: AiClient;
  private readonly skills: SkillLibrary;
  private readonly host: BrainHost;

  constructor(client: AiClient, skills: SkillLibrary, host: BrainHost) {
    this.client = client;
    this.skills = skills;
    this.host = host;
  }

  private async plan(
    goal: string,
    history: string[],
  ): Promise<AiPlan> {
    const system = buildSystemPrompt(this.skills.catalog());
    const user = [
      `GOAL: ${goal}`,
      "",
      "CURRENT STATE (JSON):",
      JSON.stringify(this.host.getContext()),
      "",
      "RECENT HISTORY:",
      history.length > 0 ? history.join("\n") : "(just started)",
      "",
      "RECENT GAME LOG:",
      this.host.recentLogLines(8).join("\n") || "(quiet)",
    ].join("\n");

    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.client.chat(messages, { temperature: 0.4, maxTokens: 2000 });
      this.usage.calls += 1;
      this.usage.promptTokens += result.promptTokens;
      this.usage.completionTokens += result.completionTokens;
      const parsed = extractJsonObject(result.content);
      const plan = parsed ? normalizePlan(parsed) : null;
      if (plan) return plan;
      messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: "That was not a valid plan. Reply with ONLY the JSON object described in the format — no prose, no markdown fences.",
      });
    }
    throw new Error("AI returned an unparseable plan twice in a row");
  }

  /**
   * Run one goal to completion (or abort/limit). `goal === null` means
   * autopilot: the model picks its own goal for this cycle.
   */
  async runGoal(
    goal: string | null,
    opts?: { maxRounds?: number },
  ): Promise<{ outcome: string }> {
    const goalText = goal ?? "(autopilot — choose your own worthwhile goal this cycle)";
    const maxRounds = opts?.maxRounds ?? 10;
    const history: string[] = [];
    const pushHistory = (line: string) => {
      history.push(line.slice(0, 300));
      while (history.length > MAX_HISTORY_ENTRIES) history.shift();
    };

    for (let round = 1; round <= maxRounds; round++) {
      if (this.host.shouldAbort() || !this.host.isConnected()) {
        return { outcome: "aborted" };
      }

      const plan = await this.plan(goalText, history);
      if (plan.reasoning) this.host.log(`AI: ${plan.reasoning.slice(0, 200)}`);
      if (plan.say) this.host.say(plan.say.slice(0, 240));

      if (plan.done && !plan.newSkill && plan.steps.length === 0) {
        return { outcome: plan.reasoning ?? "goal completed" };
      }

      if (plan.newSkill) {
        const result = await this.handleNewSkill(plan.newSkill);
        pushHistory(`round ${round} newSkill ${plan.newSkill.name} -> ${result}`);
        if (this.host.shouldAbort()) return { outcome: "aborted" };
        continue;
      }

      for (const step of plan.steps) {
        if (this.host.shouldAbort() || !this.host.isConnected()) {
          return { outcome: "aborted" };
        }
        const result = await this.executeStep(step);
        pushHistory(
          `round ${round} step ${step.action} ${JSON.stringify(step.args).slice(0, 120)} -> ${result.detail}`,
        );
        if (!result.ok && result.detail.includes("interrupted") && !this.host.shouldAbort()) {
          // A human command preempted the step — replan from fresh state.
          break;
        }
      }
    }
    return { outcome: `stopped after ${maxRounds} planning rounds (goal may be incomplete)` };
  }

  private async executeStep(step: AiPlanStep): Promise<BrainStepResult> {
    if (step.action === "runSkill") {
      const name = typeof step.args.name === "string" ? step.args.name : "";
      const skill = this.skills.get(name);
      if (!skill) {
        return {
          action: step.action,
          ok: false,
          detail: `unknown skill "${name}" — create it first with newSkill`,
        };
      }
      const result = await this.host.runSkill(skill, asRecord(step.args.args));
      this.skills.recordRun(name, result.ok);
      return result;
    }
    return this.host.executeAction(step.action, step.args);
  }

  private async handleNewSkill(newSkill: {
    name: string;
    description: string;
    code: string;
  }): Promise<string> {
    const nameError = validateSkillName(newSkill.name);
    if (nameError) return `rejected: ${nameError}`;
    const screenError = screenSkillCode(newSkill.code);
    if (screenError) return `rejected: ${screenError}`;

    const skill = this.skills.upsert(newSkill.name, newSkill.description, newSkill.code);
    this.host.log(`AI wrote a new skill: ${skill.name} — ${skill.description || "(no description)"}`);
    const result = await this.host.runSkill(skill, {});
    this.skills.recordRun(skill.name, result.ok);
    return result.ok ? `skill ran: ${result.detail}` : `skill failed: ${result.detail} (fix the code and resend with the same name, or try another approach)`;
  }
}
