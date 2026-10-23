import mineflayer, { type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { WebSocketServer, type WebSocket } from "ws";
import { logger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { pathfinder, Movements, goals } = pathfinderPkg as any;

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface BotPosition {
  x: number;
  y: number;
  z: number;
}

export interface InventoryItem {
  name: string;
  count: number;
  slot: number;
  isArmor: boolean;
  isTool: boolean;
}

const ARMOR_NAMES = [
  "helmet", "chestplate", "leggings", "boots",
  "cap", "tunic", "pants"
];

const TOOL_NAMES = [
  "sword", "pickaxe", "axe", "shovel", "hoe",
  "bow", "crossbow", "trident", "shield", "flint_and_steel",
  "fishing_rod", "shears"
];

const RESOURCE_BLOCKS: Record<string, string[]> = {
  iron: ["iron_ore", "deepslate_iron_ore"],
  diamond: ["diamond_ore", "deepslate_diamond_ore"],
  gold: ["gold_ore", "deepslate_gold_ore"],
  redstone: ["redstone_ore", "deepslate_redstone_ore"],
  lapis: ["lapis_ore", "deepslate_lapis_ore"],
  stone: ["stone", "cobblestone"],
};

// Each tree type maps to its log blocks, sapling item name, and valid soil blocks for replanting
interface TreeTypeConfig {
  logs: string[];
  sapling: string;
  soil: string[];
}

const TREE_TYPES: Record<string, TreeTypeConfig> = {
  oak:      { logs: ["oak_log", "oak_wood"],           sapling: "oak_sapling",       soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  birch:    { logs: ["birch_log", "birch_wood"],        sapling: "birch_sapling",     soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  spruce:   { logs: ["spruce_log", "spruce_wood"],      sapling: "spruce_sapling",    soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  jungle:   { logs: ["jungle_log", "jungle_wood"],      sapling: "jungle_sapling",    soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  acacia:   { logs: ["acacia_log", "acacia_wood"],      sapling: "acacia_sapling",    soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  dark_oak: { logs: ["dark_oak_log", "dark_oak_wood"],  sapling: "dark_oak_sapling",  soil: ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"] },
  mangrove: { logs: ["mangrove_log", "mangrove_wood"],  sapling: "mangrove_propagule",soil: ["mud", "grass_block", "dirt", "podzol", "coarse_dirt"] },
  cherry:   { logs: ["cherry_log", "cherry_wood"],      sapling: "cherry_sapling",    soil: ["grass_block", "dirt", "podzol", "coarse_dirt"] },
};

const ALL_LOG_NAMES = Object.values(TREE_TYPES).flatMap((t) => t.logs);

// Parse the operator allowlist once at startup, not on every incoming chat
// message. Change the environment value and restart to update permissions.
const ALLOWED_CHAT_SENDERS = new Set(
  (process.env["MINEFLAYER_COMMAND_ALLOWLIST"] ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

// Detect tree type from a log block name
function detectTreeType(blockName: string): TreeTypeConfig | null {
  for (const config of Object.values(TREE_TYPES)) {
    if (config.logs.some((l) => blockName.includes(l))) return config;
  }
  return null;
}

class BotManager {
  private bot: Bot | null = null;
  private pendingBot: Bot | null = null;
  private connecting = false;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private taskGeneration = 0;
  private wss: WebSocketServer | null = null;
  private logs: LogEntry[] = [];
  private maxLogs = 500;
  private currentTask = "idle";
  private followInterval: ReturnType<typeof setInterval> | null = null;
  private miningActive = false;
  private miningLoopRunning = false;
  private miningGeneration = 0;
  private miningInterval: ReturnType<typeof setInterval> | null = null;
  private readonly authorizedSockets = new WeakSet<WebSocket>();
  private readonly rejectedChatCommandAt = new Map<string, number>();
  private lastStatusBroadcastAt = 0;
  private statusBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

  setWss(wss: WebSocketServer) {
    this.wss = wss;
  }

  authorizeWebSocket(client: WebSocket) {
    this.authorizedSockets.add(client);
  }

  unauthorizeWebSocket(client: WebSocket) {
    this.authorizedSockets.delete(client);
  }

  private addLog(level: LogLevel, message: string) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.broadcast({ type: "log", data: entry });
    logger.info({ level, message }, "Bot log");
  }

  private broadcast(payload: object) {
    if (!this.wss) return;
    const msg = JSON.stringify(payload);
    this.wss.clients.forEach((client) => {
      // Never send live telemetry to a socket until it completes the auth handshake.
      if (client.readyState === client.OPEN && this.authorizedSockets.has(client)) {
        client.send(msg);
      }
    });
  }

  private broadcastStatus() {
    // Mineflayer can emit "move" every tick. Coalesce status updates to avoid
    // turning routine movement into a high-frequency JSON/network workload.
    const elapsed = Date.now() - this.lastStatusBroadcastAt;
    if (elapsed >= 250) {
      this.lastStatusBroadcastAt = Date.now();
      this.broadcast({ type: "status", data: this.getStatus() });
      return;
    }

    if (this.statusBroadcastTimer) return;
    this.statusBroadcastTimer = setTimeout(() => {
      this.statusBroadcastTimer = null;
      this.lastStatusBroadcastAt = Date.now();
      this.broadcast({ type: "status", data: this.getStatus() });
    }, Math.max(1, 250 - elapsed));
  }

  connect(host: string, port: number, username: string, version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.bot || this.connecting) {
        reject(new Error(this.connecting ? "Bot connection is already in progress." : "Bot is already connected. Disconnect first."));
        return;
      }

      this.connecting = true;
      this.addLog("info", `Connecting to ${host}:${port} as ${username}...`);

      let bot: Bot;
      try {
        bot = mineflayer.createBot({
          host,
          port,
          username,
          version,
          hideErrors: false,
        });
      } catch (err: unknown) {
        this.connecting = false;
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.pendingBot = bot;
      try {
        bot.loadPlugin(pathfinder);
      } catch (err: unknown) {
        this.pendingBot = null;
        this.connecting = false;
        try { bot.end(); } catch { /* client may already be closed */ }
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      let spawned = false;
      let settled = false;

      const clearPendingConnection = () => {
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.connecting = false;
        if (this.pendingBot === bot) this.pendingBot = null;
      };

      const failConnection = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearPendingConnection();
        if (this.bot === bot) {
          this.cleanup();
        } else {
          this.stopAllTasks();
          this.currentTask = "idle";
          this.broadcastStatus();
        }
        reject(err instanceof Error ? err : new Error(String(err)));
        try {
          bot.end();
        } catch {
          // The client may already have closed.
        }
      };

      bot.once("spawn", () => {
        if (settled) {
          // A late spawn after timeout/cancellation must not resurrect this client.
          try { bot.end(); } catch { /* already closed */ }
          return;
        }
        spawned = true;
        settled = true;
        clearPendingConnection();
        this.bot = bot;
        this.addLog("success", `Bot spawned as ${username} on ${host}:${port}`);
        this.broadcastStatus();
        resolve();
      });

      bot.on("chat", (_username, message) => {
        this.addLog("info", `<${_username}> ${message}`);
        this.handleChatCommand(_username, message);
      });

      bot.on("health", () => this.broadcastStatus());
      bot.on("move", () => this.broadcastStatus());

      bot.on("playerJoined", (player) => {
        this.addLog("info", `Player joined: ${player.username}`);
        this.broadcastStatus();
      });

      bot.on("playerLeft", (player) => {
        this.addLog("info", `Player left: ${player.username}`);
        this.broadcastStatus();
      });

      bot.on("death", () => {
        this.addLog("warn", "Bot died!");
        this.stopAllTasks();
        this.currentTask = "idle";
        this.broadcastStatus();
      });

      bot.on("kicked", (reason) => {
        this.addLog("error", `Bot was kicked: ${reason}`);
        if (!spawned) {
          failConnection(new Error(`Bot was kicked before spawning: ${String(reason)}`));
        } else if (this.bot === bot) {
          this.cleanup();
        }
      });

      bot.on("error", (err) => {
        this.addLog("error", `Bot error: ${err.message}`);
        if (!spawned) failConnection(err);
      });

      bot.on("end", (reason) => {
        this.addLog("warn", `Bot disconnected: ${reason}`);
        if (!spawned && !settled) {
          failConnection(new Error(`Bot disconnected before spawning: ${String(reason ?? "connection ended")}`));
        } else if (this.bot === bot) {
          this.cleanup();
        }
      });

      this.connectTimeout = setTimeout(() => {
        if (!spawned && !settled) {
          failConnection(new Error("Connection timed out after 15 seconds"));
        }
      }, 15000);
    });
  }

  disconnect() {
    if (!this.bot) throw new Error("Bot is not connected");
    this.stopAllTasks();
    this.bot.end();
    this.cleanup();
    this.addLog("info", "Bot disconnected by user");
  }

  private cleanup() {
    this.stopAllTasks();
    this.bot = null;
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  private isTaskCurrent(taskId: number): boolean {
    return this.bot !== null && this.taskGeneration === taskId;
  }

  private stopAllTasks() {
    // Invalidate any async task that is waiting for pathfinding/digging/placement.
    // Each task checks this generation again after every awaited movement action.
    this.taskGeneration += 1;
    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }
    if (this.miningInterval) {
      clearInterval(this.miningInterval);
      this.miningInterval = null;
    }
    this.miningActive = false;
    this.miningGeneration += 1;
    if (this.bot) {
      // Clear lingering input (for example the jump fallback used by climb)
      // before releasing pathfinder ownership to another task.
      for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
        try { this.bot.setControlState(control, false); } catch { /* bot is closing */ }
      }
      try {
        this.bot.pathfinder.stop();
      } catch { /* no pathfinder goal is active */ }
    }
  }

  getStatus() {
    if (!this.bot) {
      return { connected: false };
    }

    const pos = this.bot.entity?.position;
    const players = Object.keys(this.bot.players).filter(
      (p) => p !== this.bot!.username
    );

    return {
      connected: true,
      username: this.bot.username,
      host: (this.bot as unknown as { _client?: { socket?: { remoteAddress?: string } } })._client?.socket?.remoteAddress,
      currentTask: this.currentTask,
      health: this.bot.health,
      food: this.bot.food,
      position: pos ? { x: Math.round(pos.x * 10) / 10, y: Math.round(pos.y * 10) / 10, z: Math.round(pos.z * 10) / 10 } : { x: 0, y: 0, z: 0 },
      players,
    };
  }

  getLogs(limit = 100): LogEntry[] {
    return this.logs.slice(-limit);
  }

  getInventory(): InventoryItem[] {
    if (!this.bot) return [];
    return this.bot.inventory.items().map((item) => {
      const name = item.name.toLowerCase();
      const isArmor = ARMOR_NAMES.some((a) => name.includes(a));
      const isTool = TOOL_NAMES.some((t) => name.includes(t));
      return {
        name: item.name,
        count: item.count,
        slot: item.slot,
        isArmor,
        isTool,
      };
    });
  }

  async follow(targetName: string) {
    if (!this.bot) throw new Error("Bot not connected");

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    let lastMissingTargetLogAt = 0;
    this.currentTask = `following ${targetName}`;
    this.addLog("info", `Following player: ${targetName}`);
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    const followLoop = () => {
      if (!this.isTaskCurrent(taskId) || this.currentTask !== `following ${targetName}`) return;
      const target = this.bot!.players[targetName]?.entity;
      if (!target) {
        const now = Date.now();
        if (now - lastMissingTargetLogAt >= 10_000) {
          lastMissingTargetLogAt = now;
          this.addLog("warn", `Player ${targetName} not found nearby`);
        }
        return;
      }
      const goal = new goals.GoalFollow(target, 2);
      this.bot.pathfinder.setGoal(goal, true);
    };

    followLoop();
    this.followInterval = setInterval(followLoop, 1000);
  }

  stop() {
    if (!this.bot) throw new Error("Bot not connected");
    this.stopAllTasks();
    this.currentTask = "idle";
    this.addLog("info", "Stopped all tasks");
    this.broadcastStatus();
  }

  async killMobs() {
    if (!this.bot) throw new Error("Bot not connected");

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.addLog("info", "Starting mob-killing routine...");
    this.currentTask = "killing mobs";
    this.broadcastStatus();

    const attackNearbyMobs = async () => {
      if (!this.isTaskCurrent(taskId)) return;

      const hostile = [
        "zombie", "skeleton", "creeper", "spider", "enderman",
        "witch", "pillager", "vindicator", "phantom", "drowned",
        "husk", "stray", "blaze", "ghast", "slime", "magma_cube",
        "zombified_piglin", "piglin_brute", "hoglin", "ravager"
      ];

      const mob = Object.values(this.bot.entities).find((e) => {
        return (
          e.type === "mob" &&
          hostile.some((h) => e.name?.toLowerCase().includes(h)) &&
          e.position.distanceTo(this.bot!.entity.position) < 16
        );
      });

      if (!mob) {
        this.addLog("info", "No hostile mobs nearby");
        return;
      }

      this.addLog("info", `Attacking ${mob.name ?? "mob"}...`);
      const mcData = require("minecraft-data")(this.bot.version);
      const movements = new Movements(this.bot);
      this.bot.pathfinder.setMovements(movements);

      try {
        await this.bot.pathfinder.goto(new goals.GoalNear(mob.position.x, mob.position.y, mob.position.z, 2));
        if (!this.isTaskCurrent(taskId)) return;
        this.bot!.attack(mob);
        this.addLog("success", `Killed ${mob.name ?? "mob"}`);
      } catch (err: unknown) {
        if (this.isTaskCurrent(taskId)) {
          this.addLog("warn", `Could not reach mob: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    await attackNearbyMobs();
    if (!this.isTaskCurrent(taskId)) return;
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async mine(resource: string) {
    if (!this.bot) throw new Error("Bot not connected");

    const blockNames = RESOURCE_BLOCKS[resource];
    if (!blockNames) throw new Error(`Unknown resource: ${resource}`);

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.miningActive = true;
    const generation = this.miningGeneration;
    this.currentTask = `mining ${resource}`;
    this.addLog("info", `Starting to mine ${resource}...`);
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    movements.digCost = 1;
    this.bot.pathfinder.setMovements(movements);

    const mineLoop = async () => {
      if (
        !this.isTaskCurrent(taskId) ||
        !this.miningActive ||
        generation !== this.miningGeneration ||
        this.miningLoopRunning
      ) return;

      // setInterval callbacks can overlap when pathfinding or digging takes
      // longer than the interval. A single guard gives this loop exclusive
      // ownership until its current async iteration has finished.
      this.miningLoopRunning = true;
      try {
        await this.checkAndKillMobs();

        // Another task may have stopped mining while the mob check yielded.
        // Re-check ownership before issuing any additional pathfinding/digging.
        if (!this.isTaskCurrent(taskId) || !this.miningActive || generation !== this.miningGeneration) return;

      const blockIds = blockNames
        .map((name) => mcData.blocksByName[name]?.id)
        .filter((id): id is number => id !== undefined);

      if (blockIds.length === 0) {
        this.addLog("warn", `No block IDs found for ${resource} in version ${this.bot.version}`);
        return;
      }

      const block = this.bot.findBlock({
        matching: blockIds,
        maxDistance: 32,
      });

      if (!block) {
        this.addLog("info", `No ${resource} found nearby, exploring...`);
        try {
          const pos = this.bot.entity.position;
          await this.bot!.pathfinder.goto(
            new goals.GoalXZ(
              Math.floor(pos.x + (Math.random() - 0.5) * 20),
              Math.floor(pos.z + (Math.random() - 0.5) * 20)
            )
          );
        } catch (_) {}
        return;
      }

      this.addLog("info", `Found ${resource} at ${block.position.x},${block.position.y},${block.position.z}`);

      try {
        await this.bot!.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1));
        // Do not let a canceled iteration dig after a replacement task has
        // taken ownership of navigation.
        if (!this.isTaskCurrent(taskId) || !this.miningActive || generation !== this.miningGeneration) return;
        await this.bot!.dig(block);
        this.addLog("success", `Mined ${resource}!`);
      } catch (err: unknown) {
        this.addLog("warn", `Mining failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      } finally {
        this.miningLoopRunning = false;
      }
    };

    this.miningInterval = setInterval(() => {
      mineLoop().catch((e) => this.addLog("error", `Mine loop error: ${e instanceof Error ? e.message : String(e)}`));
    }, 2000);

    await mineLoop();
  }

  private async checkAndKillMobs() {
    if (!this.bot) return;

    const hostile = [
      "zombie", "skeleton", "creeper", "spider", "enderman",
      "witch", "pillager", "drowned", "husk", "stray",
    ];

    const mob = Object.values(this.bot.entities).find((e) => {
      return (
        e.type === "mob" &&
        hostile.some((h) => e.name?.toLowerCase().includes(h)) &&
        e.position.distanceTo(this.bot!.entity.position) < 8
      );
    });

    if (mob) {
      this.addLog("warn", `Mob nearby (${mob.name ?? "unknown"})! Attacking...`);
      try {
        this.bot.attack(mob);
      } catch (_) {}
    }
  }

  async dropItems(targetName?: string) {
    if (!this.bot) throw new Error("Bot not connected");

    const items = this.getInventory().filter((item) => !item.isArmor && !item.isTool);

    if (items.length === 0) {
      this.addLog("info", "Nothing to drop");
      return;
    }

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.currentTask = "dropping items";
    this.addLog("info", "Dropping non-essential items...");
    this.broadcastStatus();

    if (targetName) {
      const target = this.bot.players[targetName]?.entity;
      if (target) {
        const mcData = require("minecraft-data")(this.bot.version);
        const movements = new Movements(this.bot);
        this.bot.pathfinder.setMovements(movements);
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
        } catch (_) {
          if (!this.isTaskCurrent(taskId)) return;
        }
        if (!this.isTaskCurrent(taskId)) return;
      }
    }

    for (const item of items) {
      if (!this.isTaskCurrent(taskId)) return;
      const invItem = this.bot!.inventory.items().find((i) => i.slot === item.slot);
      if (invItem) {
        try {
          await this.bot!.toss(invItem.type, null, invItem.count);
          if (!this.isTaskCurrent(taskId)) return;
          this.addLog("success", `Dropped ${invItem.count}x ${invItem.name}`);
        } catch (err: unknown) {
          this.addLog("warn", `Failed to drop ${invItem.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (!this.isTaskCurrent(taskId)) return;
    this.addLog("success", `Finished dropping ${items.length} item type(s)`);
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async buildBase() {
    if (!this.bot) throw new Error("Bot not connected");

    const cobblestone = this.bot.inventory.items().find(
      (item) => item.name.toLowerCase().includes("cobblestone") || item.name.toLowerCase().includes("stone")
    );

    if (!cobblestone) {
      this.addLog("error", "No stone/cobblestone in inventory to build with");
      return;
    }

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.currentTask = "building base";
    this.addLog("info", "Building 10x10 base...");
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot!.version);
    const origin = this.bot.entity.position.floored();

    this.addLog("info", `Building at ${origin.x}, ${origin.y}, ${origin.z}`);

    let placed = 0;
    const size = 10;

    for (let x = 0; x < size && this.isTaskCurrent(taskId); x++) {
      for (let z = 0; z < size && this.isTaskCurrent(taskId); z++) {
        if (x !== 0 && x !== size - 1 && z !== 0 && z !== size - 1) continue;

        const targetPos = origin.offset(x, -1, z);
        const block = this.bot.blockAt(targetPos);

        if (!block || block.type === 0) {
          try {
            const refBlock = this.bot.blockAt(targetPos.offset(0, 1, 0));
            if (refBlock) {
              if (!this.isTaskCurrent(taskId)) return;
              await this.bot!.placeBlock(refBlock, { x: 0, y: -1, z: 0 } as never);
              placed++;
              if (placed % 5 === 0) this.addLog("info", `Placed ${placed} blocks...`);
            }
          } catch (_) {}
        }
      }
    }

    if (!this.isTaskCurrent(taskId)) return;
    this.addLog("success", `Base outline built (${placed} blocks placed)`);
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async climb() {
    if (!this.bot) throw new Error("Bot not connected");

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.addLog("info", "Climbing upward...");
    this.currentTask = "climbing";
    this.broadcastStatus();

    const targetY = this.bot.entity.position.y + 10;
    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    movements.allowParkour = true;
    movements.allowSprinting = true;
    this.bot.pathfinder.setMovements(movements);

    try {
      const pos = this.bot.entity.position;
      await this.bot.pathfinder.goto(
        new goals.GoalBlock(Math.floor(pos.x), Math.floor(targetY), Math.floor(pos.z))
      );
      if (!this.isTaskCurrent(taskId)) return;
      this.addLog("success", `Climbed to Y=${Math.floor(targetY)}`);
    } catch (err: unknown) {
      if (!this.isTaskCurrent(taskId)) return;
      this.addLog("warn", `Climb encountered obstacle: ${err instanceof Error ? err.message : String(err)}`);
      this.bot!.setControlState("jump", true);
      setTimeout(() => {
        if (this.isTaskCurrent(taskId)) this.bot!.setControlState("jump", false);
      }, 2000);
    }

    if (!this.isTaskCurrent(taskId)) return;
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async hit(targetName: string) {
    if (!this.bot) throw new Error("Bot not connected");

    this.addLog("info", `Looking for target: ${targetName}`);

    const entity = Object.values(this.bot.entities).find(
      (e) =>
        (e.username === targetName || e.name === targetName) &&
        e.position.distanceTo(this.bot!.entity.position) < 32
    );

    if (!entity) {
      throw new Error(`Target "${targetName}" not found nearby`);
    }

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.currentTask = `hitting ${targetName}`;
    this.broadcastStatus();

    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)
      );
      if (!this.isTaskCurrent(taskId)) return;
      this.bot!.attack(entity);
      this.addLog("success", `Hit ${targetName}`);
    } catch (err: unknown) {
      if (!this.isTaskCurrent(taskId)) return;
      throw new Error(`Could not reach ${targetName}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.isTaskCurrent(taskId)) {
        this.currentTask = "idle";
        this.broadcastStatus();
      }
    }
  }

  async pullLever() {
    if (!this.bot) throw new Error("Bot not connected");

    this.addLog("info", "Looking for lever or button...");

    const mcData = require("minecraft-data")(this.bot.version);
    const leverIds = [
      mcData.blocksByName["lever"]?.id,
      mcData.blocksByName["stone_button"]?.id,
      mcData.blocksByName["oak_button"]?.id,
    ].filter((id): id is number => id !== undefined);

    const block = this.bot.findBlock({
      matching: leverIds,
      maxDistance: 16,
    });

    if (!block) {
      throw new Error("No lever or button found within 16 blocks");
    }

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.currentTask = "activating lever/button";
    this.broadcastStatus();

    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
      if (!this.isTaskCurrent(taskId)) return;
      const currentBlock = this.bot!.blockAt(block.position);
      if (!currentBlock || currentBlock.type !== block.type) {
        throw new Error("The lever or button is no longer present");
      }
      await this.bot!.activateBlock(currentBlock);
      if (!this.isTaskCurrent(taskId)) return;
      this.addLog("success", `Activated lever/button at ${block.position.x},${block.position.y},${block.position.z}`);
    } catch (err: unknown) {
      if (!this.isTaskCurrent(taskId)) return;
      throw new Error(`Could not activate lever/button: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.isTaskCurrent(taskId)) {
        this.currentTask = "idle";
        this.broadcastStatus();
      }
    }
  }

  async hitPlayer(playerName: string) {
    return this.hit(playerName);
  }

  /**
   * Called once from index.ts after the server starts — no-op here but kept for
   * future server-side setup that needs to run outside a bot lifecycle.
   */
  registerChatCommands() {
    // Chat commands are registered per-connection inside connect() via handleChatCommand.
    logger.info("Chat command handler registered (!chop, !stop, !follow, !kill, !mine, !drop, !climb)");
  }

  /**
   * Parse and dispatch in-game chat commands sent by any player.
   * Commands: !chop [type], !stop, !follow <name>, !kill, !mine <resource>, !drop, !climb
   */
  private handleChatCommand(sender: string, message: string) {
    if (!message.startsWith("!")) return;

    // Chat commands are disabled unless explicitly enabled by a server-side
    // allowlist. Values can be exact Minecraft usernames or UUIDs, separated
    // by commas in MINEFLAYER_COMMAND_ALLOWLIST.
    const senderKey = sender.toLowerCase();
    const senderUuid = this.bot?.players[sender]?.uuid?.toLowerCase();
    const authorized = ALLOWED_CHAT_SENDERS.size > 0 &&
      (ALLOWED_CHAT_SENDERS.has(senderKey) ||
        (typeof senderUuid === "string" && ALLOWED_CHAT_SENDERS.has(senderUuid)));

    if (!authorized) {
      // Bound and rate-limit rejected-command logging so public chat cannot
      // create unbounded memory growth or flood the logs.
      const now = Date.now();
      const lastLoggedAt = this.rejectedChatCommandAt.get(senderKey) ?? 0;
      if (now - lastLoggedAt >= 30_000) {
        if (!this.rejectedChatCommandAt.has(senderKey) && this.rejectedChatCommandAt.size >= 100) {
          const oldestKey = this.rejectedChatCommandAt.keys().next().value;
          if (oldestKey !== undefined) this.rejectedChatCommandAt.delete(oldestKey);
        }
        this.rejectedChatCommandAt.set(senderKey, now);
        this.addLog("warn", `Ignored command from unauthorised player "${sender}"`);
      }
      return;
    }

    const [cmd, ...args] = message.trim().split(/\s+/);

    switch (cmd.toLowerCase()) {
      case "!chop":
        this.addLog("info", `[CHAT CMD] ${sender}: chop tree (${args[0] ?? "any"})`);
        this.chopTree(args[0] ?? "any").catch((e) =>
          this.addLog("error", `chopTree failed: ${e.message}`)
        );
        break;

      case "!stop":
        this.addLog("info", `[CHAT CMD] ${sender}: stop`);
        try { this.stop(); } catch (_) {}
        break;

      case "!follow":
        if (args[0]) {
          this.addLog("info", `[CHAT CMD] ${sender}: follow ${args[0]}`);
          this.follow(args[0]).catch((e) =>
            this.addLog("error", `follow failed: ${e.message}`)
          );
        }
        break;

      case "!kill":
        this.addLog("info", `[CHAT CMD] ${sender}: kill mobs`);
        this.killMobs().catch((e) =>
          this.addLog("error", `killMobs failed: ${e.message}`)
        );
        break;

      case "!mine":
        if (args[0]) {
          this.addLog("info", `[CHAT CMD] ${sender}: mine ${args[0]}`);
          this.mine(args[0]).catch((e) =>
            this.addLog("error", `mine failed: ${e.message}`)
          );
        }
        break;

      case "!drop":
        this.addLog("info", `[CHAT CMD] ${sender}: drop items`);
        this.dropItems(args[0]).catch((e) =>
          this.addLog("error", `dropItems failed: ${e.message}`)
        );
        break;

      case "!climb":
        this.addLog("info", `[CHAT CMD] ${sender}: climb`);
        this.climb().catch((e) =>
          this.addLog("error", `climb failed: ${e.message}`)
        );
        break;

      default:
        break;
    }
  }

  /**
   * Chop a tree: locate nearest matching tree, flood-fill all connected logs,
   * mine them while watching for mobs, collect saplings, then replant.
   * Also responds to the in-game chat command "!chop [treeType]".
   */
  async chopTree(treeType = "any") {
    if (!this.bot) throw new Error("Bot not connected");
    if (treeType !== "any" && !TREE_TYPES[treeType]) {
      throw new Error(`Unknown tree type: ${treeType}. Valid: ${Object.keys(TREE_TYPES).join(", ")}, any`);
    }

    this.stopAllTasks();
    const taskId = this.taskGeneration;
    this.currentTask = `chopping ${treeType === "any" ? "nearest" : treeType} tree`;
    this.addLog("info", `Starting tree chop (type: ${treeType})...`);
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot.version);

    // ── 1. Resolve the log block IDs to search for ─────────────────────────
    let searchLogNames: string[];
    if (treeType === "any") {
      searchLogNames = ALL_LOG_NAMES;
    } else {
      const cfg = TREE_TYPES[treeType];
      if (!cfg) throw new Error(`Unknown tree type: ${treeType}. Valid: ${Object.keys(TREE_TYPES).join(", ")}, any`);
      searchLogNames = cfg.logs;
    }

    const searchLogIds: number[] = searchLogNames
      .map((n) => mcData.blocksByName[n]?.id)
      .filter((id): id is number => id !== undefined);

    if (searchLogIds.length === 0) {
      this.addLog("warn", `No log block IDs found for ${treeType} in MC ${this.bot.version}`);
      this.currentTask = "idle";
      this.broadcastStatus();
      return;
    }

    // ── 2. Equip axe if available ────────────────────────────────────────────
    await this.equipBestAxe();
    if (!this.isTaskCurrent(taskId)) return;

    // ── 3. Find the nearest log block ────────────────────────────────────────
    const firstLog = this.bot!.findBlock({ matching: searchLogIds, maxDistance: 64 });
    if (!firstLog) {
      this.addLog("warn", `No ${treeType === "any" ? "" : treeType + " "}tree found within 64 blocks`);
      this.currentTask = "idle";
      this.broadcastStatus();
      return;
    }

    this.addLog("info", `Found ${firstLog.name} at ${firstLog.position.x},${firstLog.position.y},${firstLog.position.z}`);

    // ── 4. Identify the sapling/soil config for THIS tree ───────────────────
    const treeConfig = detectTreeType(firstLog.name) ?? TREE_TYPES["oak"];

    // ── 5. Flood-fill all connected log blocks (BFS, max 200 blocks) ────────
    const allLogIds = new Set(searchLogIds);
    const visited = new Set<string>();
    const queue: Array<{ x: number; y: number; z: number }> = [firstLog.position];
    const logBlocks: Array<{ x: number; y: number; z: number }> = [];

    while (queue.length > 0 && logBlocks.length < 200) {
      const pos = queue.shift()!;
      const key = `${pos.x},${pos.y},${pos.z}`;
      if (visited.has(key)) continue;
      visited.add(key);

      const block = this.bot.blockAt(pos as never);
      if (!block || !allLogIds.has(block.type)) continue;

      logBlocks.push(pos);

      // Check all 6 adjacent faces plus diagonals on same Y for branch detection
      const neighbors = [
        { x: pos.x + 1, y: pos.y, z: pos.z },
        { x: pos.x - 1, y: pos.y, z: pos.z },
        { x: pos.x, y: pos.y, z: pos.z + 1 },
        { x: pos.x, y: pos.y, z: pos.z - 1 },
        { x: pos.x, y: pos.y + 1, z: pos.z },
        { x: pos.x, y: pos.y - 1, z: pos.z },
        // diagonal neighbors on same Y to handle branching acacia/dark oak
        { x: pos.x + 1, y: pos.y + 1, z: pos.z },
        { x: pos.x - 1, y: pos.y + 1, z: pos.z },
        { x: pos.x, y: pos.y + 1, z: pos.z + 1 },
        { x: pos.x, y: pos.y + 1, z: pos.z - 1 },
      ];
      for (const n of neighbors) {
        const nKey = `${n.x},${n.y},${n.z}`;
        if (!visited.has(nKey)) queue.push(n);
      }
    }

    this.addLog("info", `Found ${logBlocks.length} log blocks in tree`);

    // ── 6. Record stump positions for replanting ─────────────────────────────
    // Lowest log Y for each XZ column = future sapling positions
    const columnLowest: Map<string, { x: number; y: number; z: number }> = new Map();
    for (const pos of logBlocks) {
      const colKey = `${pos.x},${pos.z}`;
      const existing = columnLowest.get(colKey);
      if (!existing || pos.y < existing.y) {
        columnLowest.set(colKey, pos);
      }
    }

    // ── 7. Set up pathfinder movements ──────────────────────────────────────
    const movements = new Movements(this.bot);
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.canDig = true;
    this.bot.pathfinder.setMovements(movements);

    // ── 8. Mine logs from bottom to top ─────────────────────────────────────
    const sorted = logBlocks.sort((a, b) => a.y - b.y);
    let chopped = 0;

    for (const pos of sorted) {
      if (!this.isTaskCurrent(taskId)) return;

      // Kill mobs before each chop pass
      await this.checkAndKillMobs();
      if (!this.isTaskCurrent(taskId)) return;

      const block = this.bot!.blockAt(pos as never);
      if (!block || !allLogIds.has(block.type)) continue; // already gone (leaf decay etc)

      try {
        // Navigate within reach (4 blocks)
        await this.bot!.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
        if (!this.isTaskCurrent(taskId)) return;
        await this.bot!.dig(block);
        if (!this.isTaskCurrent(taskId)) return;
        chopped++;
        if (chopped % 5 === 0) this.addLog("info", `Chopped ${chopped}/${sorted.length} logs...`);
      } catch (err: unknown) {
        if (!this.isTaskCurrent(taskId)) return;
        // Log is already broken or unreachable — skip
        this.addLog("warn", `Skipped log at ${pos.x},${pos.y},${pos.z}: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Small delay to let items land
      await new Promise((r) => setTimeout(r, 150));
      if (!this.isTaskCurrent(taskId)) return;
    }

    if (!this.isTaskCurrent(taskId)) return;
    this.addLog("success", `Chopped ${chopped} log(s)`);

    // ── 9. Wait briefly for item drops to be collected ──────────────────────
    await new Promise((r) => setTimeout(r, 1200));
    if (!this.isTaskCurrent(taskId)) return;

    // ── 10. Count saplings in inventory ─────────────────────────────────────
    const saplingItem = this.bot!.inventory.items().find((i) =>
      i.name.toLowerCase().includes(treeConfig.sapling)
    );
    const saplingCount = saplingItem?.count ?? 0;
    this.addLog("info", `Saplings in inventory: ${saplingCount}x ${treeConfig.sapling}`);

    // ── 11. Replant saplings ─────────────────────────────────────────────────
    if (saplingCount > 0) {
      await this.replantSaplings(columnLowest, treeConfig, mcData, saplingCount, taskId);
      if (!this.isTaskCurrent(taskId)) return;
    } else {
      this.addLog("warn", "No saplings found in inventory — skipping replant");
    }

    // ── 12. Report back ──────────────────────────────────────────────────────
    if (!this.isTaskCurrent(taskId)) return;
    const replanted = Math.min(saplingCount, columnLowest.size);
    this.addLog("success", `Tree chop complete: ${chopped} logs, ${replanted} sapling(s) replanted`);
    this.bot!.chat(`[MineControl] Chopped ${chopped} ${treeType === "any" ? "" : treeType + " "}logs, replanted ${replanted} sapling(s)`);

    this.currentTask = "idle";
    this.broadcastStatus();
  }

  /**
   * Place saplings at stump positions where suitable soil exists below.
   */
  private async replantSaplings(
    positions: Map<string, { x: number; y: number; z: number }>,
    config: TreeTypeConfig,
    mcData: ReturnType<typeof require>,
    maxCount: number,
    taskId: number
  ) {
    if (!this.isTaskCurrent(taskId)) return;

    const soilIds = new Set<number>(
      config.soil
        .map((s) => mcData.blocksByName[s]?.id)
        .filter((id): id is number => id !== undefined)
    );

    let placed = 0;

    for (const stump of positions.values()) {
      if (placed >= maxCount) break;
      if (!this.isTaskCurrent(taskId)) return;

      // The stump.y is where the lowest log was — saplings go on the block below it
      const soilPos = { x: stump.x, y: stump.y - 1, z: stump.z };
      const soilBlock = this.bot.blockAt(soilPos as never);
      if (!soilBlock || !soilIds.has(soilBlock.type)) {
        this.addLog("warn", `Skipping replant at ${stump.x},${stump.y},${stump.z}: not suitable soil (${soilBlock?.name ?? "air"})`);
        continue;
      }

      // The space at stump.y must be air
      const airBlock = this.bot.blockAt(stump as never);
      if (!airBlock || airBlock.type !== 0) {
        this.addLog("warn", `Skipping replant at ${stump.x},${stump.y},${stump.z}: space not clear`);
        continue;
      }

      // Navigate close to the soil block
      try {
        await this.bot!.pathfinder.goto(new goals.GoalNear(stump.x, stump.y, stump.z, 2));
      } catch (_) {
        if (!this.isTaskCurrent(taskId)) return;
      }
      if (!this.isTaskCurrent(taskId)) return;

      // Equip sapling
      const saplingInv = this.bot.inventory.items().find((i) =>
        i.name.toLowerCase().includes(config.sapling)
      );
      if (!saplingInv) break;

      try {
        await this.bot!.equip(saplingInv, "hand");
        if (!this.isTaskCurrent(taskId)) return;
        await this.bot!.placeBlock(soilBlock, { x: 0, y: 1, z: 0 } as never);
        if (!this.isTaskCurrent(taskId)) return;
        placed++;
        this.addLog("success", `Replanted ${config.sapling} at ${stump.x},${stump.y},${stump.z}`);
      } catch (err: unknown) {
        this.addLog("warn", `Failed to replant at ${stump.x},${stump.y},${stump.z}: ${err instanceof Error ? err.message : String(err)}`);
      }

      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /**
   * Equip the best available axe from inventory (diamond > iron > stone > wood).
   */
  private async equipBestAxe() {
    if (!this.bot) return;
    const priority = ["diamond_axe", "iron_axe", "stone_axe", "golden_axe", "wooden_axe"];
    for (const axeName of priority) {
      const axe = this.bot.inventory.items().find((i) => i.name === axeName);
      if (axe) {
        try {
          await this.bot.equip(axe, "hand");
          this.addLog("info", `Equipped ${axeName}`);
          return;
        } catch (_) {}
      }
    }
  }
}

export const botManager = new BotManager();
