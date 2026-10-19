import { Router, type Response } from "express";
import { botManager } from "../lib/bot";
import {
  ConnectBotBody,
  ExecuteBotCommandBody,
  SendBotControlBody,
  UpdateBotSettingsBody,
  GetBotLogsQueryParams,
  AiGoalBody,
  SetAiAutopilotBody,
  UpdateAiConfigBody,
} from "@workspace/api-zod";

const router = Router();

function badRequest(res: Response, err: unknown) {
  res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start a long-running bot task without blocking the HTTP request.
 * Quick validation failures (unknown player, no bed nearby, bad resource…)
 * reject within a few ms — race briefly so those still surface as HTTP 400s
 * with a useful message instead of a misleading "started".
 */
async function startLongTask(task: Promise<void>): Promise<void> {
  const outcome = await Promise.race([
    task.then(
      () => "done" as const,
      (err: unknown) => ({ err }),
    ),
    delay(75).then(() => "started" as const),
  ]);
  if (typeof outcome === "object" && outcome !== null && "err" in outcome) {
    throw outcome.err;
  }
}

router.post("/bot/connect", async (req, res) => {
  const parse = ConnectBotBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }

  const { host, port = 25565, username, version = "auto", owner } = parse.data;

  try {
    // The connecting user becomes a whitelisted chat-command owner.
    if (owner && owner.trim()) {
      const current = botManager.getSettings();
      if (!current.chatCommandOwners.some((o) => o.toLowerCase() === owner.trim().toLowerCase())) {
        botManager.updateSettings({
          chatCommandOwners: [...current.chatCommandOwners, owner.trim()],
        });
      }
    }
    await botManager.connect({ host, port, username, version: version || "auto" });
    res.json(botManager.getStatus());
  } catch (err) {
    badRequest(res, err);
  }
});

router.post("/bot/disconnect", (_req, res) => {
  try {
    botManager.disconnect();
    res.json(botManager.getStatus());
  } catch (err) {
    badRequest(res, err);
  }
});

router.get("/bot/status", (_req, res) => {
  res.json(botManager.getStatus());
});

router.post("/bot/command", async (req, res) => {
  const parse = ExecuteBotCommandBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }

  const { command, target, resource, treeType, x, y, z, message, slot, count, size } = parse.data;

  const requireField = (value: unknown, name: string): boolean => {
    if (value === undefined || value === null || value === "") {
      res.status(400).json({ error: `'${name}' is required for the '${command}' command` });
      return false;
    }
    return true;
  };

  try {
    switch (command) {
      // -- one-shot actions (awaited, errors returned immediately) -----------
      case "stop":
        botManager.stop();
        break;

      case "eat":
        await botManager.eatNow();
        break;

      case "chat":
        if (!requireField(message, "message")) return;
        botManager.sendChat(message!);
        break;

      case "equipItem":
        if (!requireField(slot, "slot")) return;
        await botManager.equipFromSlot(slot!);
        break;

      case "useItem":
        if (!requireField(slot, "slot")) return;
        await botManager.useFromSlot(slot!);
        break;

      case "tossItem":
        if (!requireField(slot, "slot")) return;
        await botManager.tossFromSlot(slot!, count);
        break;

      // -- long-running tasks (started, progress via logs/websocket) --------
      case "follow":
        if (!requireField(target, "target")) return;
        await startLongTask(botManager.follow(target!));
        break;

      case "goto":
        if (!requireField(x, "x") || !requireField(z, "z")) return;
        await startLongTask(botManager.gotoCoords(x!, y, z!));
        break;

      case "killMobs":
        await startLongTask(botManager.killMobs());
        break;

      case "guard":
        await startLongTask(botManager.guard());
        break;

      case "wander":
        await startLongTask(botManager.wander());
        break;

      case "mine":
        if (!requireField(resource, "resource")) return;
        await startLongTask(botManager.mine(resource!, count));
        break;

      case "chopTree":
        await startLongTask(botManager.chopTree(treeType ?? "any", count ?? 1));
        break;

      case "buildBase":
        await startLongTask(botManager.buildBase(size));
        break;

      case "climb":
        await startLongTask(botManager.climb(count));
        break;

      case "hit":
        if (!requireField(target, "target")) return;
        await startLongTask(botManager.attackOnce(target!, false));
        break;

      case "hitPlayer":
        if (!requireField(target, "target")) return;
        await startLongTask(botManager.attackOnce(target!, true));
        break;

      case "pullLever":
        await startLongTask(botManager.pullLever());
        break;

      case "sleep":
        await startLongTask(botManager.sleepInBed());
        break;

      case "collectItems":
        await startLongTask(botManager.collectItems());
        break;

      case "dropItems":
        await startLongTask(botManager.dropItems(target || undefined));
        break;

      case "depositItems":
        await startLongTask(botManager.depositItems());
        break;

      default:
        res.status(400).json({ error: `Unknown command: ${command}` });
        return;
    }

    res.json({ success: true, message: `Command '${command}' started` });
  } catch (err) {
    badRequest(res, err);
  }
});

router.post("/bot/control", (req, res) => {
  const parse = SendBotControlBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  try {
    botManager.applyControl(parse.data);
    res.json({ success: true, message: "Controls applied" });
  } catch (err) {
    badRequest(res, err);
  }
});

router.get("/bot/settings", (_req, res) => {
  res.json(botManager.getSettings());
});

router.put("/bot/settings", (req, res) => {
  const parse = UpdateBotSettingsBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  try {
    res.json(botManager.updateSettings(parse.data));
  } catch (err) {
    badRequest(res, err);
  }
});

router.get("/bot/logs", (req, res) => {
  const parse = GetBotLogsQueryParams.safeParse(req.query);
  const limit = parse.success ? (parse.data.limit ?? 100) : 100;
  res.json({ logs: botManager.getLogs(limit) });
});

router.delete("/bot/logs", (_req, res) => {
  botManager.clearLogs();
  res.json({ success: true, message: "Logs cleared" });
});

router.get("/bot/inventory", (_req, res) => {
  res.json(botManager.getInventoryResponse());
});

// ---------------------------------------------------------------------------
// AI brain
// ---------------------------------------------------------------------------

router.post("/bot/ai/goal", async (req, res) => {
  const parse = AiGoalBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  try {
    await startLongTask(botManager.aiGoal(parse.data.goal));
    res.json({ success: true, message: "AI goal started" });
  } catch (err) {
    badRequest(res, err);
  }
});

router.post("/bot/ai/stop", (_req, res) => {
  botManager.aiStop();
  res.json({ success: true, message: "AI stopped" });
});

router.post("/bot/ai/autopilot", (req, res) => {
  const parse = SetAiAutopilotBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  try {
    botManager.setAutopilot(parse.data.enabled);
    res.json(botManager.getAiStatus());
  } catch (err) {
    badRequest(res, err);
  }
});

router.get("/bot/ai/status", (_req, res) => {
  res.json(botManager.getAiStatus());
});

router.get("/bot/ai/skills", (_req, res) => {
  res.json({ skills: botManager.listAiSkills() });
});

router.get("/bot/ai/skills/:name", (req, res) => {
  const skill = botManager.getAiSkill(req.params.name);
  if (!skill) {
    res.status(404).json({ error: `No AI skill named "${req.params.name}"` });
    return;
  }
  res.json(skill);
});

router.delete("/bot/ai/skills/:name", (req, res) => {
  if (!botManager.deleteAiSkill(req.params.name)) {
    res.status(404).json({ error: `No AI skill named "${req.params.name}"` });
    return;
  }
  res.json({ success: true, message: `AI skill "${req.params.name}" deleted` });
});

router.get("/bot/ai/config", (_req, res) => {
  res.json(botManager.getAiPublicConfig());
});

router.put("/bot/ai/config", (req, res) => {
  const parse = UpdateAiConfigBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }
  res.json(botManager.setAiConfig(parse.data));
});

export default router;
