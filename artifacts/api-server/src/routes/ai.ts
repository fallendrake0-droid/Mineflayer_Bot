import { Router, type Request, type Response, type NextFunction } from "express";
import {
  aiService,
  type AIChatOptions,
  type AIProvider,
} from "../lib/ai";

const router = Router();

const AI_PROVIDERS: AIProvider[] = ["openai", "gemini", "anthropic", "ollama", "local"];
const AI_RATE_WINDOW_MS = 60_000;
const AI_RATE_LIMIT = 30;
const aiRequests = new Map<string, { count: number; resetAt: number }>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aiRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  let entry = aiRequests.get(key);

  if (!entry || entry.resetAt <= now) {
    // Bound map growth if a deployment receives requests from many distinct
    // client addresses. Expired keys are cleaned before adding a new one.
    if (aiRequests.size >= 1000) {
      for (const [client, state] of aiRequests) {
        if (state.resetAt <= now || aiRequests.size >= 900) aiRequests.delete(client);
      }
    }
    entry = { count: 0, resetAt: now + AI_RATE_WINDOW_MS };
    aiRequests.set(key, entry);
  }

  entry.count += 1;
  if (entry.count > AI_RATE_LIMIT) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    res.status(429).json({ error: "AI request limit reached. Try again shortly." });
    return;
  }

  next();
}

function parseOptions(body: Record<string, unknown>):
  | { options: AIChatOptions; error?: never }
  | { options?: never; error: string } {
  const options: AIChatOptions = {};

  if (body["provider"] !== undefined) {
    if (typeof body["provider"] !== "string" || !AI_PROVIDERS.includes(body["provider"] as AIProvider)) {
      return { error: "provider must be one of: openai, gemini, anthropic, ollama, local" };
    }
    options.provider = body["provider"] as AIProvider;
  }

  if (body["model"] !== undefined) {
    if (typeof body["model"] !== "string" || !body["model"].trim() || body["model"].length > 128) {
      return { error: "model must be a non-empty string no longer than 128 characters" };
    }
    options.model = body["model"].trim();
  }

  if (body["temperature"] !== undefined) {
    if (typeof body["temperature"] !== "number" || !Number.isFinite(body["temperature"]) ||
      body["temperature"] < 0 || body["temperature"] > 2) {
      return { error: "temperature must be a number between 0 and 2" };
    }
    options.temperature = body["temperature"];
  }

  if (body["maxTokens"] !== undefined) {
    if (typeof body["maxTokens"] !== "number" || !Number.isInteger(body["maxTokens"]) ||
      body["maxTokens"] < 1 || body["maxTokens"] > 8192) {
      return { error: "maxTokens must be an integer between 1 and 8192" };
    }
    options.maxTokens = body["maxTokens"];
  }

  if (body["context"] !== undefined) {
    if (!isRecord(body["context"])) {
      return { error: "context must be a JSON object" };
    }
    options.context = body["context"];
  }

  return { options };
}

function readBody(req: Request, res: Response): Record<string, unknown> | null {
  if (!isRecord(req.body)) {
    res.status(400).json({ error: "Request body must be a JSON object" });
    return null;
  }
  return req.body;
}

function validateTextInput(value: unknown, field: string, maxLength = 12_000): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return `${field} must be a non-empty string`;
  }
  if (value.length > maxLength) {
    return `${field} must be no longer than ${maxLength} characters`;
  }
  return null;
}

// Provider state exposes availability/model names only; credentials are never returned.
router.get("/ai/providers", (_req, res) => {
  res.json({ providers: aiService.getProviders() });
});

router.post("/ai/chat", aiRateLimit, async (req, res) => {
  const body = readBody(req, res);
  if (!body) return;
  const promptError = validateTextInput(body["prompt"], "prompt");
  if (promptError) {
    res.status(400).json({ error: promptError });
    return;
  }
  const parsed = parseOptions(body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    res.json(await aiService.chat((body["prompt"] as string).trim(), parsed.options));
  } catch {
    res.status(500).json({ error: "AI chat request could not be processed." });
  }
});

router.post("/ai/plan", aiRateLimit, async (req, res) => {
  const body = readBody(req, res);
  if (!body) return;
  const objectiveError = validateTextInput(body["objective"], "objective", 8_000);
  if (objectiveError) {
    res.status(400).json({ error: objectiveError });
    return;
  }
  const parsed = parseOptions(body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }

  try {
    res.json(await aiService.plan((body["objective"] as string).trim(), parsed.options));
  } catch {
    res.status(500).json({ error: "AI planning request could not be processed." });
  }
});

router.post("/ai/decide", aiRateLimit, async (req, res) => {
  const body = readBody(req, res);
  if (!body) return;
  const parsed = parseOptions(body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.options.context) {
    res.status(400).json({ error: "context is required and must be a JSON object" });
    return;
  }

  try {
    res.json(await aiService.decide(parsed.options.context, parsed.options));
  } catch {
    res.status(500).json({ error: "AI decision request could not be processed." });
  }
});

router.post("/ai/summarize", aiRateLimit, async (req, res) => {
  const body = readBody(req, res);
  if (!body) return;
  const parsed = parseOptions(body);
  if (parsed.error) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (!parsed.options.context) {
    res.status(400).json({ error: "context is required and must be a JSON object" });
    return;
  }

  try {
    res.json(await aiService.summarize(parsed.options.context, parsed.options));
  } catch {
    res.status(500).json({ error: "AI summary request could not be processed." });
  }
});

export default router;
