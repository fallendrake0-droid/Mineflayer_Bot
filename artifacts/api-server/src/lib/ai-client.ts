/**
 * Minimal OpenAI-compatible chat-completions client for the AI brain.
 *
 * Works with any provider exposing `POST {baseUrl}/chat/completions`:
 * Google Gemini (default), OpenAI, OpenRouter, Ollama, LM Studio, …
 *
 * The API key is only ever read from config and placed in the
 * Authorization header — it is never logged or returned anywhere.
 */

export interface AiConfig {
  apiKey: string | null;
  baseUrl: string;
  model: string;
}

/**
 * True when the base URL points at this machine or the local network —
 * e.g. Ollama (http://localhost:11434/v1) or LM Studio on a LAN PC.
 * Local providers need no API key and get a much longer timeout, since
 * CPU inference can take a while.
 */
export function isLocalAiBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
    if (host.endsWith(".local")) return true;
    if (host.startsWith("192.168.") || host.startsWith("10.")) return true;
    const m = /^172\.(\d{1,3})\./.exec(host);
    if (m) {
      const second = Number(m[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class AiClient {
  private readonly getConfig: () => AiConfig;

  constructor(getConfig: () => AiConfig) {
    this.getConfig = getConfig;
  }

  get configured(): boolean {
    const cfg = this.getConfig();
    return !!cfg.apiKey || isLocalAiBaseUrl(cfg.baseUrl);
  }

  get isLocal(): boolean {
    return isLocalAiBaseUrl(this.getConfig().baseUrl);
  }

  async chat(
    messages: AiChatMessage[],
    opts?: { timeoutMs?: number; temperature?: number; maxTokens?: number },
  ): Promise<AiChatResult> {
    const cfg = this.getConfig();
    const local = isLocalAiBaseUrl(cfg.baseUrl);
    if (!cfg.apiKey && !local) {
      throw new Error(
        "AI is not configured — add an API key in the dashboard's AI panel, or switch the provider to local Ollama (no key needed)",
      );
    }
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // Local CPU inference can be slow; cloud APIs should answer quickly.
    const timeoutMs = opts?.timeoutMs ?? (local ? 300_000 : 90_000);
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${cfg.apiKey ?? "local"}`,
          },
          body: JSON.stringify({
            model: cfg.model,
            messages,
            temperature: opts?.temperature ?? 0.4,
            ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          }),
          signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          // Some failures will never succeed on retry — fail fast with an
          // actionable message instead of hammering the provider.
          const fatal = fatalProviderHint(res.status, text, cfg);
          if (fatal) throw new Error(fatal);
          // Free-tier cloud models regularly return 503 "high demand" (and
          // 429 rate limits); those are worth a couple of spaced retries.
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < maxAttempts) {
            await delay(attempt === 1 ? 3000 : 10000);
            continue;
          }
          throw new Error(`AI request failed (HTTP ${res.status}): ${truncate(text, 300)}`);
        }
        let json: ChatCompletionsResponse;
        try {
          json = JSON.parse(text) as ChatCompletionsResponse;
        } catch {
          throw new Error("AI returned a non-JSON response");
        }
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.trim() === "") {
          throw new Error("AI returned an empty response");
        }
        return {
          content,
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new Error("AI request timed out");
        }
        const message = err instanceof Error ? err.message : String(err);
        const ours = message.startsWith("AI ");
        if (!ours && attempt < maxAttempts) {
          // Network-level failure (refused, DNS, reset) — brief backoff.
          await delay(attempt === 1 ? 3000 : 8000);
          continue;
        }
        if (!ours && local) {
          throw new Error(
            `Could not reach the local AI at ${cfg.baseUrl} — is Ollama running? Start it with: ollama serve`,
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    // Unreachable (the loop always returns or throws), but keep TS happy.
    throw new Error("AI request failed");
  }
}

/**
 * Recognize provider errors that retrying cannot fix and translate them
 * into actionable messages. Returns null for ordinary/transient errors.
 * Seen in the wild: Ollama on a low-RAM Chromebook answers HTTP 500
 * "llama-server reported out-of-memory … attempted to allocate 4685 MB"
 * for an 8B model — retrying just re-attempts the same doomed load.
 */
function fatalProviderHint(status: number, body: string, cfg: AiConfig): string | null {
  if (/out[ _-]?of[ _-]?memory|insufficient memory|failed to allocate/i.test(body)) {
    return (
      `AI model ran out of memory while loading — "${cfg.model}" is too large for this machine's free RAM. ` +
      "Try a smaller model (e.g. llama3.2:3b or qwen2.5-coder:3b, ~2 GB) or close other apps to free memory, then try again"
    );
  }
  if (status === 404 && /not found/i.test(body) && isLocalAiBaseUrl(cfg.baseUrl)) {
    return (
      `AI model "${cfg.model}" is not installed on the local AI server — run: ollama pull ${cfg.model} ` +
      "(or pick an installed model via LOAD MODELS in the AI panel)"
    );
  }
  return null;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Extract the first JSON object from an LLM response. Models are asked for
 * bare JSON but often wrap it in ```json fences or add a sentence around
 * it — tolerate both. Returns null when nothing parseable is found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidate = fenced[1].trim();

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(s) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(candidate);
  if (direct) return direct;

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) return tryParse(candidate.slice(start, end + 1));
  return null;
}
