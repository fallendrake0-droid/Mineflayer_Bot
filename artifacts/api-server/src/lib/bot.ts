import fs from "node:fs";
import path from "node:path";
import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import type { WebSocketServer } from "ws";
import { logger } from "./logger";
import {
  TaskToken,
  isTaskCancelled,
  sleep,
  errText,
  clamp,
  round1,
  compassFromYaw,
  timeOfDayLabel,
  prettifyName,
  chatComponentToText,
  describeConnectionError,
  sanitizeMovePacketParams,
} from "./bot-utils";
import { AiClient, type AiConfig } from "./ai-client";
import { AiBrain, type BrainHost, type BrainStepResult } from "./ai-brain";
import { SkillLibrary, runSkillInSandbox } from "./ai-skills";
import {
  RESOURCES,
  TREE_TYPES,
  ALL_LOG_NAMES,
  detectTreeType,
  isHostileMob,
  pickaxeTier,
  gearScore,
  findBestBySuffix,
  armorSlotFor,
  armorScore,
  ARMOR_WINDOW_SLOT,
  BAD_FOODS,
  classifyItem,
  BUTTON_AND_LEVER_BLOCKS,
  BED_BLOCKS,
  CONTAINER_BLOCKS,
  SCAFFOLD_BLOCKS,
  type TreeTypeConfig,
} from "./bot-data";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { pathfinder, Movements, goals } = pathfinderPkg as any;

// minecraft-data is a CommonJS package loaded at runtime (externalized in
// the esbuild bundle). prismarine-viewer is required lazily in startViewer()
// so a broken viewer install can never stop the bot/server from booting.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const minecraftData = require("minecraft-data") as (version: string) => any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mineflayerViewer: any = null;
function loadViewer() {
  if (!mineflayerViewer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mineflayerViewer = (require("prismarine-viewer") as any).mineflayer;
  }
  return mineflayerViewer;
}

export type LogLevel = "info" | "warn" | "error" | "success";
export type LogCategory = "system" | "chat" | "combat" | "task" | "connection" | "ai";
export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  category?: LogCategory;
}

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  /** A version like "1.20.1", or "auto" to let Mineflayer detect it. */
  version: string;
}

export interface BotSettings {
  autoEat: boolean;
  autoEatThreshold: number;
  autoEquipArmor: boolean;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  antiAfk: boolean;
  autoDefend: boolean;
  autoCollectDrops: boolean;
  chatCommandsEnabled: boolean;
  chatCommandOwners: string[];
  viewerEnabled: boolean;
  viewerFirstPerson: boolean;
  aiEnabled: boolean;
  aiChatEnabled: boolean;
}

const DEFAULT_SETTINGS: BotSettings = {
  autoEat: true,
  autoEatThreshold: 14,
  autoEquipArmor: true,
  autoReconnect: true,
  maxReconnectAttempts: 10,
  antiAfk: false,
  autoDefend: true,
  autoCollectDrops: true,
  chatCommandsEnabled: true,
  chatCommandOwners: [],
  viewerEnabled: true,
  viewerFirstPerson: true,
  aiEnabled: true,
  aiChatEnabled: false,
};

export const VIEWER_PORT = Number(process.env["VIEWER_PORT"] ?? 3007);
export const VIEWER_PATH = "/viewer/";

const SETTINGS_FILE =
  process.env["MINECONTROL_SETTINGS_FILE"] ??
  path.join(process.cwd(), "data", "minecontrol-settings.json");

const AI_CONFIG_FILE =
  process.env["MINECONTROL_AI_CONFIG_FILE"] ??
  path.join(path.dirname(SETTINGS_FILE), "ai-config.json");
const AI_SKILLS_FILE =
  process.env["MINECONTROL_AI_SKILLS_FILE"] ??
  path.join(path.dirname(SETTINGS_FILE), "ai-skills.json");
const AI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const AI_DEFAULT_MODEL = "gemini-2.5-flash";

interface StoredAiConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

// Indexed access avoids importing prismarine-* packages directly.
type McEntity = Bot["entities"][number];
type McItem = NonNullable<Bot["heldItem"]>;
type McBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

interface SessionStats {
  blocksMined: number;
  logsChopped: number;
  treesChopped: number;
  mobsKilled: number;
  itemsCollected: number;
  deaths: number;
  distanceWalked: number;
  sessionStartedAt: string | null;
}

interface ActiveTask {
  id: number;
  name: string;
  label: string;
  token: TaskToken;
}

const CONTROL_KEYS = ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const;
export type ControlKey = (typeof CONTROL_KEYS)[number];

export interface ControlState {
  forward?: boolean;
  back?: boolean;
  left?: boolean;
  right?: boolean;
  jump?: boolean;
  sprint?: boolean;
  sneak?: boolean;
  yawDelta?: number;
  pitchDelta?: number;
}

const CHAT_HELP_LINES = [
  "MineControl commands: !come, !follow <name>, !stop, !goto <x> [y] <z>",
  "!mine <resource> [count], !chop [type] [trees], !kill, !guard, !wander",
  "!eat, !sleep, !collect, !deposit, !drop [player], !climb [n], !build [size], !status, !inv",
  "AI brain: !ai <goal in plain English>, !auto [on|off]",
];

/**
 * BotManager owns the single Mineflayer bot instance, streams status/logs/
 * inventory to dashboard WebSocket clients, runs cancellable tasks and the
 * small "survival brain" behaviours (auto-eat, auto-armor, self-defense…).
 */
class BotManager {
  private bot: Bot | null = null;
  private wss: WebSocketServer | null = null;

  private logs: LogEntry[] = [];
  private readonly maxLogs = 1000;

  private settings: BotSettings = { ...DEFAULT_SETTINGS };

  private connectionState: ConnectionState = "disconnected";
  private connectOptions: ConnectOptions | null = null;
  private lastConnectOptions: ConnectOptions | null = null;
  private intentionalDisconnect = false;
  /** True once the current session has spawned at least once (gates auto-reconnect). */
  private everSpawned = false;
  private disconnectHandled = new WeakSet<object>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedAt: number | null = null;

  private activeTask: ActiveTask | null = null;
  private taskCounter = 0;
  private taskDetail = "";

  private stats: SessionStats = freshStats();
  private lastPosition: Vec3 | null = null;
  private lastGoodPosition: Vec3 | null = null;
  private lastGoodYaw = 0;
  private lastGoodPitch = 0;
  private lastNanRepairLogAt = 0;
  private lastMoveGuardLogAt = 0;
  // Temporary movement-packet forensics: after every spawn, log the exact
  // movement packets sent/received for a few seconds so a kick log shows
  // precisely what crossed the wire (used to hunt "Invalid move player
  // packet" kicks on Via-translated servers).
  private moveTraceUntil = 0;
  private moveTraceCount = 0;

  // --- AI brain state ---
  private aiStoredConfig: StoredAiConfig = {};
  private readonly aiClient = new AiClient(() => this.resolveAiConfig());
  private readonly skillLibrary = new SkillLibrary(AI_SKILLS_FILE);
  private aiBrain: AiBrain | null = null;
  private aiGoalActive = false;
  private aiAbortRequested = false;
  private aiAutopilot = false;
  private aiLoopRunning = false;
  private aiCurrentGoal: string | null = null;
  private aiLastOutcome: string | null = null;
  private readonly aiChatLastAt = new Map<string, number>();
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private lastActivityAt = Date.now();
  private lastControlAt = 0;
  private manualEngaged = false;
  private afkCycle = 0;

  private eating = false;
  private equippingArmor = false;
  private inventoryBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private armorCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDefendAt = 0;
  private lastHostileWarnAt = 0;
  private prevHealth = 20;

  private chatQueue: string[] = [];
  private chatTimer: ReturnType<typeof setInterval> | null = null;

  private viewerRunning = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mcDataCache: { version: string; data: any } | null = null;

  constructor() {
    this.loadSettings();
    this.loadAiConfig();
    this.aiBrain = new AiBrain(this.aiClient, this.skillLibrary, this.createBrainHost());
  }

  // -------------------------------------------------------------------------
  // WebSocket plumbing
  // -------------------------------------------------------------------------

  setWss(wss: WebSocketServer) {
    this.wss = wss;
  }

  private broadcast(payload: object) {
    if (!this.wss) return;
    const msg = JSON.stringify(payload);
    this.wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(msg);
    });
  }

  broadcastStatus() {
    this.broadcast({ type: "status", data: this.getStatus() });
  }

  broadcastInventory() {
    this.broadcast({ type: "inventory", data: this.getInventoryResponse() });
  }

  broadcastSettings() {
    this.broadcast({ type: "settings", data: this.getSettings() });
  }

  // -------------------------------------------------------------------------
  // Logs
  // -------------------------------------------------------------------------

  private addLog(level: LogLevel, message: string, category: LogCategory = "system") {
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, message, category };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
    this.broadcast({ type: "log", data: entry });
    logger.info({ level, category, message }, "Bot log");
  }

  getLogs(limit = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  clearLogs() {
    this.logs = [];
    this.broadcast({ type: "logs", data: [] });
    this.addLog("info", "Log cleared from dashboard");
  }

  // -------------------------------------------------------------------------
  // Settings (persisted to a small JSON file so they survive restarts)
  // -------------------------------------------------------------------------

  getSettings(): BotSettings {
    return { ...this.settings, chatCommandOwners: [...this.settings.chatCommandOwners] };
  }

  updateSettings(partial: Partial<BotSettings>): BotSettings {
    const prev = this.settings;
    const next: BotSettings = { ...prev, ...partial };
    next.autoEatThreshold = clamp(Math.round(next.autoEatThreshold), 0, 20);
    next.maxReconnectAttempts = clamp(Math.round(next.maxReconnectAttempts), 0, 1000);
    next.chatCommandOwners = [
      ...new Set(
        (next.chatCommandOwners ?? [])
          .map((o) => String(o).trim())
          .filter((o) => o.length > 0),
      ),
    ];
    this.settings = next;
    this.saveSettings();
    this.broadcastSettings();

    if (this.bot && this.connectionState === "connected") {
      const viewerChanged =
        prev.viewerEnabled !== next.viewerEnabled ||
        prev.viewerFirstPerson !== next.viewerFirstPerson;
      if (viewerChanged) {
        if (next.viewerEnabled) this.restartViewer();
        else this.stopViewer();
      }
    }
    return this.getSettings();
  }

  private loadSettings() {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<BotSettings>;
      this.settings = { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      // First run (or unreadable file) — defaults are fine.
    }
  }

  private saveSettings() {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      logger.warn({ err }, "Could not persist settings");
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // AI brain (LLM planner + sandboxed self-written skills)
  // -------------------------------------------------------------------------

  private loadAiConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(AI_CONFIG_FILE, "utf8")) as StoredAiConfig;
      this.aiStoredConfig = {
        apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
        baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
        model: typeof parsed.model === "string" ? parsed.model : undefined,
      };
    } catch {
      // No stored AI config yet — env vars / defaults apply.
    }
  }

  private saveAiConfig() {
    try {
      fs.mkdirSync(path.dirname(AI_CONFIG_FILE), { recursive: true });
      fs.writeFileSync(AI_CONFIG_FILE, JSON.stringify(this.aiStoredConfig, null, 2));
    } catch (err) {
      logger.warn({ err }, "Could not persist AI config");
    }
  }

  private resolveAiConfig(): AiConfig {
    return {
      apiKey:
        process.env["AI_API_KEY"] ??
        process.env["GEMINI_API_KEY"] ??
        process.env["OPENAI_API_KEY"] ??
        this.aiStoredConfig.apiKey ??
        null,
      baseUrl: process.env["AI_BASE_URL"] ?? this.aiStoredConfig.baseUrl ?? AI_DEFAULT_BASE_URL,
      model: process.env["AI_MODEL"] ?? this.aiStoredConfig.model ?? AI_DEFAULT_MODEL,
    };
  }

  /** Public AI configuration — never includes the actual API key. */
  getAiPublicConfig(): { hasKey: boolean; baseUrl: string; model: string } {
    const cfg = this.resolveAiConfig();
    return { hasKey: !!cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model };
  }

  setAiConfig(partial: { apiKey?: string; baseUrl?: string; model?: string }) {
    if (partial.apiKey !== undefined) {
      this.aiStoredConfig.apiKey = partial.apiKey.trim() ? partial.apiKey.trim() : undefined;
    }
    if (partial.baseUrl !== undefined) {
      this.aiStoredConfig.baseUrl = partial.baseUrl.trim() ? partial.baseUrl.trim() : undefined;
    }
    if (partial.model !== undefined) {
      this.aiStoredConfig.model = partial.model.trim() ? partial.model.trim() : undefined;
    }
    this.saveAiConfig();
    this.addLog("info", "AI configuration updated", "ai");
    return this.getAiPublicConfig();
  }

  getAiStatus() {
    const cfg = this.resolveAiConfig();
    return {
      configured: !!cfg.apiKey,
      enabled: this.settings.aiEnabled,
      chatEnabled: this.settings.aiChatEnabled,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      autopilot: this.aiAutopilot,
      goalActive: this.aiGoalActive,
      currentGoal: this.aiCurrentGoal ?? undefined,
      lastOutcome: this.aiLastOutcome ?? undefined,
      usage: { ...(this.aiBrain?.usage ?? { calls: 0, promptTokens: 0, completionTokens: 0 }) },
      skillCount: this.skillLibrary.list().length,
    };
  }

  listAiSkills() {
    return this.skillLibrary.list();
  }

  getAiSkill(name: string) {
    return this.skillLibrary.get(name) ?? null;
  }

  deleteAiSkill(name: string): boolean {
    const ok = this.skillLibrary.remove(name);
    if (ok) this.addLog("info", `Deleted AI skill: ${name}`, "ai");
    return ok;
  }

  private requireAiReady() {
    if (!this.settings.aiEnabled) throw new Error("AI brain is disabled in Settings");
    if (!this.aiClient.configured) {
      throw new Error("AI is not configured — add an API key in the AI panel first");
    }
  }

  /** Work on a natural-language goal. Resolves when the goal ends. */
  async aiGoal(goalInput: string): Promise<void> {
    this.requireConnected();
    this.requireAiReady();
    const goal = goalInput.trim().slice(0, 500);
    if (!goal) throw new Error("Goal is empty");
    if (this.aiGoalActive) {
      throw new Error(`AI is already working on: ${this.aiCurrentGoal ?? "a goal"}`);
    }
    await this.runAiGoalInternal(goal, "user");
  }

  setAutopilot(on: boolean) {
    if (on) {
      this.requireConnected();
      this.requireAiReady();
    }
    this.aiAutopilot = on;
    if (on) {
      this.addLog("info", "AI autopilot ON — the bot will choose its own goals", "ai");
      void this.autopilotLoop();
    } else {
      this.aiAbortRequested = true;
      this.addLog("info", "AI autopilot OFF", "ai");
    }
    this.broadcastStatus();
  }

  /** Stop any AI goal/autopilot and the current task. Safe to call anytime. */
  aiStop() {
    this.aiAbortRequested = true;
    this.aiAutopilot = false;
    if (this.bot && this.connectionState === "connected") {
      this.cancelActiveTask("ai stop");
      this.stopMotion();
    }
    this.addLog("info", "AI stopped", "ai");
    this.broadcastStatus();
  }

  private async autopilotLoop(): Promise<void> {
    if (this.aiLoopRunning) return;
    this.aiLoopRunning = true;
    try {
      while (this.aiAutopilot) {
        if (!this.bot || this.connectionState !== "connected" || this.aiGoalActive) {
          await sleep(3000);
          continue;
        }
        if (!this.settings.aiEnabled || !this.aiClient.configured) {
          this.addLog("warn", "Autopilot paused — AI disabled or not configured", "ai");
          this.aiAutopilot = false;
          break;
        }
        await this.runAiGoalInternal(null, "autopilot");
        // Brief breather between self-chosen goals (also bounds API spend).
        for (let i = 0; i < 16 && this.aiAutopilot; i++) await sleep(250);
      }
    } finally {
      this.aiLoopRunning = false;
      this.broadcastStatus();
    }
  }

  private async runAiGoalInternal(goal: string | null, source: string): Promise<void> {
    if (!this.aiBrain || this.aiGoalActive) return;
    this.aiGoalActive = true;
    this.aiAbortRequested = false;
    this.aiCurrentGoal = goal ?? "(autopilot)";
    this.broadcastStatus();
    this.addLog("info", goal ? `AI goal (${source}): ${goal}` : "AI autopilot: choosing a goal…", "ai");
    try {
      const { outcome } = await this.aiBrain.runGoal(goal, { maxRounds: 10 });
      this.aiLastOutcome = outcome;
      if (outcome === "aborted") this.addLog("info", "AI goal aborted", "ai");
      else this.addLog("success", `AI finished: ${outcome}`, "ai");
    } catch (err) {
      this.aiLastOutcome = `error: ${errText(err)}`;
      this.addLog("error", `AI goal failed: ${errText(err)}`, "ai");
    } finally {
      this.aiGoalActive = false;
      this.aiCurrentGoal = null;
      this.broadcastStatus();
    }
  }

  /** Route an owner's plain chat message to the AI (opt-in setting). */
  private maybeAiChat(sender: string, message: string) {
    if (!this.settings.aiEnabled || !this.settings.aiChatEnabled) return;
    if (!this.aiClient.configured || this.aiGoalActive || this.aiAutopilot) return;
    if (!this.bot || this.connectionState !== "connected") return;
    const now = Date.now();
    const key = sender.toLowerCase();
    if (now - (this.aiChatLastAt.get(key) ?? 0) < 5000) return;
    this.aiChatLastAt.set(key, now);
    const text = message.slice(0, 300);
    void this.runAiGoalInternal(
      `Player ${sender} said to you in chat: "${text}". Respond to them in chat (say), and if they asked you to do something, do it.`,
      "chat",
    );
  }

  private createBrainHost(): BrainHost {
    return {
      isConnected: () => !!this.bot && this.connectionState === "connected",
      shouldAbort: () => this.aiAbortRequested,
      getContext: () => this.buildAiContext(),
      executeAction: (action, args) => this.executeAiAction(action, args),
      runSkill: (skill, args) => this.executeAiSkill(skill, args),
      say: (message) => this.say(message),
      log: (message, level) => this.addLog(level ?? "info", message, "ai"),
      recentLogLines: (count) => this.logs.slice(-count).map((e) => `${e.level}: ${e.message}`),
    };
  }

  private currentTimeOfDayLabel(): string {
    const t = (this.bot as unknown as { time?: { timeOfDay?: number } } | null)?.time?.timeOfDay;
    return timeOfDayLabel(typeof t === "number" ? t : 6000);
  }

  private buildAiContext(): Record<string, unknown> {
    const bot = this.bot;
    if (!bot || !bot.entity) return { connected: false };
    const pos = bot.entity.position;

    const merged = new Map<string, number>();
    for (const item of bot.inventory.items()) {
      merged.set(item.name, (merged.get(item.name) ?? 0) + item.count);
    }
    const inventory = [...merged.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([name, count]) => ({ name, count }));
    const armor = [5, 6, 7, 8]
      .map((slot) => bot.inventory.slots[slot]?.name)
      .filter((n): n is string => !!n);

    const players = Object.values(bot.players)
      .filter((p) => p.username !== bot.username && p.entity)
      .map((p) => ({
        name: p.username,
        distance: Math.round(pos.distanceTo(p.entity!.position)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 8);

    const hostiles: Array<{ name: string; distance: number }> = [];
    let passiveCount = 0;
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || !e.position) continue;
      const d = pos.distanceTo(e.position);
      if (d > 32) continue;
      if (isHostileMob(e.name)) hostiles.push({ name: e.name ?? "mob", distance: Math.round(d) });
      else if (e.type === "mob") passiveCount++;
    }
    hostiles.sort((a, b) => a.distance - b.distance);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const game = bot.game as any;
    const xp = (bot as unknown as { experience?: { level?: number } }).experience;

    return {
      username: bot.username,
      version: bot.version,
      dimension: normalizeDimension(game?.dimension),
      position: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
      health: Math.ceil(bot.health),
      food: Math.floor(bot.food),
      xpLevel: xp?.level ?? 0,
      timeOfDay: this.currentTimeOfDayLabel(),
      heldItem: bot.heldItem?.name ?? null,
      armor,
      inventory,
      playersNearby: players,
      hostilesNearby: hostiles.slice(0, 8),
      passiveMobsNearby: passiveCount,
      currentTask: this.activeTask?.label ?? null,
      stats: {
        blocksMined: this.stats.blocksMined,
        logsChopped: this.stats.logsChopped,
        treesChopped: this.stats.treesChopped,
        mobsKilled: this.stats.mobsKilled,
        itemsCollected: this.stats.itemsCollected,
        deaths: this.stats.deaths,
        distanceWalked: Math.round(this.stats.distanceWalked),
      },
    };
  }

  private async executeAiAction(
    action: string,
    args: Record<string, unknown>,
  ): Promise<BrainStepResult> {
    const num = (v: unknown, fallback = 0): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

    const invoke = async (): Promise<void> => {
      switch (action) {
        case "say":
          this.say(str(args.message).slice(0, 240));
          return;
        case "goto": {
          if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.z))) {
            throw new Error("goto needs numeric x and z");
          }
          await this.gotoCoords(num(args.x), args.y === undefined ? undefined : num(args.y), num(args.z));
          return;
        }
        case "come": {
          const name = str(args.player);
          const p = this.bot?.players[name]?.entity?.position;
          if (!p) throw new Error(`player "${name}" not found nearby`);
          await this.gotoCoords(p.x, p.y, p.z);
          return;
        }
        case "follow":
          await this.follow(str(args.player));
          return;
        case "mine":
          await this.mine(str(args.resource), clamp(Math.round(num(args.count, 16)), 1, 256));
          return;
        case "chop":
          await this.chopTree(str(args.treeType) || "any", clamp(Math.round(num(args.count, 1)), 1, 64));
          return;
        case "killMobs":
          await this.killMobs();
          return;
        case "attack":
          await this.attackOnce(str(args.target), false);
          return;
        case "guard":
          await this.guard();
          return;
        case "wander":
          await this.wander();
          return;
        case "eat":
          await this.eatNow();
          return;
        case "sleep":
          await this.sleepInBed();
          return;
        case "build":
          await this.buildBase(clamp(Math.round(num(args.size, 5)), 3, 9));
          return;
        case "climb":
          await this.climb(clamp(Math.round(num(args.blocks, 3)), 1, 32));
          return;
        case "collect":
          await this.collectItems();
          return;
        case "deposit":
          await this.depositItems();
          return;
        case "giveTo":
          await this.dropItems(str(args.player) || undefined);
          return;
        case "dropItem": {
          const item = this.bot?.inventory.items().find((i) => i.name === str(args.item));
          if (!item) throw new Error(`item "${str(args.item)}" not in inventory`);
          await this.tossFromSlot(
            item.slot,
            args.count === undefined ? undefined : clamp(Math.round(num(args.count)), 1, 64),
          );
          return;
        }
        case "equip": {
          const item = this.bot?.inventory.items().find((i) => i.name === str(args.item));
          if (!item) throw new Error(`item "${str(args.item)}" not in inventory`);
          await this.equipFromSlot(item.slot);
          return;
        }
        case "pullLever":
          await this.pullLever();
          return;
        case "wait": {
          const until = Date.now() + clamp(num(args.seconds, 3), 0, 60) * 1000;
          while (Date.now() < until && !this.aiAbortRequested) await sleep(250);
          return;
        }
        default:
          throw new Error(`unknown action "${action}"`);
      }
    };

    const STEP_TIMEOUTS: Record<string, number> = {
      follow: 120_000,
      guard: 120_000,
      wander: 90_000,
      mine: 300_000,
      chop: 300_000,
      build: 420_000,
      killMobs: 240_000,
    };
    const timeoutMs = STEP_TIMEOUTS[action] ?? 150_000;
    const sinceMs = Date.now();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const invokeP = invoke().then(
      () => "done" as const,
      (err: unknown) => ({ err: errText(err) }),
    );
    const outcome = await Promise.race([
      invokeP,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          this.cancelActiveTask("ai step timeout");
          resolve("timeout");
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const error = typeof outcome === "object" ? outcome.err : null;

    const newLogs = this.logs
      .filter((e) => new Date(e.timestamp).getTime() >= sinceMs)
      .map((e) => e.message);
    const interrupted =
      timedOut || newLogs.some((m) => m.startsWith("Stopped:")) || this.aiAbortRequested;
    const tail = newLogs
      .filter((m) => !m.startsWith("Stopped:"))
      .slice(-3)
      .join(" | ");
    const detail = error
      ? `error: ${error}`
      : timedOut
        ? `interrupted: step timed out after ${Math.round(timeoutMs / 1000)}s${tail ? ` — ${tail}` : ""}`
        : interrupted
          ? `interrupted${tail ? ` — ${tail}` : ""}`
          : `completed${tail ? ` — ${tail}` : ""}`;
    return { action, ok: !error && !interrupted, detail: detail.slice(0, 300) };
  }

  private async executeAiSkill(
    skill: { name: string; code: string },
    args: Record<string, unknown>,
  ): Promise<BrainStepResult> {
    let ok = false;
    let detail = "completed";
    const timeoutMs = 180_000;
    await this.runTask(`ai-skill:${skill.name}`, `AI skill: ${skill.name}`, async (token) => {
      const api = this.createSkillApi(token, args);
      const outcome = await runSkillInSandbox(skill.code, api, {
        timeoutMs,
        onTimeout: () => token.cancel(),
        onLog: (m) => this.addLog("info", `[${skill.name}] ${m}`.slice(0, 300), "ai"),
      });
      ok = outcome.ok && !token.cancelled;
      detail = outcome.ok
        ? `skill returned: ${outcome.result ?? "done"}`
        : token.cancelled
          ? `interrupted: ${outcome.error ?? "stopped"}`
          : `error: ${outcome.error ?? "unknown error"}`;
    });
    return { action: `skill:${skill.name}`, ok, detail: detail.slice(0, 400) };
  }

  /** Frozen helper API handed to sandboxed AI skills. */
  private createSkillApi(token: TaskToken, args: Record<string, unknown>): Record<string, unknown> {
    const bot = this.bot!;
    const floor3 = (v: Vec3) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
    const num = (v: unknown, fallback = 0): number => {
      const n = Number(v);
      return Number.isFinite(n) ? n : fallback;
    };
    const EQUIP_DESTS = ["hand", "off-hand", "head", "torso", "legs", "feet"] as const;
    type EquipDest = (typeof EQUIP_DESTS)[number];

    return {
      args,
      say: (m: unknown) => this.say(String(m).slice(0, 240)),
      log: (m: unknown) => this.addLog("info", String(m).slice(0, 300), "ai"),
      sleep: (ms: unknown) => token.sleep(clamp(num(ms), 0, 30_000)),
      checkpoint: () => token.throwIfCancelled(),
      pos: () => floor3(bot.entity.position),
      health: () => bot.health,
      food: () => bot.food,
      heldItem: () => bot.heldItem?.name ?? null,
      inventory: () =>
        bot.inventory.items().map((i) => ({ name: i.name, count: i.count, slot: i.slot })),
      blockAt: (x: unknown, y: unknown, z: unknown) =>
        bot.blockAt(new Vec3(num(x), num(y), num(z)))?.name ?? null,
      findBlocks: (names: unknown, maxDist: unknown = 32, count: unknown = 8) => {
        token.throwIfCancelled();
        const mcData = this.getMcData();
        if (!mcData) return [];
        const list = Array.isArray(names) ? names : [names];
        const ids = list
          .map((n) => (mcData.blocksByName[String(n)]?.id as number | undefined))
          .filter((id): id is number => typeof id === "number");
        if (ids.length === 0) return [];
        return bot
          .findBlocks({
            matching: ids,
            maxDistance: clamp(num(maxDist, 32), 1, 64),
            count: clamp(Math.round(num(count, 8)), 1, 32),
          })
          .map(floor3);
      },
      entities: (maxDist: unknown = 32) => {
        const limit = clamp(num(maxDist, 32), 1, 64);
        return Object.values(bot.entities)
          .filter((e) => e && e !== bot.entity && e.position)
          .map((e) => ({
            name: e.name ?? e.username ?? "entity",
            type: e.type,
            distance: Math.round(bot.entity.position.distanceTo(e.position) * 10) / 10,
            ...floor3(e.position),
          }))
          .filter((e) => e.distance <= limit)
          .sort((a, b) => a.distance - b.distance)
          .slice(0, 20);
      },
      playerPos: (name: unknown) => {
        const p = bot.players[String(name)]?.entity?.position;
        return p ? floor3(p) : null;
      },
      goto: async (x: unknown, y: unknown, z: unknown, range: unknown = 1) => {
        this.setupMovements({ dig: false });
        return this.gotoNear(token, new Vec3(num(x), num(y), num(z)), clamp(num(range, 1), 0, 8));
      },
      dig: async (x: unknown, y: unknown, z: unknown) => {
        const target = new Vec3(Math.floor(num(x)), Math.floor(num(y)), Math.floor(num(z)));
        const block = bot.blockAt(target);
        if (!block || block.type === 0) return false;
        if (bot.entity.position.distanceTo(target) > 4.2) {
          this.setupMovements({ dig: false });
          await this.gotoNear(token, target, 2);
        }
        token.throwIfCancelled();
        const fresh = bot.blockAt(target);
        if (!fresh || fresh.type === 0) return false;
        return this.digBlock(token, fresh);
      },
      collect: async (radius: unknown = 12) =>
        this.collectNearbyItems(token, clamp(num(radius, 12), 1, 32), 24),
      place: async (itemName: unknown, x: unknown, y: unknown, z: unknown) =>
        this.placeBuildingBlock(
          token,
          new Vec3(Math.floor(num(x)), Math.floor(num(y)), Math.floor(num(z))),
          String(itemName),
        ),
      equip: async (itemName: unknown, dest: unknown = "hand") => {
        const item = bot.inventory.items().find((i) => i.name === String(itemName));
        if (!item) return false;
        const d = (EQUIP_DESTS as readonly string[]).includes(String(dest))
          ? (String(dest) as EquipDest)
          : "hand";
        return this.equipItem(item, d);
      },
      toss: async (itemName: unknown, count?: unknown) => {
        const item = bot.inventory.items().find((i) => i.name === String(itemName));
        if (!item) return false;
        await token.wrap(
          bot.toss(item.type, null, count === undefined ? item.count : clamp(Math.round(num(count)), 1, 64)),
        );
        return true;
      },
      eat: async () => {
        await this.eatBestFood("manual");
      },
      attackNearest: async (maxDist: unknown = 16) => {
        const limit = clamp(num(maxDist, 16), 1, 32);
        const target = Object.values(bot.entities)
          .filter(
            (e) =>
              e &&
              e.position &&
              isHostileMob(e.name) &&
              bot.entity.position.distanceTo(e.position) <= limit,
          )
          .sort(
            (a, b) =>
              bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position),
          )[0];
        if (!target) return false;
        return this.combatEntity(token, target);
      },
      lookAt: async (x: unknown, y: unknown, z: unknown) => {
        await token.wrap(bot.lookAt(new Vec3(num(x), num(y), num(z)), true));
      },
      timeOfDay: () => this.currentTimeOfDayLabel(),
    };
  }

  async connect(opts: ConnectOptions): Promise<void> {
    if (this.bot || this.connectionState === "connecting" || this.connectionState === "reconnecting") {
      throw new Error("Bot is already connected (or connecting). Disconnect first.");
    }
    this.intentionalDisconnect = false;
    this.everSpawned = false;
    this.reconnectAttempts = 0;
    this.stats = freshStats();
    this.stats.sessionStartedAt = new Date().toISOString();
    this.lastConnectOptions = opts;
    await this.connectInternal(opts);
  }

  private async connectInternal(opts: ConnectOptions): Promise<void> {
    this.connectionState = this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    this.connectOptions = opts;
    this.broadcastStatus();
    this.addLog("info", `Connecting to ${opts.host}:${opts.port} as ${opts.username} (MC ${opts.version})…`, "connection");

    let bot: Bot;
    try {
      bot = mineflayer.createBot({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        // `false` tells minecraft-protocol to auto-detect via server ping
        // (mineflayer's types only model `string | undefined`).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        version: (opts.version === "auto" || opts.version === "" ? false : opts.version) as any,
        hideErrors: false,
      });
    } catch (err) {
      if (this.connectionState === "connecting") this.connectionState = "disconnected";
      this.broadcastStatus();
      throw err;
    }
    this.bot = bot;
    try {
      this.installMovePacketGuard(bot);
      bot.loadPlugin(pathfinder);
      this.wireBotEvents(bot);
    } catch (err) {
      // Never leak a half-wired bot instance.
      try { bot.end(); } catch { /* ignore */ }
      if (this.bot === bot) this.bot = null;
      this.connectionState = "disconnected";
      this.broadcastStatus();
      throw err;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { bot.end(); } catch { /* ignore */ }
        reject(new Error("Connection timed out after 30 seconds"));
      }, 30_000);

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { bot.end(); } catch { /* ignore */ }
        this.handleDisconnect(bot, `Connection failed: ${err.message}`);
        reject(new Error(describeConnectionError(err.message)));
      };

      bot.once("spawn", () => {
        if (this.bot !== bot) return fail(new Error("Connection superseded"));
        this.connectionState = "connected";
        this.everSpawned = true;
        this.connectedAt = Date.now();
        // reconnectAttempts is intentionally NOT reset here: a server that
        // kicks the bot seconds after every spawn must still exhaust its
        // budget and give up. handleDisconnect resets it after a stable
        // (>= 60s) session. Manual connect() also resets it.
        this.touchActivity();
        this.prevHealth = bot.health;
        this.lastGoodPosition = null;
        this.moveTraceUntil = Date.now() + 8000;
        this.moveTraceCount = 0;
        this.sanitizeEntityState(bot);
        this.lastPosition = bot.entity?.position?.clone() ?? null;
        this.mcDataCache = null;
        this.addLog("success", `Spawned as ${bot.username} on ${opts.host}:${opts.port} (MC ${bot.version})`, "connection");
        if (this.settings.chatCommandsEnabled) {
          const owners = this.settings.chatCommandOwners;
          this.addLog(
            "info",
            owners.length > 0
              ? `Chat commands (!help) enabled for: ${owners.join(", ")}`
              : "Chat commands (!help) enabled for everyone — set an owner in Settings to restrict them",
            "chat",
          );
        }
        this.wireInventoryEvents(bot);
        this.startStatusLoop(bot);
        this.startChatLoop(bot);
        this.startViewer(bot);
        this.broadcastStatus();
        this.broadcastInventory();
        void sleep(800).then(() => {
          if (this.bot === bot) void this.maybeEquipArmor();
        });
        succeed();
      });

      bot.once("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
      bot.once("end", (reason) => fail(new Error(`Disconnected before spawn: ${String(reason)}`)));
    });
  }

  disconnect() {
    if (!this.bot && this.connectionState === "disconnected") {
      throw new Error("Bot is not connected");
    }
    this.intentionalDisconnect = true;
    this.aiAbortRequested = true;
    this.aiAutopilot = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const bot = this.bot;
    this.cancelActiveTask("disconnect");
    if (bot) {
      try { bot.end(); } catch { /* ignore */ }
      this.handleDisconnect(bot, "Disconnected by user");
    } else {
      this.connectionState = "disconnected";
      this.broadcastStatus();
    }
  }

  /** Called on process shutdown. */
  shutdown() {
    try {
      this.intentionalDisconnect = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.cancelActiveTask("shutdown");
      this.stopViewer();
      if (this.bot) {
        try { this.bot.end(); } catch { /* ignore */ }
      }
    } catch {
      // best effort
    }
  }

  private handleDisconnect(bot: Bot, reason: string) {
    if (this.disconnectHandled.has(bot)) return; // 'end' event + failure path can race
    this.disconnectHandled.add(bot);
    if (this.bot !== bot) return; // stale bot instance (already replaced)

    this.cancelActiveTask("disconnect");
    this.aiAbortRequested = true;
    this.stopViewer();
    this.stopStatusLoop();
    this.stopChatLoop();
    this.bot = null;
    // Only a session that stayed up a while earns a fresh reconnect budget.
    if (this.connectedAt !== null && Date.now() - this.connectedAt >= 60_000) {
      this.reconnectAttempts = 0;
    }
    // Pre-spawn failures get a plain-English hint appended (offline server,
    // wrong port, blocked network…) — raw socket errors are useless to
    // most users staring at the dashboard log.
    const shownReason = this.connectedAt === null ? describeConnectionError(reason) : reason;
    this.connectedAt = null;
    this.lastPosition = null;
    this.manualEngaged = false;
    this.taskDetail = "";
    this.addLog("warn", shownReason, "connection");

    if (!this.scheduleReconnect()) {
      this.connectionState = "disconnected";
    }
    this.broadcastStatus();
    this.broadcastInventory();
  }

  /**
   * Schedule an auto-reconnect (exponential backoff: 3s, 6s, 12s, 24s, then 30s).
   * Only after a session has successfully spawned once — a first connect with
   * a wrong address just fails cleanly instead of retrying forever.
   * Returns true when a reconnect is pending.
   */
  private scheduleReconnect(): boolean {
    if (
      this.intentionalDisconnect ||
      !this.settings.autoReconnect ||
      !this.lastConnectOptions ||
      !this.everSpawned
    ) {
      return false;
    }
    if (this.reconnectTimer) return true; // already scheduled
    if (
      this.settings.maxReconnectAttempts > 0 &&
      this.reconnectAttempts >= this.settings.maxReconnectAttempts
    ) {
      this.addLog("error", "Auto-reconnect gave up (max attempts reached)", "connection");
      return false;
    }

    this.reconnectAttempts++;
    const delaySec = Math.min(30, 3 * 2 ** Math.min(this.reconnectAttempts - 1, 4));
    this.connectionState = "reconnecting";
    this.addLog("info", `Auto-reconnect attempt ${this.reconnectAttempts} in ${delaySec}s...`, "connection");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.lastConnectOptions || this.intentionalDisconnect) return;
      this.connectInternal(this.lastConnectOptions).catch((err) => {
        // The failed bot's 'end' handler usually reschedules via
        // handleDisconnect; this is a safety net for failures without 'end'.
        if (!this.bot && this.connectionState === "reconnecting" && !this.reconnectTimer) {
          this.addLog("error", `Reconnect attempt failed: ${errText(err)}`, "connection");
          if (!this.scheduleReconnect()) this.connectionState = "disconnected";
          this.broadcastStatus();
        }
      });
    }, delaySec * 1000);
    return true;
  }

  // -------------------------------------------------------------------------
  // Bot event wiring (the always-on "survival brain")
  // -------------------------------------------------------------------------

  private wireBotEvents(bot: Bot) {
    bot.on("chat", (username, message) => {
      if (username === bot.username) return; // our own messages are logged when sent
      this.addLog("info", `<${username}> ${message}`, "chat");
      this.handleChatCommand(username, message);
    });

    // Server / system messages (join broadcasts, /say output, death messages…).
    // Modern servers also deliver unsigned player chat as "system" messages,
    // which the 'chat' handler above already logs — skip those to avoid dupes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bot as any).on("messagestr", (message: string, position: string) => {
      const text = message.trim();
      if (position !== "system" || text.length === 0) return;
      if (/^<[^>]+>/.test(text)) return;
      this.addLog("info", text, "chat");
    });

    bot.on("health", () => {
      const hurt = bot.health < this.prevHealth;
      this.prevHealth = bot.health;
      this.broadcastStatus();
      void this.maybeAutoEat();
      if (hurt && this.settings.autoDefend && !this.activeTask) {
        void this.maybeAutoDefend();
      }
    });

    // Join/leave broadcasts arrive as system chat messages on most servers
    // (logged via messagestr above), so these handlers only refresh status.
    bot.on("playerJoined", () => this.broadcastStatus());
    bot.on("playerLeft", () => this.broadcastStatus());

    bot.on("playerCollect", (collector) => {
      if (collector === bot.entity) this.stats.itemsCollected++;
    });

    bot.on("death", () => {
      const pos = bot.entity?.position;
      const where = pos ? ` at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}` : "";
      this.stats.deaths++;
      this.addLog("error", `Bot died${where}! (death #${this.stats.deaths}) Respawning…`, "combat");
      this.cancelActiveTask("death");
      this.broadcastStatus();
    });

    bot.on("respawn", () => {
      this.addLog("info", "Respawned", "connection");
      this.sanitizeEntityState(bot);
      this.broadcastStatus();
    });

    // Repair NaN-poisoned entity state before physics can forward it to the
    // server (vanilla/Paper kicks with "Invalid move player packet received").
    bot.on("move", () => this.sanitizeEntityState(bot));
    bot.on("physicsTick", () => this.sanitizeEntityState(bot));
    bot.on("forcedMove", () => this.sanitizeEntityState(bot));

    // Movement-packet forensics (see moveTrace fields): log the raw
    // server teleports/rotations so a kick can be correlated with the exact
    // packet mineflayer was answering.
    const traceClient = bot._client as unknown as {
      on: (event: string, listener: (packet: Record<string, unknown>) => void) => void;
    } | null;
    if (traceClient && typeof traceClient.on === "function") {
      const traceRecv = (label: string) => (packet: Record<string, unknown>) => {
        if (Date.now() < this.moveTraceUntil && this.moveTraceCount < 60) {
          this.moveTraceCount++;
          try {
            this.addLog("info", `TRACE RECV ${label} ${JSON.stringify(packet)}`, "connection");
          } catch { /* never break packet handling */ }
        }
      };
      traceClient.on("position", traceRecv("position"));
      traceClient.on("player_rotation", traceRecv("player_rotation"));
    }

    bot.on("kicked", (reason) => {
      this.addLog("error", `Kicked from server: ${chatComponentToText(reason)}`, "connection");
      const e = bot.entity;
      if (e) {
        this.addLog(
          "info",
          `TRACE state at kick: pos=${e.position} vel=${e.velocity} yaw=${e.yaw} pitch=${e.pitch} onGround=${e.onGround}`,
          "connection",
        );
      }
    });

    bot.on("error", (err) => {
      const message = errText(err);
      // Pre-spawn, the connect boot path already reports the failure (with a
      // plain-English hint); the same socket error also arrives here — twice
      // (version-ping socket + login socket). Don't double-log it. Stale bot
      // instances (already replaced/disconnected) are ignored too.
      if (
        this.bot !== bot ||
        this.connectionState === "connecting" ||
        this.connectionState === "reconnecting"
      ) {
        logger.debug({ err }, "Bot error during connect (reported via connect failure)");
        return;
      }
      // Socket teardown races (writing after a kick/disconnect) add noise,
      // not signal — the disconnect itself is already logged.
      if (/EPIPE|ECONNRESET|ERR_SOCKET|socketClosed/i.test(message)) {
        logger.debug({ err }, "Ignoring bot socket teardown error");
        return;
      }
      this.addLog("error", `Bot error: ${message}`, "connection");
    });

    bot.on("end", (reason) => {
      this.handleDisconnect(bot, `Disconnected: ${chatComponentToText(reason)}`);
    });
  }

  /**
   * Detect and repair non-finite entity state (position / velocity / look).
   * Some servers and plugins — respawns, lobby teleports, version
   * translation layers (ViaVersion / ViaBackwards) — can momentarily hand
   * Mineflayer a NaN position or rotation. Physics would forward that to
   * the server in the next movement packet, and vanilla/Paper kicks with
   * "Invalid move player packet received" (observed live on an Aternos
   * server, 2026-10-19). Restoring the last known-good values in the
   * 'move'/'physicsTick' handlers keeps the connection alive.
   */
  /**
   * Last line of defence against "Invalid move player packet received"
   * kicks: wrap the protocol client's write path and repair any non-finite
   * movement field with the last known-good value before serialization.
   * Mineflayer's forced-move response after a server-initiated respawn
   * (e.g. SkinsRestorer applying a skin on join) can compute NaN yaw/pitch
   * and send it synchronously from its packet handler — before our
   * physicsTick sanitizer ever gets a chance to run. Installed immediately
   * after createBot so it covers every write from the first packet on.
   */
  private installMovePacketGuard(bot: Bot) {
    const client = bot._client as unknown as {
      write: (name: string, params: Record<string, unknown>) => void;
    } | null;
    if (!client || typeof client.write !== "function") return;
    const originalWrite = client.write.bind(client);
    client.write = (name: string, params: Record<string, unknown>) => {
      if (
        (name === "position" || name === "position_look" || name === "look" || name === "flying" || name === "teleport_confirm") &&
        Date.now() < this.moveTraceUntil &&
        this.moveTraceCount < 60
      ) {
        this.moveTraceCount++;
        try {
          this.addLog("info", `TRACE SEND ${name} ${JSON.stringify(params)}`, "connection");
        } catch { /* tracing must never break the write path */ }
      }
      const fallbackPos = this.lastGoodPosition;
      const repaired = sanitizeMovePacketParams(name, params, {
        x: fallbackPos?.x ?? 0,
        y: fallbackPos?.y ?? 64,
        z: fallbackPos?.z ?? 0,
        yaw: this.lastGoodYaw,
        pitch: this.lastGoodPitch,
      });
      if (repaired) {
        this.sanitizeEntityState(bot);
        if (Date.now() - this.lastMoveGuardLogAt > 10_000) {
          this.lastMoveGuardLogAt = Date.now();
          this.addLog(
            "warn",
            "Guarded an invalid movement packet (NaN position/rotation repaired before sending)",
            "connection",
          );
        }
      }
      return originalWrite(name, params);
    };
    this.moveTraceUntil = Date.now() + 15000;
    this.moveTraceCount = 0;
    this.addLog("info", "Movement-packet guard installed", "connection");
  }

  private sanitizeEntityState(bot: Bot) {
    const entity = bot.entity;
    if (!entity) return;
    let repaired = false;

    const pos = entity.position;
    if (pos) {
      if (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z)) {
        if (!this.lastGoodPosition) {
          this.lastGoodPosition = pos.clone();
        } else {
          this.lastGoodPosition.x = pos.x;
          this.lastGoodPosition.y = pos.y;
          this.lastGoodPosition.z = pos.z;
        }
      } else if (this.lastGoodPosition) {
        pos.x = this.lastGoodPosition.x;
        pos.y = this.lastGoodPosition.y;
        pos.z = this.lastGoodPosition.z;
        repaired = true;
      }
    }

    const vel = entity.velocity;
    if (vel && (!Number.isFinite(vel.x) || !Number.isFinite(vel.y) || !Number.isFinite(vel.z))) {
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;
      repaired = true;
    }

    if (Number.isFinite(entity.yaw)) {
      this.lastGoodYaw = entity.yaw;
    } else {
      entity.yaw = this.lastGoodYaw;
      repaired = true;
    }
    if (Number.isFinite(entity.pitch)) {
      this.lastGoodPitch = entity.pitch;
    } else {
      entity.pitch = this.lastGoodPitch;
      repaired = true;
    }

    if (repaired && Date.now() - this.lastNanRepairLogAt > 10_000) {
      this.lastNanRepairLogAt = Date.now();
      this.addLog("warn", "Repaired invalid (NaN) position/rotation sent by the server — preventing a kick", "connection");
    }
  }

  /** bot.look that refuses to send non-finite rotation (an instant kick). */
  private lookSafe(bot: Bot, yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    void bot.look(yaw, clamp(pitch, -1.55, 1.55), false).catch(() => {
      // Bot ended mid-look — nothing to do.
    });
  }

  /**
   * Inventory listeners are wired on spawn — Mineflayer injects its plugins
   * asynchronously, so `bot.inventory` is undefined right after createBot().
   */
  private wireInventoryEvents(bot: Bot) {
    // Live inventory sync + auto-armor (debounced — updateSlot fires a lot).
    bot.inventory.on("updateSlot", () => {
      if (this.inventoryBroadcastTimer) clearTimeout(this.inventoryBroadcastTimer);
      this.inventoryBroadcastTimer = setTimeout(() => this.broadcastInventory(), 200);
      if (this.settings.autoEquipArmor) {
        if (this.armorCheckTimer) clearTimeout(this.armorCheckTimer);
        this.armorCheckTimer = setTimeout(() => void this.maybeEquipArmor(), 700);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Status / inventory snapshots
  // -------------------------------------------------------------------------

  getStatus() {
    const base = {
      connected: false as boolean,
      connectionState: this.connectionState,
      username: this.connectOptions?.username,
      host: this.connectOptions?.host,
      port: this.connectOptions?.port,
      version: this.bot?.version ?? this.connectOptions?.version,
      currentTask: this.activeTask?.label ?? "idle",
      taskDetail: this.taskDetail,
      reconnectAttempts: this.reconnectAttempts,
      viewerEnabled: this.viewerRunning,
      viewerPath: VIEWER_PATH,
      viewerPort: VIEWER_PORT,
      stats: {
        blocksMined: this.stats.blocksMined,
        logsChopped: this.stats.logsChopped,
        treesChopped: this.stats.treesChopped,
        mobsKilled: this.stats.mobsKilled,
        itemsCollected: this.stats.itemsCollected,
        deaths: this.stats.deaths,
        distanceWalked: Math.round(this.stats.distanceWalked),
        sessionStartedAt: this.stats.sessionStartedAt ?? undefined,
      },
    };

    const bot = this.bot;
    if (!bot || this.connectionState !== "connected" || !bot.entity) return base;

    const pos = bot.entity.position;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const game = bot.game as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const experience = bot.experience as any;

    const players = Object.values(bot.players)
      .filter((p) => p.username !== bot.username)
      .map((p) => ({
        username: p.username,
        ping: p.ping,
        distance: p.entity ? round1(p.entity.position.distanceTo(pos)) : undefined,
      }))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));

    return {
      ...base,
      connected: true,
      username: bot.username,
      health: bot.health,
      food: bot.food,
      foodSaturation: Number.isFinite(bot.foodSaturation) ? round1(bot.foodSaturation) : 0,
      xpLevel: experience?.level ?? 0,
      xpProgress: experience?.progress ?? 0,
      ping: bot.players[bot.username]?.ping,
      position: { x: round1(pos.x), y: round1(pos.y), z: round1(pos.z) },
      dimension: normalizeDimension(game?.dimension),
      gameMode: normalizeGameMode(game?.gameMode),
      timeOfDay: bot.time ? timeOfDayLabel(bot.time.timeOfDay) : undefined,
      isRaining: Boolean(bot.isRaining),
      heldItem: bot.heldItem?.name,
      facing: compassFromYaw(bot.entity.yaw),
      players,
      uptimeSeconds: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
    };
  }

  getInventoryResponse() {
    const bot = this.bot;
    if (!bot || this.connectionState !== "connected") {
      return { items: [], selectedSlot: undefined, heldItem: undefined };
    }
    return {
      items: this.getInventory(),
      selectedSlot: 36 + bot.quickBarSlot,
      heldItem: bot.heldItem?.name,
    };
  }

  getInventory() {
    const bot = this.bot;
    if (!bot) return [];
    const mcData = this.getMcData();
    const blockNames = mcData ? new Set<string>(Object.keys(mcData.blocksByName)) : undefined;
    const foodNames = mcData ? new Set<string>(Object.keys(mcData.foodsByName ?? {})) : undefined;

    return bot.inventory.items().map((item) => {
      const cls = classifyItem(item.name, { blockNames, foodNames });
      let durability: number | undefined;
      const maxDurability = mcData?.itemsByName?.[item.name]?.maxDurability;
      if (maxDurability && maxDurability > 0) {
        const used =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item as any).durabilityUsed ??
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item as any).nbt?.value?.Damage?.value ??
          0;
        durability = clamp(1 - used / maxDurability, 0, 1);
      }
      return {
        name: item.name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        displayName: (item as any).displayName ?? prettifyName(item.name),
        count: item.count,
        slot: item.slot,
        isArmor: cls.isArmor,
        isTool: cls.isTool,
        isFood: cls.isFood,
        category: cls.category,
        durability,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Status tick (replaces the old "broadcast on every move event" spam)
  // -------------------------------------------------------------------------

  private startStatusLoop(bot: Bot) {
    this.stopStatusLoop();
    this.statusTimer = setInterval(() => {
      if (this.bot !== bot || this.connectionState !== "connected" || !bot.entity) return;

      // Distance walked
      const pos = bot.entity.position;
      if (this.lastPosition) {
        const d = pos.distanceTo(this.lastPosition);
        if (d < 50) this.stats.distanceWalked += d; // ignore teleports
      }
      this.lastPosition = pos.clone();

      // Dead-man's switch for manual controls: if the dashboard stops
      // sending control updates, don't keep walking forever.
      if (this.manualEngaged && Date.now() - this.lastControlAt > 2500) {
        this.clearControlStates();
        this.manualEngaged = false;
        this.addLog("info", "Manual controls released (dashboard timeout)");
      }

      this.maybeAntiAfk(bot);
      this.broadcastStatus();
    }, 250);
  }

  private stopStatusLoop() {
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }
  }

  private maybeAntiAfk(bot: Bot) {
    if (!this.settings.antiAfk) return;
    if (this.activeTask || this.manualEngaged) return;
    if (Date.now() - this.lastActivityAt < 45_000) return;
    this.lastActivityAt = Date.now();
    this.afkCycle++;
    this.lookSafe(bot, bot.entity.yaw + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 0.3);
    if (this.afkCycle % 3 === 0) {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (this.bot === bot) bot.setControlState("jump", false);
      }, 260);
    } else if (this.afkCycle % 3 === 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bot as any).swingArm?.("right");
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing chat queue (rate-limited so servers don't kick for spam)
  // -------------------------------------------------------------------------

  private startChatLoop(bot: Bot) {
    this.stopChatLoop();
    this.chatTimer = setInterval(() => {
      if (this.bot !== bot) return;
      const next = this.chatQueue.shift();
      if (!next) return;
      try {
        bot.chat(next);
        this.addLog("info", `[BOT] ${next}`, "chat");
      } catch (err) {
        this.addLog("warn", `Failed to send chat: ${errText(err)}`, "chat");
      }
    }, 550);
  }

  private stopChatLoop() {
    if (this.chatTimer) {
      clearInterval(this.chatTimer);
      this.chatTimer = null;
    }
    this.chatQueue = [];
  }

  /** Queue a message/command for the bot to say in-game. */
  say(message: string) {
    const text = message.trim();
    if (!text) return;
    this.chatQueue.push(text.slice(0, 256));
    this.touchActivity();
  }

  // -------------------------------------------------------------------------
  // prismarine-viewer live view
  // -------------------------------------------------------------------------

  private startViewer(bot: Bot) {
    if (!this.settings.viewerEnabled || this.viewerRunning) return;
    try {
      loadViewer()(bot, {
        port: VIEWER_PORT,
        firstPerson: this.settings.viewerFirstPerson,
        viewDistance: 6,
        prefix: "/viewer",
      });
      this.viewerRunning = true;
      this.addLog("info", `Live view started (${this.settings.viewerFirstPerson ? "first-person" : "orbit"} camera)`);
    } catch (err) {
      this.viewerRunning = false;
      this.addLog("warn", `Could not start live view: ${errText(err)}`);
    }
  }

  private stopViewer() {
    if (this.bot) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.bot as any).viewer?.close?.();
      } catch {
        // ignore
      }
    }
    this.viewerRunning = false;
  }

  private restartViewer() {
    if (!this.bot) return;
    const bot = this.bot;
    this.stopViewer();
    // Give the old HTTP server a moment to release the port.
    void sleep(400).then(() => {
      if (this.bot === bot && this.settings.viewerEnabled) {
        this.startViewer(bot);
        this.broadcastStatus();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Task framework
  // -------------------------------------------------------------------------

  private beginTask(name: string, label: string): TaskToken {
    if (this.activeTask) {
      this.activeTask.token.cancel();
      this.stopMotion();
    }
    const token = new TaskToken();
    this.activeTask = { id: ++this.taskCounter, name, label, token };
    this.taskDetail = "";
    this.touchActivity();
    this.broadcastStatus();
    return token;
  }

  private endTask(token: TaskToken) {
    if (this.activeTask?.token !== token) return;
    this.activeTask = null;
    this.taskDetail = "";
    this.stopMotion();
    this.broadcastStatus();
  }

  private cancelActiveTask(reason: string) {
    if (!this.activeTask) return;
    const { label, token } = this.activeTask;
    token.cancel();
    this.stopMotion();
    this.activeTask = null;
    this.taskDetail = "";
    logger.info({ label, reason }, "Task cancelled");
    this.broadcastStatus();
  }

  private async runTask(
    name: string,
    label: string,
    fn: (token: TaskToken) => Promise<void>,
  ): Promise<void> {
    const token = this.beginTask(name, label);
    try {
      await fn(token);
    } catch (err) {
      if (isTaskCancelled(err)) {
        this.addLog("info", `Stopped: ${label}`, "task");
      } else {
        this.addLog("error", `${label} failed: ${errText(err)}`, "task");
      }
    } finally {
      this.endTask(token);
    }
  }

  private setTaskDetail(detail: string) {
    this.taskDetail = detail;
  }

  stop() {
    this.requireConnected();
    this.aiAbortRequested = true;
    this.aiAutopilot = false;
    this.cancelActiveTask("user stop");
    this.stopMotion();
    this.manualEngaged = false;
    const bot = this.bot!;
    if (bot.isSleeping) void bot.wake().catch(() => {});
    try { bot.stopDigging(); } catch { /* ignore */ }
    this.addLog("info", "Stopped all tasks", "task");
    this.broadcastStatus();
  }

  private stopMotion() {
    if (!this.bot) return;
    try { this.bot.pathfinder.stop(); } catch { /* ignore */ }
    this.clearControlStates();
  }

  private clearControlStates() {
    if (!this.bot) return;
    for (const key of CONTROL_KEYS) {
      try { this.bot.setControlState(key, false); } catch { /* ignore */ }
    }
    try { this.bot.clearControlStates(); } catch { /* older versions */ }
  }

  private touchActivity() {
    this.lastActivityAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Movement & interaction helpers
  // -------------------------------------------------------------------------

  private requireConnected(): Bot {
    if (!this.bot || this.connectionState !== "connected") {
      throw new Error("Bot not connected");
    }
    return this.bot;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getMcData(): any | null {
    if (!this.bot) return null;
    try {
      if (this.mcDataCache?.version === this.bot.version) return this.mcDataCache.data;
      const data = minecraftData(this.bot.version);
      this.mcDataCache = { version: this.bot.version, data };
      return data;
    } catch {
      return null;
    }
  }

  /** Configure pathfinder movements for the upcoming task. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setupMovements(opts: { dig?: boolean; parkour?: boolean; digCost?: number } = {}): any {
    const bot = this.bot!;
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    movements.allowParkour = opts.parkour ?? false;
    movements.canDig = opts.dig ?? true;
    // Digging through walls is rude & slow — prefer walking unless the task
    // is actually about digging.
    movements.digCost = opts.digCost ?? 8;
    bot.pathfinder.setMovements(movements);
    return movements;
  }

  /** pathfinder.goto wrapped in task cancellation. Returns false (no throw) when no path exists. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async gotoGoal(token: TaskToken, goal: any): Promise<boolean> {
    const bot = this.bot!;
    try {
      await token.wrap(bot.pathfinder.goto(goal), () => {
        try { bot.pathfinder.stop(); } catch { /* ignore */ }
      });
      return true;
    } catch (err) {
      if (isTaskCancelled(err)) throw err;
      return false;
    }
  }

  private async gotoNear(token: TaskToken, pos: Vec3, range = 2): Promise<boolean> {
    return this.gotoGoal(token, new goals.GoalNear(pos.x, pos.y, pos.z, range));
  }

  private async digBlock(token: TaskToken, block: McBlock): Promise<boolean> {
    const bot = this.bot!;
    try {
      await token.wrap(bot.dig(block), () => {
        try { bot.stopDigging(); } catch { /* ignore */ }
      });
      return true;
    } catch (err) {
      if (isTaskCancelled(err)) throw err;
      return false;
    }
  }

  private async equipItem(item: McItem, destination: "hand" | "off-hand" | "head" | "torso" | "legs" | "feet"): Promise<boolean> {
    const bot = this.bot!;
    if (destination === "hand" && bot.heldItem?.slot === item.slot) return true;
    try {
      await bot.equip(item, destination);
      return true;
    } catch {
      return false;
    }
  }

  private async equipBestWeapon(): Promise<void> {
    const bot = this.bot!;
    // Exclude pickaxes — they end with "_axe" but make poor weapons.
    const weapon = findBestBySuffix(
      bot.inventory.items().filter((i) => !i.name.endsWith("_pickaxe")),
      ["_sword", "mace", "trident", "_axe"],
    );
    if (weapon && bot.heldItem?.slot !== weapon.slot) {
      await this.equipItem(weapon, "hand");
    }
  }

  private bestTool(kind: "pickaxe" | "axe"): McItem | null {
    const bot = this.bot!;
    // Note: "_axe" suffix must exclude pickaxes ("diamond_pickaxe" ends with "axe"):
    const items = bot.inventory.items().filter((i) =>
      kind === "pickaxe" ? i.name.endsWith("_pickaxe") : i.name.endsWith("_axe") && !i.name.endsWith("_pickaxe"),
    );
    if (items.length === 0) return null;
    return items.sort((a, b) => gearScore(b.name) - gearScore(a.name))[0];
  }

  /** Find the best food to eat right now. */
  private bestFood(opts: { allowBad?: boolean } = {}): McItem | null {
    const bot = this.bot!;
    const mcData = this.getMcData();
    if (!mcData?.foodsByName) return null;
    const foods = bot.inventory
      .items()
      .filter((i) => mcData.foodsByName[i.name])
      .filter((i) => opts.allowBad || !BAD_FOODS.has(i.name))
      .filter((i) => {
        // Save golden apples for emergencies unless health is low.
        if (i.name.includes("golden_apple") && bot.health > 8) return false;
        return true;
      })
      .sort((a, b) => {
        const fa = mcData.foodsByName[a.name];
        const fb = mcData.foodsByName[b.name];
        return fb.foodPoints + fb.saturation - (fa.foodPoints + fa.saturation);
      });
    return foods[0] ?? null;
  }

  private nearestHostile(maxDistance: number): McEntity | null {
    const bot = this.bot!;
    const origin = bot.entity.position;
    let best: McEntity | null = null;
    let bestDist = Infinity;
    for (const e of Object.values(bot.entities)) {
      if (!e.position || !isHostileMob(e.name)) continue;
      const d = e.position.distanceTo(origin);
      if (d < bestDist && d <= maxDistance) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // Survival behaviours
  // -------------------------------------------------------------------------

  private async eatBestFood(source: "auto" | "manual"): Promise<void> {
    const bot = this.bot;
    if (!bot || this.eating) return;
    if (bot.food >= 20) {
      if (source === "manual") this.addLog("info", "Already full — no need to eat");
      return;
    }
    let food = this.bestFood();
    if (!food && source === "manual") food = this.bestFood({ allowBad: true });
    if (!food) {
      if (source === "manual") throw new Error("No food in inventory");
      return;
    }
    this.eating = true;
    try {
      let eaten = 0;
      while (this.bot === bot && bot.food <= 17 && eaten < 4) {
        const next = eaten === 0 ? food : this.bestFood();
        if (!next) break;
        await this.equipItem(next, "hand");
        await bot.consume();
        eaten++;
        this.addLog("success", `${source === "auto" ? "Auto-eat" : "Ate"}: ${prettifyName(next.name)} (food now ${bot.food}/20)`);
      }
    } catch (err) {
      this.addLog("warn", `Eating failed: ${errText(err)}`);
    } finally {
      this.eating = false;
    }
  }

  private async maybeAutoEat() {
    const bot = this.bot;
    if (!bot || !this.settings.autoEat || this.eating) return;
    const hungry = bot.food <= this.settings.autoEatThreshold;
    const needsRegen = bot.health < 20 && bot.food < 18;
    const critical = bot.food <= 6;
    if (!hungry && !needsRegen) return;
    // Don't swap a mining pickaxe for a porkchop mid-task unless starving.
    if (this.activeTask && !critical) return;
    await this.eatBestFood("auto");
  }

  private async maybeEquipArmor() {
    const bot = this.bot;
    if (!bot || this.equippingArmor || this.connectionState !== "connected") return;
    this.equippingArmor = true;
    try {
      const slots = Object.keys(ARMOR_WINDOW_SLOT) as Array<keyof typeof ARMOR_WINDOW_SLOT>;
      for (const slotName of slots) {
        if (this.bot !== bot) return;
        const current = bot.inventory.slots[ARMOR_WINDOW_SLOT[slotName]];
        const currentScore = current ? armorScore(current.name) : -1;
        const best = bot.inventory
          .items()
          .filter((i) => armorSlotFor(i.name) === slotName)
          .sort((a, b) => armorScore(b.name) - armorScore(a.name))[0];
        if (best && armorScore(best.name) > currentScore) {
          const ok = await this.equipItem(best, slotName);
          if (ok) this.addLog("info", `Equipped ${prettifyName(best.name)}`);
        }
      }
    } finally {
      this.equippingArmor = false;
    }
  }

  private async maybeAutoDefend() {
    const bot = this.bot;
    if (!bot || this.activeTask) return;
    if (Date.now() - this.lastDefendAt < 4000) return;
    const mob = this.nearestHostile(10);
    if (!mob) return;
    this.lastDefendAt = Date.now();
    this.addLog("warn", `Under attack by ${mob.name ?? "something"} — fighting back!`, "combat");
    await this.runTask("defend", "defending", async (token) => {
      await this.combatEntity(token, mob);
    });
  }

  /** Used inside work loops (mine/chop/wander): deal with a close hostile, returns true if we fought. */
  private async defendIfThreatened(token: TaskToken): Promise<boolean> {
    const mob = this.nearestHostile(7);
    if (!mob) return false;
    if (!this.settings.autoDefend) {
      if (Date.now() - this.lastHostileWarnAt > 10_000) {
        this.lastHostileWarnAt = Date.now();
        this.addLog("warn", `Hostile ${mob.name ?? "mob"} is close by! (auto-defend is off)`, "combat");
      }
      return false;
    }
    this.addLog("warn", `Hostile ${mob.name ?? "mob"} interrupting — engaging!`, "combat");
    await this.combatEntity(token, mob);
    return true;
  }

  /**
   * Real combat loop: chase with a dynamic follow goal, swing on cooldown,
   * hit-and-retreat from creepers, flee + eat when health is critical.
   * Returns true when the target died/despawned.
   */
  private async combatEntity(token: TaskToken, entity: McEntity): Promise<boolean> {
    const bot = this.bot!;
    const targetName = entity.name ?? entity.username ?? "target";
    await this.equipBestWeapon();
    this.setupMovements({ dig: false });

    let lastSwing = 0;
    const startedAt = Date.now();
    const isCreeper = (entity.name ?? "").includes("creeper");
    bot.pathfinder.setGoal(new goals.GoalFollow(entity, isCreeper ? 3 : 2), true);

    try {
      while (Date.now() - startedAt < 45_000) {
        token.throwIfCancelled();
        const current = bot.entities[entity.id];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (!current || (current as any).isValid === false) {
          this.stats.mobsKilled++;
          this.addLog("success", `Killed ${targetName}`, "combat");
          return true;
        }

        if (!bot.pathfinder.goal) {
          bot.pathfinder.setGoal(new goals.GoalFollow(current, isCreeper ? 3 : 2), true);
        }

        if (bot.health <= 5) {
          this.addLog("error", `Health critical (${Math.ceil(bot.health)} HP) — fleeing from ${targetName}!`, "combat");
          try { bot.pathfinder.stop(); } catch { /* ignore */ }
          const dx = bot.entity.position.x - current.position.x;
          const dz = bot.entity.position.z - current.position.z;
          const len = Math.hypot(dx, dz) || 1;
          const fleeX = Math.floor(bot.entity.position.x + (dx / len) * 18);
          const fleeZ = Math.floor(bot.entity.position.z + (dz / len) * 18);
          bot.setControlState("sprint", true);
          await this.gotoGoal(token, new goals.GoalXZ(fleeX, fleeZ)).catch(() => false);
          bot.setControlState("sprint", false);
          await this.eatBestFood("auto");
          return false;
        }

        const dist = bot.entity.position.distanceTo(current.position);
        if (dist <= 3.4 && Date.now() - lastSwing >= 550) {
          await bot.lookAt(current.position.offset(0, (current.height ?? 1.6) * 0.75, 0), true);
          bot.attack(current);
          lastSwing = Date.now();
          if (isCreeper) {
            // Backpedal so it doesn't detonate in the bot's face.
            try { bot.pathfinder.stop(); } catch { /* ignore */ }
            bot.setControlState("back", true);
            await token.sleep(320);
            bot.setControlState("back", false);
          }
        }
        await token.sleep(110);
      }
      this.addLog("warn", `Combat with ${targetName} timed out — disengaging`, "combat");
      return false;
    } finally {
      try { bot.pathfinder.stop(); } catch { /* ignore */ }
    }
  }

  /** Walk over nearby dropped items to pick them up. Returns how many spots were visited. */
  private async collectNearbyItems(token: TaskToken, radius = 16, maxItems = 32): Promise<number> {
    const bot = this.bot!;
    const failed = new Set<number>();
    let visited = 0;
    while (visited < maxItems) {
      token.throwIfCancelled();
      const items = Object.values(bot.entities)
        .filter((e) => e.name === "item" && e.position && !failed.has(e.id))
        .map((e) => ({ e, d: e.position.distanceTo(bot.entity.position) }))
        .filter(({ d }) => d <= radius)
        .sort((a, b) => a.d - b.d);
      if (items.length === 0) break;
      const { e } = items[0];
      const ok = await this.gotoNear(token, e.position, 1);
      if (!ok) {
        failed.add(e.id);
        continue;
      }
      visited++;
      await token.sleep(140); // give the pickup a tick to happen
    }
    return visited;
  }

  // -------------------------------------------------------------------------
  // Commands — tasks
  // -------------------------------------------------------------------------

  /** Resolve a player name case-insensitively to the exact online username. */
  private resolvePlayerName(name: string): string | null {
    const bot = this.bot;
    if (!bot) return null;
    if (bot.players[name]) return name;
    const lower = name.toLowerCase();
    return Object.keys(bot.players).find((k) => k.toLowerCase() === lower) ?? null;
  }

  async follow(targetNameInput: string) {
    const bot = this.requireConnected();
    const targetName = this.resolvePlayerName(targetNameInput);
    if (!targetName) {
      throw new Error(`Player "${targetNameInput}" is not online`);
    }
    await this.runTask("follow", `following ${targetName}`, async (token) => {
      this.addLog("info", `Following ${targetName} (STOP to end)`, "task");
      this.setupMovements({ dig: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let goalEntity: any = null;
      let warnedMissing = false;
      while (true) {
        const player = bot.players[targetName];
        if (!player) {
          this.addLog("warn", `${targetName} left the server — stopping follow`, "task");
          return;
        }
        const entity = player.entity;
        if (!entity) {
          if (!warnedMissing) {
            this.addLog("warn", `${targetName} is out of render distance — waiting…`, "task");
            warnedMissing = true;
          }
          try { bot.pathfinder.stop(); } catch { /* ignore */ }
          goalEntity = null;
        } else {
          warnedMissing = false;
          if (goalEntity !== entity || !bot.pathfinder.goal) {
            bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
            goalEntity = entity;
          }
        }
        await token.sleep(900);
      }
    });
  }

  async gotoCoords(x: number, y: number | undefined, z: number) {
    this.requireConnected();
    const label = y !== undefined ? `going to ${x}, ${y}, ${z}` : `going to ${x}, ${z}`;
    await this.runTask("goto", label, async (token) => {
      this.setupMovements({ dig: true, digCost: 6 });
      const goal =
        y !== undefined
          ? new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 1)
          : new goals.GoalXZ(Math.floor(x), Math.floor(z));
      this.addLog("info", `Pathfinding to ${x}, ${y ?? "?"}, ${z}…`, "task");
      const ok = await this.gotoGoal(token, goal);
      const pos = this.bot!.entity.position;
      if (ok) {
        this.addLog("success", `Arrived at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`, "task");
      } else {
        this.addLog("warn", `Couldn't find a path to ${x}, ${y ?? "?"}, ${z} (stopped at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})`, "task");
      }
    });
  }

  async killMobs() {
    this.requireConnected();
    await this.runTask("killMobs", "killing mobs", async (token) => {
      this.addLog("info", "Hunting hostile mobs within 24 blocks…", "combat");
      let kills = 0;
      while (true) {
        token.throwIfCancelled();
        const mob = this.nearestHostile(24);
        if (!mob) break;
        this.setTaskDetail(`fighting ${mob.name ?? "mob"} (${kills} killed)`);
        const killed = await this.combatEntity(token, mob);
        if (killed) kills++;
        if (this.settings.autoCollectDrops) {
          await this.collectNearbyItems(token, 8, 10);
        }
        await token.sleep(200);
      }
      if (kills === 0) this.addLog("info", "No hostile mobs nearby", "combat");
      else this.addLog("success", `Area clear — killed ${kills} mob(s)`, "combat");
    });
  }

  async guard() {
    const bot = this.requireConnected();
    await this.runTask("guard", "guarding area", async (token) => {
      const anchor = bot.entity.position.clone();
      this.addLog("info", `Guarding ${Math.floor(anchor.x)}, ${Math.floor(anchor.y)}, ${Math.floor(anchor.z)} — hostiles within 16 blocks will be attacked (STOP to end)`, "combat");
      while (true) {
        token.throwIfCancelled();
        const mob = this.nearestHostile(32);
        const mobNearAnchor = mob && mob.position.distanceTo(anchor) <= 16 ? mob : null;
        if (mobNearAnchor) {
          await this.combatEntity(token, mobNearAnchor);
          if (this.settings.autoCollectDrops) await this.collectNearbyItems(token, 8, 10);
          continue;
        }
        if (bot.entity.position.distanceTo(anchor) > 3) {
          this.setupMovements({ dig: false });
          await this.gotoNear(token, anchor, 1);
        }
        // Slow scan of the surroundings while idle.
        this.lookSafe(bot, bot.entity.yaw + 0.7, 0);
        await token.sleep(900);
      }
    });
  }

  async wander() {
    const bot = this.requireConnected();
    await this.runTask("wander", "wandering", async (token) => {
      this.addLog("info", "Wandering around… (STOP to end)", "task");
      this.setupMovements({ dig: false });
      while (true) {
        token.throwIfCancelled();
        await this.defendIfThreatened(token);
        const pos = bot.entity.position;
        const angle = Math.random() * Math.PI * 2;
        const dist = 14 + Math.random() * 22;
        const x = Math.floor(pos.x + Math.cos(angle) * dist);
        const z = Math.floor(pos.z + Math.sin(angle) * dist);
        await this.gotoGoal(token, new goals.GoalXZ(x, z));
        await token.sleep(800 + Math.random() * 2200);
      }
    });
  }

  async mine(resource: string, targetCount?: number) {
    this.requireConnected();
    const info = RESOURCES[resource];
    if (!info) {
      throw new Error(`Unknown resource: ${resource}. Valid: ${Object.keys(RESOURCES).join(", ")}`);
    }
    const target = clamp(Math.round(targetCount ?? 16), 1, 512);

    await this.runTask("mine", `mining ${resource}`, async (token) => {
      const bot = this.bot!;
      const mcData = this.getMcData();
      if (!mcData) throw new Error("Minecraft data unavailable for this version");

      const blockIds = info.blocks
        .map((n: string) => mcData.blocksByName[n]?.id)
        .filter((id: number | undefined): id is number => id !== undefined);
      if (blockIds.length === 0) {
        this.addLog("error", `${prettifyName(resource)} blocks don't exist in MC ${bot.version}`, "task");
        return;
      }
      const idSet = new Set<number>(blockIds);

      const pick = this.bestTool("pickaxe");
      const tier = pick ? pickaxeTier(pick.name) : -1;
      if (!pick || tier < info.minPickaxeTier) {
        this.addLog(
          "error",
          pick
            ? `${prettifyName(pick.name)} can't harvest ${resource} — I need ${info.requiredPickaxe} or the blocks will drop nothing`
            : `No pickaxe in inventory — I need ${info.requiredPickaxe} to mine ${resource}`,
          "task",
        );
        return;
      }
      await this.equipItem(pick, "hand");
      this.addLog("info", `Mining ${target}× ${resource} with ${prettifyName(pick.name)}…`, "task");
      this.setupMovements({ dig: true, digCost: 1 });

      let dug = 0;
      let failedExplores = 0;
      let exploreAngle = Math.random() * Math.PI * 2;
      this.setTaskDetail(`${dug}/${target} ${resource}`);

      while (dug < target) {
        token.throwIfCancelled();
        if (await this.defendIfThreatened(token)) {
          const p = this.bestTool("pickaxe");
          if (p) await this.equipItem(p, "hand");
        }

        const found = bot.findBlock({ matching: blockIds, maxDistance: 48 });
        if (!found) {
          failedExplores++;
          if (failedExplores > 6) {
            this.addLog(
              "warn",
              `No ${resource} found after exploring the area (${dug}/${target} mined). Most ores are underground — send me into a cave with Go To, then mine again.`,
              "task",
            );
            return;
          }
          exploreAngle += 2.4; // golden-angle spiral
          const radius = 18 + failedExplores * 7;
          const pos = bot.entity.position;
          this.addLog("info", `No ${resource} in range — exploring…`, "task");
          await this.gotoGoal(
            token,
            new goals.GoalXZ(
              Math.floor(pos.x + Math.cos(exploreAngle) * radius),
              Math.floor(pos.z + Math.sin(exploreAngle) * radius),
            ),
          );
          continue;
        }
        failedExplores = 0;

        // Mine the whole vein, not just one block.
        const vein = this.collectVein(found.position, idSet, 48);
        vein.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
        for (const pos of vein) {
          if (dug >= target) break;
          token.throwIfCancelled();
          let block = bot.blockAt(pos);
          if (!block || !idSet.has(block.type)) continue;
          if (bot.entity.position.distanceTo(pos) > 4) {
            const ok = await this.gotoNear(token, pos, 2);
            if (!ok) continue;
            block = bot.blockAt(pos);
            if (!block || !idSet.has(block.type)) continue;
          }
          const p = this.bestTool("pickaxe");
          if (p && bot.heldItem?.slot !== p.slot) await this.equipItem(p, "hand");
          if (await this.digBlock(token, block)) {
            dug++;
            this.stats.blocksMined++;
            this.setTaskDetail(`${dug}/${target} ${resource}`);
          }
        }
        if (this.settings.autoCollectDrops) {
          await token.sleep(250);
          await this.collectNearbyItems(token, 9, 16);
        }
        await token.sleep(120);
      }
      this.addLog("success", `Mining complete: ${dug}× ${resource}`, "task");
    });
  }

  /** BFS over all touching blocks of the same family (ore veins / tree canopies). */
  private collectVein(start: Vec3, idSet: Set<number>, max: number): Vec3[] {
    const bot = this.bot!;
    const result: Vec3[] = [];
    const visited = new Set<string>();
    const queue: Vec3[] = [start.clone()];
    while (queue.length > 0 && result.length < max) {
      const pos = queue.shift()!;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const block = bot.blockAt(pos);
      if (!block || !idSet.has(block.type)) continue;
      result.push(pos.clone());
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            queue.push(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
          }
        }
      }
    }
    return result;
  }

  async chopTree(treeType = "any", treeCount = 1) {
    this.requireConnected();
    if (treeType !== "any" && !TREE_TYPES[treeType]) {
      throw new Error(`Unknown tree type: ${treeType}. Valid: ${Object.keys(TREE_TYPES).join(", ")}, any`);
    }
    const count = clamp(Math.round(treeCount), 1, 25);
    await this.runTask("chopTree", `chopping ${treeType === "any" ? "" : treeType + " "}tree${count > 1 ? "s" : ""}`, async (token) => {
      let done = 0;
      while (done < count) {
        token.throwIfCancelled();
        const logs = await this.chopOneTree(token, treeType);
        if (logs === 0) break;
        done++;
        this.setTaskDetail(`${done}/${count} trees`);
      }
      if (done > 0) this.addLog("success", `Finished chopping ${done} tree(s)`, "task");
    });
  }

  /** Chop a single tree (flood-fill the logs, collect drops, replant). Returns logs chopped. */
  private async chopOneTree(token: TaskToken, treeType: string): Promise<number> {
    const bot = this.bot!;
    const mcData = this.getMcData();
    if (!mcData) throw new Error("Minecraft data unavailable for this version");

    const searchNames = treeType === "any" ? ALL_LOG_NAMES : TREE_TYPES[treeType].logs;
    const searchIds = searchNames
      .map((n: string) => mcData.blocksByName[n]?.id)
      .filter((id: number | undefined): id is number => id !== undefined);
    if (searchIds.length === 0) {
      this.addLog("warn", `No log blocks found for ${treeType} in MC ${bot.version}`, "task");
      return 0;
    }

    const axe = this.bestTool("axe");
    if (axe) await this.equipItem(axe, "hand");

    const firstLog = bot.findBlock({ matching: searchIds, maxDistance: 64 });
    if (!firstLog) {
      this.addLog("warn", `No ${treeType === "any" ? "" : treeType + " "}tree found within 64 blocks`, "task");
      return 0;
    }
    const treeConfig = detectTreeType(firstLog.name) ?? TREE_TYPES["oak"];
    this.addLog("info", `Found ${firstLog.name} at ${firstLog.position.x}, ${firstLog.position.y}, ${firstLog.position.z} — chopping…`, "task");

    const idSet = new Set<number>(searchIds);
    const logPositions = this.collectVein(firstLog.position, idSet, 220);
    // Lowest log of each column → where a sapling should go back.
    const columnLowest = new Map<string, Vec3>();
    for (const pos of logPositions) {
      const key = `${pos.x},${pos.z}`;
      const existing = columnLowest.get(key);
      if (!existing || pos.y < existing.y) columnLowest.set(key, pos);
    }

    this.setupMovements({ dig: true, digCost: 2 });
    const sorted = logPositions.sort((a, b) => a.y - b.y);
    let chopped = 0;
    for (const pos of sorted) {
      token.throwIfCancelled();
      if (chopped % 4 === 0) await this.defendIfThreatened(token);
      let block = bot.blockAt(pos);
      if (!block || !idSet.has(block.type)) continue;
      if (bot.entity.position.distanceTo(pos) > 4) {
        const ok = await this.gotoNear(token, pos, 3);
        if (!ok) continue;
        block = bot.blockAt(pos);
        if (!block || !idSet.has(block.type)) continue;
      }
      const currentAxe = this.bestTool("axe");
      if (currentAxe && bot.heldItem?.slot !== currentAxe.slot) await this.equipItem(currentAxe, "hand");
      if (await this.digBlock(token, block)) {
        chopped++;
        this.stats.logsChopped++;
        this.setTaskDetail(`${chopped}/${sorted.length} logs`);
      }
      await token.sleep(90);
    }

    if (chopped === 0) return 0;
    this.stats.treesChopped++;
    this.addLog("success", `Chopped ${chopped} log(s)`, "task");

    // Let drops (logs, saplings, apples) fall, then hoover them up so we
    // actually have saplings to replant with.
    await token.sleep(1100);
    if (this.settings.autoCollectDrops) {
      await this.collectNearbyItems(token, 12, 24);
      await token.sleep(400);
    }

    const saplings = bot.inventory
      .items()
      .filter((i) => i.name === treeConfig.sapling)
      .reduce((sum, i) => sum + i.count, 0);
    if (saplings > 0) {
      const planted = await this.replantSaplings(token, [...columnLowest.values()], treeConfig, saplings);
      if (planted > 0) this.addLog("success", `Replanted ${planted}× ${prettifyName(treeConfig.sapling)}`, "task");
    } else {
      this.addLog("info", "No saplings dropped — nothing to replant", "task");
    }
    return chopped;
  }

  private async replantSaplings(
    token: TaskToken,
    stumps: Vec3[],
    config: TreeTypeConfig,
    maxCount: number,
  ): Promise<number> {
    const bot = this.bot!;
    const mcData = this.getMcData();
    const soilIds = new Set<number>(
      config.soil
        .map((s) => mcData?.blocksByName[s]?.id)
        .filter((id: number | undefined): id is number => id !== undefined),
    );
    let placed = 0;
    for (const stump of stumps) {
      if (placed >= maxCount) break;
      token.throwIfCancelled();
      const soilPos = new Vec3(stump.x, stump.y - 1, stump.z);
      const soil = bot.blockAt(soilPos);
      if (!soil || !soilIds.has(soil.type)) continue;
      const above = bot.blockAt(stump);
      if (!above || above.type !== 0) continue;
      if (bot.entity.position.distanceTo(stump) > 4) {
        await this.gotoNear(token, stump, 2);
      }
      const saplingItem = bot.inventory.items().find((i) => i.name === config.sapling);
      if (!saplingItem) break;
      await this.equipItem(saplingItem, "hand");
      try {
        await bot.placeBlock(soil, new Vec3(0, 1, 0));
        placed++;
      } catch {
        // unreachable spot — skip silently, replanting is best effort
      }
      await token.sleep(220);
    }
    return placed;
  }

  async buildBase(sizeInput?: number) {
    const bot = this.requireConnected();
    const size = clamp(Math.round(sizeInput ?? 5), 3, 11);
    await this.runTask("buildBase", `building ${size}×${size} shelter`, async (token) => {
      const mcData = this.getMcData();
      const blockNames = mcData ? new Set<string>(Object.keys(mcData.blocksByName)) : new Set<string>();
      const FALLING = new Set(["sand", "red_sand", "gravel", "suspicious_sand", "suspicious_gravel"]);

      // Pick the most plentiful solid, non-falling block as building material.
      const totals = new Map<string, number>();
      for (const item of bot.inventory.items()) {
        if (!blockNames.has(item.name) || FALLING.has(item.name) || item.name.endsWith("_concrete_powder")) continue;
        totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
      }
      const material = [...totals.entries()].sort((a, b) => b[1] - a[1])[0];
      if (!material) {
        this.addLog("error", "No building blocks in inventory (need cobblestone, stone, planks, dirt…)", "task");
        return;
      }
      const perimeter = size * 4 - 4;
      const needed = perimeter * 3 - 2 /* door */ + size * size /* roof */;
      this.addLog(
        "info",
        `Building ${size}×${size} shelter from ${material[1]}× ${prettifyName(material[0])} (≈${needed} blocks needed)`,
        "task",
      );
      if (material[1] < needed) {
        this.addLog("warn", `Not quite enough material — I'll build what I can, walls first`, "task");
      }

      this.setupMovements({ dig: false });
      const origin = bot.entity.position.floored().offset(1, 0, 1);
      const floorY = this.groundY(origin.x + Math.floor(size / 2), origin.z + Math.floor(size / 2), origin.y);
      const doorX = Math.floor(size / 2);

      let placedCount = 0;
      let presentCount = 0;
      const placeAt = async (x: number, y: number, z: number): Promise<void> => {
        const outcome = await this.placeBuildingBlock(token, new Vec3(x, y, z), material[0]);
        if (outcome === "placed") {
          placedCount++;
          this.setTaskDetail(`${placedCount} blocks placed`);
        } else if (outcome === "present") {
          presentCount++;
        }
      };

      // Walls, bottom-up (with a 2-high door gap on the south side).
      for (let level = 1; level <= 3; level++) {
        for (let x = 0; x < size; x++) {
          for (let z = 0; z < size; z++) {
            const onEdge = x === 0 || z === 0 || x === size - 1 || z === size - 1;
            if (!onEdge) continue;
            if (z === 0 && x === doorX && level <= 2) continue; // door
            token.throwIfCancelled();
            await placeAt(origin.x + x, floorY + level, origin.z + z);
          }
        }
      }

      // Roof, expanding from one corner so every block has a neighbour to place against.
      const roofCells: Array<[number, number]> = [];
      for (let x = 0; x < size; x++) for (let z = 0; z < size; z++) roofCells.push([x, z]);
      roofCells.sort((a, b) => a[0] + a[1] - (b[0] + b[1]) || a[0] - b[0]);
      for (const [x, z] of roofCells) {
        token.throwIfCancelled();
        await placeAt(origin.x + x, floorY + 4, origin.z + z);
      }

      // Torch in the middle if we have one.
      const torch = bot.inventory.items().find((i) => i.name === "torch");
      if (torch) {
        const center = new Vec3(origin.x + doorX, floorY + 1, origin.z + doorX);
        await this.placeBuildingBlock(token, center, "torch");
      }

      this.addLog("success", `Shelter built: ${placedCount} blocks placed (${presentCount} already solid) with a door gap on the south side`, "task");
    });
  }

  /** Y of the top solid block in a column near a reference height. */
  private groundY(x: number, z: number, nearY: number): number {
    const bot = this.bot!;
    for (let y = nearY + 3; y >= nearY - 8; y--) {
      const block = bot.blockAt(new Vec3(x, y, z));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (block && (block as any).boundingBox === "block") return y;
    }
    return nearY - 1;
  }

  private async placeBuildingBlock(
    token: TaskToken,
    targetPos: Vec3,
    itemName: string,
  ): Promise<"placed" | "present" | "failed"> {
    const bot = this.bot!;
    const existing = bot.blockAt(targetPos);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (existing && existing.type !== 0 && (existing as any).boundingBox === "block") return "present";

    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return "failed";

    if (bot.entity.position.distanceTo(targetPos) > 4) {
      const ok = await this.gotoNear(token, targetPos, 3);
      token.throwIfCancelled();
      if (!ok && bot.entity.position.distanceTo(targetPos) > 4.5) return "failed";
    }

    // Find a solid reference block to place against (below first, then sides, then above).
    const faceCandidates: Array<{ ref: Vec3; face: Vec3 }> = [
      { ref: targetPos.offset(0, -1, 0), face: new Vec3(0, 1, 0) },
      { ref: targetPos.offset(1, 0, 0), face: new Vec3(-1, 0, 0) },
      { ref: targetPos.offset(-1, 0, 0), face: new Vec3(1, 0, 0) },
      { ref: targetPos.offset(0, 0, 1), face: new Vec3(0, 0, -1) },
      { ref: targetPos.offset(0, 0, -1), face: new Vec3(0, 0, 1) },
      { ref: targetPos.offset(0, 1, 0), face: new Vec3(0, -1, 0) },
    ];
    const freshItem = bot.inventory.items().find((i) => i.name === itemName);
    if (!freshItem) return "failed";
    await this.equipItem(freshItem, "hand");

    for (const { ref, face } of faceCandidates) {
      const refBlock = bot.blockAt(ref);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!refBlock || refBlock.type === 0 || (refBlock as any).boundingBox !== "block") continue;
      try {
        await token.wrap(bot.placeBlock(refBlock, face));
        return "placed";
      } catch (err) {
        if (isTaskCancelled(err)) throw err;
        // try the next face
      }
    }
    return "failed";
  }

  async climb(blocksInput?: number) {
    const bot = this.requireConnected();
    const blocks = clamp(Math.round(blocksInput ?? 10), 1, 64);
    await this.runTask("climb", `pillaring up ${blocks}`, async (token) => {
      const findScaffold = () => {
        for (const name of SCAFFOLD_BLOCKS) {
          const item = bot.inventory.items().find((i) => i.name === name);
          if (item) return item;
        }
        const mcData = this.getMcData();
        const blockNames = mcData ? Object.keys(mcData.blocksByName) : [];
        return bot.inventory.items().find((i) => blockNames.includes(i.name)) ?? null;
      };
      if (!findScaffold()) {
        this.addLog("error", "No blocks to pillar with (need dirt, cobblestone, etc.)", "task");
        return;
      }
      this.addLog("info", `Pillaring up ${blocks} blocks…`, "task");
      let climbed = 0;
      for (let i = 0; i < blocks; i++) {
        token.throwIfCancelled();
        const item = findScaffold();
        if (!item) {
          this.addLog("warn", `Ran out of blocks after ${climbed} (of ${blocks})`, "task");
          return;
        }
        await this.equipItem(item, "hand");
        const belowPos = bot.entity.position.floored().offset(0, -1, 0);
        const ref = bot.blockAt(belowPos);
        if (!ref || ref.type === 0) {
          this.addLog("warn", "Nothing solid below — can't pillar here", "task");
          return;
        }
        const startY = bot.entity.position.y;
        bot.setControlState("jump", true);
        try {
          let placedIt = false;
          const deadline = Date.now() + 1600;
          while (Date.now() < deadline) {
            await token.sleep(40);
            if (bot.entity.position.y > startY + 0.9) {
              await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch(() => {});
              placedIt = true;
              break;
            }
          }
          bot.setControlState("jump", false);
          await token.sleep(320);
          if (!placedIt || bot.entity.position.y < startY + 0.4) {
            this.addLog("warn", `Pillar stalled after ${climbed} blocks (something overhead?)`, "task");
            return;
          }
          climbed++;
          this.setTaskDetail(`${climbed}/${blocks} blocks`);
        } finally {
          bot.setControlState("jump", false);
        }
      }
      this.addLog("success", `Pillared up ${climbed} blocks to Y=${Math.floor(bot.entity.position.y)} (careful getting down!)`, "task");
    });
  }

  private resolveEntity(name: string, playerOnly: boolean): McEntity | null {
    const bot = this.bot!;
    const player = bot.players[name]?.entity;
    if (player) return player;
    if (playerOnly) return null;
    const lower = name.toLowerCase();
    const candidates = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position)
      .filter((e) => e.username === name || (e.name ?? "").toLowerCase() === lower)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    return candidates[0] ?? null;
  }

  async attackOnce(targetName: string, playerOnly = false) {
    this.requireConnected();
    if (!this.resolveEntity(targetName, playerOnly)) {
      throw new Error(`Target "${targetName}" not found nearby`);
    }
    await this.runTask("attack", `attacking ${targetName}`, async (token) => {
      const bot = this.bot!;
      await this.equipBestWeapon();
      this.setupMovements({ dig: false });
      const entity = this.resolveEntity(targetName, playerOnly);
      if (!entity) {
        this.addLog("warn", `${targetName} moved out of range`, "combat");
        return;
      }
      if (bot.entity.position.distanceTo(entity.position) > 3.2) {
        await this.gotoNear(token, entity.position, 2);
      }
      const fresh = bot.entities[entity.id] ?? entity;
      if (bot.entity.position.distanceTo(fresh.position) > 4) {
        this.addLog("warn", `Couldn't get in range of ${targetName}`, "combat");
        return;
      }
      await bot.lookAt(fresh.position.offset(0, (fresh.height ?? 1.6) * 0.8, 0), true);
      bot.attack(fresh);
      this.addLog("success", `Hit ${targetName}`, "combat");
    });
  }

  async pullLever() {
    const bot = this.requireConnected();
    const mcData = this.getMcData();
    const ids = BUTTON_AND_LEVER_BLOCKS
      .map((n) => mcData?.blocksByName[n]?.id)
      .filter((id: number | undefined): id is number => id !== undefined);
    const block = bot.findBlock({ matching: ids, maxDistance: 32 });
    if (!block) throw new Error("No lever or button found within 32 blocks");

    await this.runTask("pullLever", `using ${block.name}`, async (token) => {
      this.setupMovements({ dig: false });
      if (bot.entity.position.distanceTo(block.position) > 3.5) {
        const ok = await this.gotoNear(token, block.position, 2);
        if (!ok) throw new Error("Couldn't path to the lever/button");
      }
      const fresh = bot.blockAt(block.position) ?? block;
      await bot.activateBlock(fresh);
      this.addLog("success", `Activated ${fresh.name} at ${block.position.x}, ${block.position.y}, ${block.position.z}`, "task");
    });
  }

  async sleepInBed() {
    const bot = this.requireConnected();
    const mcData = this.getMcData();
    const bedIds = BED_BLOCKS
      .map((n) => mcData?.blocksByName[n]?.id)
      .filter((id: number | undefined): id is number => id !== undefined);
    const bed = bot.findBlock({ matching: bedIds, maxDistance: 48 });
    if (!bed) throw new Error("No bed found within 48 blocks");

    await this.runTask("sleep", "sleeping", async (token) => {
      this.setupMovements({ dig: false });
      await this.gotoNear(token, bed.position, 2);
      const fresh = bot.blockAt(bed.position) ?? bed;
      try {
        await token.wrap(bot.sleep(fresh), () => {
          void bot.wake().catch(() => {});
        });
      } catch (err) {
        if (isTaskCancelled(err)) throw err;
        this.addLog("warn", `Couldn't sleep: ${errText(err)} (it may not be night yet)`, "task");
        return;
      }
      this.addLog("success", "Sleeping — wake me with STOP or morning", "task");
      token.onCancel(() => {
        void bot.wake().catch(() => {});
      });
      while (bot.isSleeping) {
        await token.sleep(1000);
      }
      this.addLog("info", "Woke up", "task");
    });
  }

  async collectItems() {
    this.requireConnected();
    await this.runTask("collectItems", "collecting drops", async (token) => {
      this.setupMovements({ dig: false });
      const n = await this.collectNearbyItems(token, 24, 48);
      this.addLog(n > 0 ? "success" : "info", n > 0 ? `Collected ${n} drop(s)` : "No drops nearby", "task");
    });
  }

  /** Items worth keeping on the bot (never dropped/deposited automatically). */
  private isEssential(item: McItem): boolean {
    if (item.slot >= 5 && item.slot <= 8) return true; // worn armor
    if (item.slot === 45) return true; // off-hand
    const mcData = this.getMcData();
    const foodNames = mcData ? new Set<string>(Object.keys(mcData.foodsByName ?? {})) : undefined;
    const cls = classifyItem(item.name, { foodNames });
    return cls.isArmor || cls.isTool || cls.isFood || cls.category === "weapon";
  }

  async dropItems(targetName?: string) {
    const bot = this.requireConnected();
    await this.runTask("dropItems", targetName ? `giving items to ${targetName}` : "dropping items", async (token) => {
      const droppable = bot.inventory.items().filter((i) => !this.isEssential(i));
      if (droppable.length === 0) {
        this.addLog("info", "Nothing to drop (keeping gear, weapons and food)", "task");
        return;
      }
      if (targetName) {
        const player = bot.players[targetName]?.entity;
        if (player) {
          this.setupMovements({ dig: false });
          await this.gotoNear(token, player.position, 2);
          const fresh = bot.players[targetName]?.entity;
          if (fresh) await bot.lookAt(fresh.position.offset(0, 1.4, 0), true);
        } else {
          this.addLog("warn", `${targetName} not nearby — dropping items here instead`, "task");
        }
      }
      let total = 0;
      for (const item of droppable) {
        token.throwIfCancelled();
        const fresh = bot.inventory.slots[item.slot];
        if (!fresh) continue;
        try {
          await bot.tossStack(fresh);
          total += fresh.count;
          await token.sleep(130);
        } catch (err) {
          this.addLog("warn", `Failed to drop ${fresh.name}: ${errText(err)}`, "task");
        }
      }
      this.addLog("success", `Dropped ${total} item(s)${targetName ? ` for ${targetName}` : ""} (kept gear & food)`, "task");
    });
  }

  async depositItems() {
    const bot = this.requireConnected();
    const mcData = this.getMcData();
    const ids = CONTAINER_BLOCKS
      .map((n) => mcData?.blocksByName[n]?.id)
      .filter((id: number | undefined): id is number => id !== undefined);
    const chest = bot.findBlock({ matching: ids, maxDistance: 32 });
    if (!chest) throw new Error("No chest/barrel found within 32 blocks");

    await this.runTask("depositItems", "depositing to chest", async (token) => {
      this.setupMovements({ dig: false });
      if (bot.entity.position.distanceTo(chest.position) > 3) {
        const ok = await this.gotoNear(token, chest.position, 2);
        if (!ok) throw new Error("Couldn't path to the chest");
      }
      const fresh = bot.blockAt(chest.position) ?? chest;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const container: any = await token.wrap(bot.openContainer(fresh));
      try {
        const toDeposit = bot.inventory.items().filter((i) => !this.isEssential(i));
        if (toDeposit.length === 0) {
          this.addLog("info", "Nothing to deposit (keeping gear, weapons and food)", "task");
          return;
        }
        let total = 0;
        let stacks = 0;
        for (const item of toDeposit) {
          token.throwIfCancelled();
          try {
            await container.deposit(item.type, item.metadata ?? null, item.count);
            total += item.count;
            stacks++;
          } catch {
            this.addLog("warn", `Chest may be full — couldn't deposit ${item.name}`, "task");
            break;
          }
        }
        this.addLog("success", `Deposited ${total} item(s) in ${stacks} stack(s) into the ${fresh.name}`, "task");
      } finally {
        try { container.close(); } catch { /* ignore */ }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Commands — one-shot actions
  // -------------------------------------------------------------------------

  async eatNow() {
    this.requireConnected();
    await this.eatBestFood("manual");
  }

  sendChat(message: string) {
    this.requireConnected();
    const text = message.trim();
    if (!text) throw new Error("Message is empty");
    if (text.length > 256) throw new Error("Message too long (max 256 characters)");
    this.say(text);
  }

  async equipFromSlot(slot: number) {
    const bot = this.requireConnected();
    const item = bot.inventory.slots[slot];
    if (!item) throw new Error(`Slot ${slot} is empty`);
    const armorSlot = armorSlotFor(item.name);
    const destination = armorSlot ?? (item.name === "shield" || item.name === "totem_of_undying" ? "off-hand" : "hand");
    const ok = await this.equipItem(item, destination);
    if (!ok) throw new Error(`Could not equip ${item.name}`);
    this.addLog("success", `Equipped ${prettifyName(item.name)}`);
    this.broadcastInventory();
  }

  async useFromSlot(slot: number) {
    const bot = this.requireConnected();
    const item = bot.inventory.slots[slot];
    if (!item) throw new Error(`Slot ${slot} is empty`);
    const mcData = this.getMcData();
    if (mcData?.foodsByName?.[item.name] && bot.food < 20) {
      await this.equipItem(item, "hand");
      await bot.consume();
      this.addLog("success", `Ate ${prettifyName(item.name)} (food now ${bot.food}/20)`);
      return;
    }
    await this.equipItem(item, "hand");
    bot.activateItem();
    await sleep(700);
    try { bot.deactivateItem(); } catch { /* ignore */ }
    this.addLog("success", `Used ${prettifyName(item.name)}`);
    this.broadcastInventory();
  }

  async tossFromSlot(slot: number, count?: number) {
    const bot = this.requireConnected();
    const item = bot.inventory.slots[slot];
    if (!item) throw new Error(`Slot ${slot} is empty`);
    const n = clamp(Math.round(count ?? item.count), 1, item.count);
    if (n >= item.count) await bot.tossStack(item);
    else await bot.toss(item.type, item.metadata ?? null, n);
    this.addLog("success", `Dropped ${n}× ${prettifyName(item.name)}`);
    this.broadcastInventory();
  }

  /** Manual remote-control pad input from the dashboard. */
  applyControl(state: ControlState) {
    const bot = this.requireConnected();
    const anyPressed = CONTROL_KEYS.some((k) => state[k] === true);
    if (anyPressed && this.activeTask) {
      this.cancelActiveTask("manual control");
      this.addLog("info", "Manual control engaged — current task stopped", "task");
    }
    if (anyPressed) {
      this.manualEngaged = true;
    } else if (CONTROL_KEYS.every((k) => state[k] !== undefined) && !anyPressed) {
      this.manualEngaged = false;
    }
    for (const key of CONTROL_KEYS) {
      if (state[key] !== undefined) bot.setControlState(key, state[key]!);
    }
    const yawDelta = state.yawDelta ?? 0;
    const pitchDelta = state.pitchDelta ?? 0;
    if (yawDelta !== 0 || pitchDelta !== 0) {
      const yaw = bot.entity.yaw + yawDelta;
      // API convention: positive pitchDelta looks down; Mineflayer pitch is positive-up.
      const pitch = clamp(bot.entity.pitch - pitchDelta, -1.55, 1.55);
      this.lookSafe(bot, yaw, pitch);
    }
    this.lastControlAt = Date.now();
    this.touchActivity();
  }

  // -------------------------------------------------------------------------
  // In-game chat commands (!help, !come, …) with an owner whitelist
  // -------------------------------------------------------------------------

  private handleChatCommand(sender: string, message: string) {
    if (!this.settings.chatCommandsEnabled) return;
    const trimmed = message.trim();
    const owners = this.settings.chatCommandOwners;
    const isOwner =
      owners.length === 0 || owners.some((o) => o.toLowerCase() === sender.toLowerCase());

    if (!trimmed.startsWith("!")) {
      // Plain chat from an owner can be routed to the AI brain (opt-in).
      if (isOwner && trimmed.length > 0) this.maybeAiChat(sender, trimmed);
      return;
    }
    if (!isOwner) return; // silently ignore non-owners

    const [rawCmd, ...args] = trimmed.split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const reply = (text: string) => this.say(text);
    const run = (promise: Promise<void>, ack?: string) => {
      if (ack) reply(ack);
      promise.catch((err) => {
        this.addLog("error", `Chat command ${cmd} failed: ${errText(err)}`, "chat");
        reply(`Sorry ${sender}, that failed: ${errText(err).slice(0, 160)}`);
      });
    };

    this.addLog("info", `[CHAT CMD] ${sender}: ${trimmed}`, "chat");

    switch (cmd) {
      case "!help":
        for (const line of CHAT_HELP_LINES) reply(line);
        break;
      case "!status": {
        const bot = this.bot;
        if (!bot) break;
        const p = bot.entity.position;
        reply(
          `HP ${Math.ceil(bot.health)}/20, food ${Math.floor(bot.food)}/20, task: ${this.activeTask?.label ?? "idle"}, pos: ${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}`,
        );
        break;
      }
      case "!inv": {
        const bot = this.bot;
        if (!bot) break;
        const items = bot.inventory.items();
        if (items.length === 0) reply("My inventory is empty");
        else {
          const top = [...items]
            .sort((a, b) => b.count - a.count)
            .slice(0, 8)
            .map((i) => `${i.count}x ${i.name}`)
            .join(", ");
          reply(`Inventory (${items.length} stacks): ${top}${items.length > 8 ? ", …" : ""}`.slice(0, 250));
        }
        break;
      }
      case "!come":
        run(this.follow(sender), `On my way, ${sender}!`);
        break;
      case "!follow":
        if (args[0]) run(this.follow(args[0]), `Following ${args[0]}`);
        else reply("Usage: !follow <player>");
        break;
      case "!stop":
        try {
          this.stop();
          reply("Stopped.");
        } catch { /* not connected */ }
        break;
      case "!goto": {
        const nums = args.map(Number).filter((n) => !Number.isNaN(n));
        if (nums.length === 3) run(this.gotoCoords(nums[0], nums[1], nums[2]), `Heading to ${nums.join(", ")}`);
        else if (nums.length === 2) run(this.gotoCoords(nums[0], undefined, nums[1]), `Heading to ${nums[0]}, ${nums[1]}`);
        else reply("Usage: !goto <x> [y] <z>");
        break;
      }
      case "!mine": {
        const resource = (args[0] ?? "").toLowerCase();
        const count = args[1] ? parseInt(args[1], 10) : undefined;
        if (RESOURCES[resource]) run(this.mine(resource, count), `Mining ${count ?? 16}x ${resource}…`);
        else reply(`Usage: !mine <${Object.keys(RESOURCES).join("|")}> [count]`);
        break;
      }
      case "!chop": {
        const type = args[0] && !/^\d+$/.test(args[0]) ? args[0].toLowerCase() : "any";
        const countArg = args.find((a) => /^\d+$/.test(a));
        run(this.chopTree(type, countArg ? parseInt(countArg, 10) : 1), `Chopping ${type} tree(s)…`);
        break;
      }
      case "!kill":
        run(this.killMobs(), "Hunting nearby mobs!");
        break;
      case "!guard":
        run(this.guard(), "Guarding this spot. !stop to stand down.");
        break;
      case "!wander":
        run(this.wander(), "Wandering off. !stop to halt.");
        break;
      case "!eat":
        run(this.eatNow());
        break;
      case "!sleep":
        run(this.sleepInBed());
        break;
      case "!drop":
        run(this.dropItems(args[0]), args[0] ? `Bringing my loot to ${args[0]}` : "Dropping loot (keeping gear & food)");
        break;
      case "!collect":
        run(this.collectItems(), "Picking up drops…");
        break;
      case "!deposit":
        run(this.depositItems(), "Storing loot in the nearest chest…");
        break;
      case "!climb": {
        const n = args[0] ? parseInt(args[0], 10) : 10;
        run(this.climb(Number.isNaN(n) ? 10 : n), "Pillaring up!");
        break;
      }
      case "!build": {
        const n = args[0] ? parseInt(args[0], 10) : 5;
        run(this.buildBase(Number.isNaN(n) ? 5 : n), "Building a shelter…");
        break;
      }
      case "!ai": {
        const goal = args.join(" ").trim();
        if (!goal) {
          reply("Tell me a goal — e.g. !ai mine 10 iron and bring it to me");
          break;
        }
        run(this.aiGoal(goal), `On it, ${sender} — working on: ${goal}`.slice(0, 200));
        break;
      }
      case "!auto": {
        const on = args[0]?.toLowerCase() !== "off";
        try {
          this.setAutopilot(on);
          reply(on ? "Autopilot ON — I'll play on my own now. !stop or !auto off stops me." : "Autopilot OFF.");
        } catch (err) {
          reply(`Can't: ${errText(err).slice(0, 160)}`);
        }
        break;
      }
      default:
        reply(`Unknown command "${cmd}". Try !help`);
        break;
    }
  }
}

function freshStats(): SessionStats {
  return {
    blocksMined: 0,
    logsChopped: 0,
    treesChopped: 0,
    mobsKilled: 0,
    itemsCollected: 0,
    deaths: 0,
    distanceWalked: 0,
    sessionStartedAt: null,
  };
}


function normalizeDimension(dim: unknown): string {
  if (typeof dim === "number") {
    return dim === -1 ? "the_nether" : dim === 1 ? "the_end" : "overworld";
  }
  if (typeof dim === "string") return dim.replace(/^minecraft:/, "");
  return "overworld";
}

function normalizeGameMode(mode: unknown): string {
  if (typeof mode === "number") {
    return ["survival", "creative", "adventure", "spectator"][mode] ?? "survival";
  }
  return typeof mode === "string" ? mode : "survival";
}

export const botManager = new BotManager();
