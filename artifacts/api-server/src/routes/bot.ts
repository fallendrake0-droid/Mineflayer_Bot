import { Router } from "express";
import { botManager } from "../lib/bot";
import {
  ConnectBotBody,
  ExecuteBotCommandBody,
  GetBotLogsQueryParams,
} from "@workspace/api-zod";

const router = Router();

router.post("/bot/connect", async (req, res) => {
  const parse = ConnectBotBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: parse.error.message });
    return;
  }

  const { host, port = 25565, username, version = "1.20.1" } = parse.data;

  try {
    await botManager.connect(host, port, username, version);
    res.json(botManager.getStatus());
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/bot/disconnect", (_req, res) => {
  try {
    botManager.disconnect();
    res.json(botManager.getStatus());
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
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

  const { command, target, resource } = parse.data;

  try {
    switch (command) {
      case "follow":
        if (!target) {
          res.status(400).json({ error: "target player name required for follow" });
          return;
        }
        await botManager.follow(target);
        break;

      case "stop":
        botManager.stop();
        break;

      case "killMobs":
        await botManager.killMobs();
        break;

      case "mine":
        if (!resource) {
          res.status(400).json({ error: "resource type required for mine command" });
          return;
        }
        botManager.mine(resource).catch(() => {});
        break;

      case "dropItems":
        await botManager.dropItems(target);
        break;

      case "buildBase":
        botManager.buildBase().catch(() => {});
        break;

      case "climb":
        botManager.climb().catch(() => {});
        break;

      case "hit":
        if (!target) {
          res.status(400).json({ error: "target name required for hit" });
          return;
        }
        await botManager.hit(target);
        break;

      case "pullLever":
        await botManager.pullLever();
        break;

      case "hitPlayer":
        if (!target) {
          res.status(400).json({ error: "target player name required for hitPlayer" });
          return;
        }
        await botManager.hitPlayer(target);
        break;

      default:
        res.status(400).json({ error: `Unknown command: ${command}` });
        return;
    }

    res.json({ success: true, message: `Command '${command}' executed` });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/bot/logs", (req, res) => {
  const parse = GetBotLogsQueryParams.safeParse(req.query);
  const limit = parse.success ? (parse.data.limit ?? 100) : 100;
  res.json({ logs: botManager.getLogs(limit) });
});

router.get("/bot/inventory", (_req, res) => {
  res.json({ items: botManager.getInventory() });
});

export default router;
