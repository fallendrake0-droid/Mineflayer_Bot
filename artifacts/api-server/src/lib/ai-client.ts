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
    return !!this.getConfig().apiKey;
  }

  async chat(
    messages: AiChatMessage[],
    opts?: { timeoutMs?: number; temperature?: number; maxTokens?: number },
  ): Promise<AiChatResult> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) {
      throw new Error(
        "AI is not configured — add an API key in the dashboard's AI panel (or set the AI_API_KEY environment variable)",
      );
    }
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 90_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
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
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
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
