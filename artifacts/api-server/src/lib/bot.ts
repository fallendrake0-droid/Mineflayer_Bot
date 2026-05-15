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

class BotManager {
  private bot: Bot | null = null;
  private wss: WebSocketServer | null = null;
  private logs: LogEntry[] = [];
  private maxLogs = 500;
  private currentTask = "idle";
  private followInterval: ReturnType<typeof setInterval> | null = null;
  private miningActive = false;
  private miningInterval: ReturnType<typeof setInterval> | null = null;

  setWss(wss: WebSocketServer) {
    this.wss = wss;
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
      if (client.readyState === client.OPEN) {
        client.send(msg);
      }
    });
  }

  private broadcastStatus() {
    this.broadcast({ type: "status", data: this.getStatus() });
  }

  connect(host: string, port: number, username: string, version: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.bot) {
        reject(new Error("Bot is already connected. Disconnect first."));
        return;
      }

      this.addLog("info", `Connecting to ${host}:${port} as ${username}...`);

      const bot = mineflayer.createBot({
        host,
        port,
        username,
        version,
        hideErrors: false,
      });

      bot.loadPlugin(pathfinder);

      let spawned = false;

      bot.once("spawn", () => {
        spawned = true;
        this.bot = bot;
        this.addLog("success", `Bot spawned as ${username} on ${host}:${port}`);
        this.broadcastStatus();
        resolve();
      });

      bot.on("chat", (_username, message) => {
        this.addLog("info", `<${_username}> ${message}`);
      });

      bot.on("health", () => {
        this.broadcastStatus();
      });

      bot.on("move", () => {
        this.broadcastStatus();
      });

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
        this.broadcastStatus();
      });

      bot.on("kicked", (reason) => {
        this.addLog("error", `Bot was kicked: ${reason}`);
        this.cleanup();
      });

      bot.on("error", (err) => {
        this.addLog("error", `Bot error: ${err.message}`);
        if (!spawned) {
          this.cleanup();
          reject(err);
        }
      });

      bot.on("end", (reason) => {
        this.addLog("warn", `Bot disconnected: ${reason}`);
        this.cleanup();
      });

      setTimeout(() => {
        if (!spawned) {
          bot.end();
          reject(new Error("Connection timed out after 15 seconds"));
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

  private stopAllTasks() {
    if (this.followInterval) {
      clearInterval(this.followInterval);
      this.followInterval = null;
    }
    if (this.miningInterval) {
      clearInterval(this.miningInterval);
      this.miningInterval = null;
    }
    this.miningActive = false;
    if (this.bot) {
      try {
        this.bot.pathfinder.stop();
      } catch (_) {}
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
    this.currentTask = `following ${targetName}`;
    this.addLog("info", `Following player: ${targetName}`);
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    const followLoop = () => {
      if (!this.bot || this.currentTask !== `following ${targetName}`) return;
      const target = this.bot.players[targetName]?.entity;
      if (!target) {
        this.addLog("warn", `Player ${targetName} not found nearby`);
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

    this.addLog("info", "Starting mob-killing routine...");
    this.currentTask = "killing mobs";
    this.broadcastStatus();

    const attackNearbyMobs = async () => {
      if (!this.bot) return;

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
        this.bot.attack(mob);
        this.addLog("success", `Killed ${mob.name ?? "mob"}`);
      } catch (err: unknown) {
        this.addLog("warn", `Could not reach mob: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    await attackNearbyMobs();
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async mine(resource: string) {
    if (!this.bot) throw new Error("Bot not connected");

    const blockNames = RESOURCE_BLOCKS[resource];
    if (!blockNames) throw new Error(`Unknown resource: ${resource}`);

    this.stopAllTasks();
    this.miningActive = true;
    this.currentTask = `mining ${resource}`;
    this.addLog("info", `Starting to mine ${resource}...`);
    this.broadcastStatus();

    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    movements.digCost = 1;
    this.bot.pathfinder.setMovements(movements);

    const mineLoop = async () => {
      if (!this.bot || !this.miningActive) return;

      await this.checkAndKillMobs();

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
          await this.bot.pathfinder.goto(
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
        await this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1));
        await this.bot.dig(block);
        this.addLog("success", `Mined ${resource}!`);
      } catch (err: unknown) {
        this.addLog("warn", `Mining failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    this.miningInterval = setInterval(() => {
      mineLoop().catch((e) => this.addLog("error", `Mine loop error: ${e.message}`));
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

    this.addLog("info", "Dropping non-essential items...");

    const items = this.getInventory().filter((item) => !item.isArmor && !item.isTool);

    if (items.length === 0) {
      this.addLog("info", "Nothing to drop");
      return;
    }

    if (targetName) {
      const target = this.bot.players[targetName]?.entity;
      if (target) {
        const mcData = require("minecraft-data")(this.bot.version);
        const movements = new Movements(this.bot);
        this.bot.pathfinder.setMovements(movements);
        try {
          await this.bot.pathfinder.goto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
        } catch (_) {}
      }
    }

    for (const item of items) {
      const invItem = this.bot.inventory.items().find((i) => i.slot === item.slot);
      if (invItem) {
        try {
          await this.bot.toss(invItem.type, null, invItem.count);
          this.addLog("success", `Dropped ${invItem.count}x ${invItem.name}`);
        } catch (err: unknown) {
          this.addLog("warn", `Failed to drop ${invItem.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    this.addLog("success", `Finished dropping ${items.length} item type(s)`);
  }

  async buildBase() {
    if (!this.bot) throw new Error("Bot not connected");

    this.addLog("info", "Building 10x10 base...");
    this.currentTask = "building base";
    this.broadcastStatus();

    const cobblestone = this.bot.inventory.items().find(
      (item) => item.name.toLowerCase().includes("cobblestone") || item.name.toLowerCase().includes("stone")
    );

    if (!cobblestone) {
      this.addLog("error", "No stone/cobblestone in inventory to build with");
      this.currentTask = "idle";
      this.broadcastStatus();
      return;
    }

    const mcData = require("minecraft-data")(this.bot.version);
    const origin = this.bot.entity.position.floored();

    this.addLog("info", `Building at ${origin.x}, ${origin.y}, ${origin.z}`);

    let placed = 0;
    const size = 10;

    for (let x = 0; x < size; x++) {
      for (let z = 0; z < size; z++) {
        if (!this.bot) break;
        if (x !== 0 && x !== size - 1 && z !== 0 && z !== size - 1) continue;

        const targetPos = origin.offset(x, -1, z);
        const block = this.bot.blockAt(targetPos);

        if (!block || block.type === 0) {
          try {
            const refBlock = this.bot.blockAt(targetPos.offset(0, 1, 0));
            if (refBlock) {
              await this.bot.placeBlock(refBlock, { x: 0, y: -1, z: 0 } as never);
              placed++;
              if (placed % 5 === 0) this.addLog("info", `Placed ${placed} blocks...`);
            }
          } catch (_) {}
        }
      }
    }

    this.addLog("success", `Base outline built (${placed} blocks placed)`);
    this.currentTask = "idle";
    this.broadcastStatus();
  }

  async climb() {
    if (!this.bot) throw new Error("Bot not connected");

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
      this.addLog("success", `Climbed to Y=${Math.floor(targetY)}`);
    } catch (err: unknown) {
      this.addLog("warn", `Climb encountered obstacle: ${err instanceof Error ? err.message : String(err)}`);
      this.bot.setControlState("jump", true);
      setTimeout(() => {
        if (this.bot) this.bot.setControlState("jump", false);
      }, 2000);
    }

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

    const mcData = require("minecraft-data")(this.bot.version);
    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(
        new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 2)
      );
      this.bot.attack(entity);
      this.addLog("success", `Hit ${targetName}`);
    } catch (err: unknown) {
      throw new Error(`Could not reach ${targetName}: ${err instanceof Error ? err.message : String(err)}`);
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

    const movements = new Movements(this.bot);
    this.bot.pathfinder.setMovements(movements);

    try {
      await this.bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
      await this.bot.activateBlock(block);
      this.addLog("success", `Pulled lever/button at ${block.position.x},${block.position.y},${block.position.z}`);
    } catch (err: unknown) {
      throw new Error(`Could not pull lever: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async hitPlayer(playerName: string) {
    return this.hit(playerName);
  }
}

export const botManager = new BotManager();
