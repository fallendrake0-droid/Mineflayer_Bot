import { logger } from "./logger";

export type AIProvider = "openai" | "gemini" | "anthropic" | "ollama" | "local";

export interface AIChatOptions {
  provider?: AIProvider;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  context?: Record<string, unknown>;
}

export interface AIResponse {
  provider: AIProvider;
  model: string;
  text: string;
  usedFallback: boolean;
}

export interface AIPlanResult {
  provider: AIProvider;
  model: string;
  plan: string[];
  usedFallback: boolean;
}

export interface AIDecisionResult {
  provider: AIProvider;
  model: string;
  action: string;
  rationale: string;
  confidence: number;
  usedFallback: boolean;
}

export interface AIProviderConfig {
  name: AIProvider;
  enabled: boolean;
  defaultModel: string;
}

class AIService {
  private getDefaultProvider(): AIProvider {
    const provider = (process.env["AI_PROVIDER"] ?? "local").toLowerCase() as AIProvider;
    return ["openai", "gemini", "anthropic", "ollama", "local"].includes(provider)
      ? provider
      : "local";
  }

  private buildPrompt(prompt: string, context?: Record<string, unknown>) {
    const compactContext = context ? JSON.stringify(context, null, 2) : "{}";
    return [
      "You are a helpful assistant for a Minecraft autonomous bot.",
      "Keep responses concise, safe, and decision-oriented.",
      "If you do not know, say so and suggest the next best action.",
      "",
      `Context:\n${compactContext}`,
      "",
      `User request:\n${prompt}`,
    ].join("\n");
  }

  getProviders(): AIProviderConfig[] {
    return [
      {
        name: "openai",
        enabled: Boolean(process.env["OPENAI_API_KEY"] || process.env["OPENAI_BASE_URL"]),
        defaultModel: this.getModelForProvider("openai"),
      },
      {
        name: "gemini",
        enabled: Boolean(process.env["GEMINI_API_KEY"]),
        defaultModel: this.getModelForProvider("gemini"),
      },
      {
        name: "anthropic",
        enabled: Boolean(process.env["ANTHROPIC_API_KEY"]),
        defaultModel: this.getModelForProvider("anthropic"),
      },
      {
        name: "ollama",
        enabled: Boolean(process.env["OLLAMA_BASE_URL"] || process.env["OLLAMA_HOST"]),
        defaultModel: this.getModelForProvider("ollama"),
      },
      { name: "local", enabled: true, defaultModel: "local-rule-engine" },
    ];
  }

  async chat(prompt: string, options: AIChatOptions = {}): Promise<AIResponse> {
    const provider = options.provider ?? this.getDefaultProvider();
    const model = options.model ?? this.getModelForProvider(provider);
    const temperature = options.temperature ?? 0.4;
    const maxTokens = options.maxTokens ?? 300;
    const context = options.context ?? {};

    // Local mode is intentional, not a failed remote request. It must work
    // without credentials and without creating network activity.
    if (provider === "local") {
      return {
        provider,
        model: "local-rule-engine",
        text: this.localFallback(prompt, context),
        usedFallback: false,
      };
    }

    try {
      const response = await this.callRemoteProvider(provider, model, this.buildPrompt(prompt, context), {
        temperature,
        maxTokens,
      });

      return {
        provider,
        model,
        text: response,
        usedFallback: false,
      };
    } catch (error: unknown) {
      // Never log raw provider errors: URLs and provider-specific messages can
      // contain credentials. Keep enough metadata to diagnose the failure class.
      logger.warn(
        {
          provider,
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        "AI provider request failed; using local fallback",
      );
      const fallback = this.localFallback(prompt, context);
      return {
        provider,
        model,
        text: fallback,
        usedFallback: true,
      };
    }
  }

  async plan(objective: string, options: AIChatOptions = {}): Promise<AIPlanResult> {
    if ((options.provider ?? this.getDefaultProvider()) === "local") {
      return {
        provider: "local",
        model: "local-rule-engine",
        plan: [
          "Check health, food, inventory, and nearby hazards.",
          "Choose the highest-priority task that can be completed safely.",
          "Stop and reassess if health drops, navigation stalls, or the environment becomes unsafe.",
        ],
        usedFallback: false,
      };
    }

    const result = await this.chat(
      `Create a short, actionable plan for the following objective. Return only a JSON object with a "plan" array of 3-6 steps. Objective: ${objective}`,
      { ...options, temperature: 0.2, maxTokens: 350 }
    );

    try {
      const parsed = JSON.parse(result.text);
      return {
        provider: result.provider,
        model: result.model,
        plan: Array.isArray(parsed.plan) ? parsed.plan.map(String) : [result.text],
        usedFallback: result.usedFallback,
      };
    } catch {
      return {
        provider: result.provider,
        model: result.model,
        plan: [result.text],
        usedFallback: result.usedFallback,
      };
    }
  }

  async decide(context: Record<string, unknown>, options: AIChatOptions = {}): Promise<AIDecisionResult> {
    if ((options.provider ?? this.getDefaultProvider()) === "local") {
      const decision = this.localDecision(context);
      return {
        provider: "local",
        model: "local-rule-engine",
        ...decision,
        usedFallback: false,
      };
    }

    const instruction = `Based on the bot context, choose the single best next action. Output a JSON object with fields: action, rationale, confidence.`;
    const result = await this.chat(instruction, {
      ...options,
      context,
      temperature: 0.2,
      maxTokens: 220,
    });

    try {
      const parsed = JSON.parse(result.text);
      return {
        provider: result.provider,
        model: result.model,
        action: typeof parsed.action === "string" ? parsed.action : "idle",
        rationale: typeof parsed.rationale === "string" ? parsed.rationale : result.text,
        confidence: typeof parsed.confidence === "number" ? Math.min(Math.max(parsed.confidence, 0), 1) : 0.5,
        usedFallback: result.usedFallback,
      };
    } catch {
      const fallback = this.localDecision(context);
      return {
        provider: result.provider,
        model: result.model,
        action: fallback.action,
        rationale: fallback.rationale,
        confidence: fallback.confidence,
        usedFallback: true,
      };
    }
  }

  async summarize(context: Record<string, unknown>, options: AIChatOptions = {}): Promise<AIResponse> {
    return this.chat("Summarize this bot state and suggest 2 next steps.", {
      ...options,
      context,
      temperature: 0.3,
      maxTokens: 260,
    });
  }

  private getModelForProvider(provider: AIProvider): string {
    const defaults: Record<AIProvider, string> = {
      openai: "gpt-6-luna",
      gemini: "gemini-3.8-flash",
      anthropic: "claude-haiku-4-5",
      ollama: "llama3.1",
      local: "local-rule-engine",
    };

    if (provider === "local") return defaults.local;

    const providerEnvironmentName: Record<Exclude<AIProvider, "local">, string> = {
      openai: "OPENAI_MODEL",
      gemini: "GEMINI_MODEL",
      anthropic: "ANTHROPIC_MODEL",
      ollama: "OLLAMA_MODEL",
    };
    return process.env[providerEnvironmentName[provider]]?.trim()
      || process.env["AI_MODEL"]?.trim()
      || defaults[provider];
  }

  private getRequestTimeoutMs(): number {
    const configured = Number(process.env["AI_TIMEOUT_MS"] ?? "15000");
    // Prevent accidental infinite waits and reject non-numeric/unsafe values.
    if (!Number.isSafeInteger(configured) || configured < 1000 || configured > 120000) {
      return 15000;
    }
    return configured;
  }

  private fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
    });
  }

  private localFallback(prompt: string, context?: Record<string, unknown>) {
    const summary = context ? JSON.stringify(context) : "";
    if (prompt.toLowerCase().includes("plan")) {
      return `Plan: 1) assess bot state, 2) reduce risk, 3) execute the highest-value goal, 4) re-evaluate after each loop. Context: ${summary}`;
    }
    if (prompt.toLowerCase().includes("summarize")) {
      return `Bot status looks stable. Prioritize safety, resource collection, and task completion. Review current health, nearby players, and inventory before taking a new action.`;
    }
    return `Recommended action: keep the bot safe, check nearby hazards, and complete the highest-priority low-cost task. Context inspected: ${summary}`;
  }

  private localDecision(context: Record<string, unknown>) {
    const health = Number((context as any)?.health ?? 20);
    const currentTask = String((context as any)?.currentTask ?? "idle");
    const players = Array.isArray((context as any)?.players) ? (context as any).players : [];

    if (health <= 8) {
      return {
        action: "retreat_and_heal",
        rationale: "Health is low; safety takes priority before starting a risky task.",
        confidence: 0.96,
      };
    }

    if (players.length > 0 && currentTask !== "following") {
      return {
        action: "scan_nearby_players",
        rationale: "Nearby players could affect bot safety or create a follow/guard task.",
        confidence: 0.82,
      };
    }

    if (currentTask === "idle") {
      return {
        action: "collect_resources",
        rationale: "The bot is idle; collecting basic resources is the best low-risk productive step.",
        confidence: 0.8,
      };
    }

    return {
      action: "continue_current_task",
      rationale: "The bot already has a valid task; continuing is lower-risk than switching context.",
      confidence: 0.72,
    };
  }

  private async callRemoteProvider(
    provider: AIProvider,
    model: string,
    prompt: string,
    options: { temperature: number; maxTokens: number }
  ): Promise<string> {
    const commonHeaders = {
      "Content-Type": "application/json",
    };

    if (provider === "openai") {
      const apiKey = process.env["OPENAI_API_KEY"]?.trim();
      const configuredBaseUrl = process.env["OPENAI_BASE_URL"]?.trim();
      const apiMode = (process.env["OPENAI_API_MODE"] ?? (configuredBaseUrl ? "chat-completions" : "responses")).toLowerCase();
      if (!apiKey && !configuredBaseUrl) throw new Error("OPENAI_API_KEY not set");
      if (apiMode !== "responses" && apiMode !== "chat-completions") {
        throw new Error("OPENAI_API_MODE must be responses or chat-completions");
      }

      const baseUrl = (configuredBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      const headers: Record<string, string> = { ...commonHeaders };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      if (apiMode === "responses") {
        const reasoningEffort = process.env["OPENAI_REASONING_EFFORT"]?.trim()
          || (model === "gpt-6-luna" ? "none" : undefined);
        const requestBody: Record<string, unknown> = {
          model,
          input: prompt,
          max_output_tokens: options.maxTokens,
        };
        if (reasoningEffort) requestBody["reasoning"] = { effort: reasoningEffort };

        const response = await this.fetchWithTimeout(`${baseUrl}/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) throw new Error(`OpenAI Responses request failed: ${response.status}`);

        const json = (await response.json()) as {
          output_text?: unknown;
          output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
        };
        if (typeof json.output_text === "string" && json.output_text.trim()) {
          return json.output_text.trim();
        }

        // The API can return more than one output item; aggregate all text
        // rather than assuming the first content block always holds the answer.
        const textOutput = Array.isArray(json.output)
          ? json.output.flatMap((item) =>
              Array.isArray(item.content)
                ? item.content
                    .filter((part) => part.type === "output_text" && typeof part.text === "string")
                    .map((part) => part.text ?? "")
                : []
            ).join("\\n").trim()
          : "";
        if (!textOutput) throw new Error("OpenAI Responses returned no text output");
        return textOutput;
      }

      // Compatibility mode for OpenAI-compatible services that implement
      // Chat Completions instead of the Responses API.
      const response = await this.fetchWithTimeout(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          temperature: options.temperature,
          max_tokens: options.maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`OpenAI-compatible chat request failed: ${response.status}`);
      const json = (await response.json()) as any;
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("Chat Completions returned no text output");
      }
      return text.trim();
    }

    if (provider === "gemini") {
      const apiKey = process.env["GEMINI_API_KEY"];
      if (!apiKey) throw new Error("GEMINI_API_KEY not set");
      const response = await this.fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: commonHeaders,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // Gemini 3.x deprecates legacy sampling parameters; retain the
            // output cap but let the selected model use its documented defaults.
            generationConfig: { maxOutputTokens: options.maxTokens },
          }),
        }
      );
      if (!response.ok) throw new Error(`Gemini request failed: ${response.status}`);
      const json = (await response.json()) as any;
      const text = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
      if (!text) throw new Error("Gemini returned no text output");
      return text;
    }

    if (provider === "anthropic") {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      const response = await this.fetchWithTimeout("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          ...commonHeaders,
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens,
          temperature: options.temperature,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`Anthropic request failed: ${response.status}`);
      const json = (await response.json()) as any;
      const text = String(json?.content?.[0]?.text ?? "").trim();
      if (!text) throw new Error("Anthropic returned no text output");
      return text;
    }

    if (provider === "ollama") {
      const baseUrl = process.env["OLLAMA_BASE_URL"] ?? process.env["OLLAMA_HOST"] ?? "http://localhost:11434";
      const response = await this.fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: options.temperature },
        }),
      });
      if (!response.ok) throw new Error(`Ollama request failed: ${response.status}`);
      const json = (await response.json()) as any;
      const text = String(json?.response ?? "").trim();
      if (!text) throw new Error("Ollama returned no text output");
      return text;
    }

    throw new Error("No remote provider configured");
  }
}

export const aiService = new AIService();

