# Mineflayer_Bot

A Mineflayer bot and web dashboard in a pnpm workspace.

## Security configuration

Before deploying the API or dashboard on a network, configure a unique dashboard token. The bot-control API and telemetry WebSocket fail closed when `DASHBOARD_TOKEN` is missing.

1. Copy `.env.example` into your private deployment environment; do not commit a real `.env` file.
2. Generate a strong secret, for example with `openssl rand -hex 32`, and set it as `DASHBOARD_TOKEN`.
3. Open the dashboard and enter the same token in its access prompt. The dashboard keeps it in session storage and sends it as a bearer token for API requests.
4. Use HTTPS for remote access. Do not expose a live bot on the public internet without a strong token and suitable network controls.
5. If the dashboard uses a different origin from the API, set `DASHBOARD_ORIGINS` to the comma-separated exact allowed origins. Same-origin is the default.

The `/api/healthz` health check remains public and does not return bot state. Bot connection, status, task, inventory, logs, commands and AI routes require authentication. The WebSocket at `/ws` sends no status/log data until its first-message token handshake succeeds.

## In-game chat command allowlist

In-game commands are disabled unless `MINEFLAYER_COMMAND_ALLOWLIST` is set. Configure a comma-separated list of exact Minecraft usernames and/or UUIDs that may issue commands such as `!follow`, `!mine`, `!drop`, `!chop` and `!stop`. Username comparisons are case-insensitive. Leave this value empty to deny chat-issued commands to everyone. Dashboard commands require the dashboard bearer token regardless of this setting.

## AI providers and API options

AI support can be used without an online provider: `AI_PROVIDER=local` uses the local rule engine without API calls or API credentials. Remote AI requests use bounded timeouts, report a local fallback rather than exposing provider errors, and do not log provider keys or raw request URLs.

Supported providers:
- **OpenAI:** `OPENAI_API_KEY`, optional `OPENAI_MODEL`, `OPENAI_BASE_URL`, `OPENAI_API_MODE`, and `OPENAI_REASONING_EFFORT`. Official OpenAI API defaults to the Responses API. For an OpenAI-compatible API that supports only Chat Completions, set `OPENAI_BASE_URL` and `OPENAI_API_MODE=chat-completions`.
- **Gemini:** `GEMINI_API_KEY` and optional `GEMINI_MODEL`.
- **Anthropic:** `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL`.
- **Ollama:** `OLLAMA_BASE_URL` (or `OLLAMA_HOST`) and optional `OLLAMA_MODEL`.
- **Global overrides:** `AI_MODEL` applies when a provider-specific model is not set; `AI_TIMEOUT_MS` accepts values from 1000 to 120000 ms.

The defaults in `.env.example` are examples and may not be available to every account or compatible API. Select a model ID offered by your provider and project. Keep provider keys only in server environment variables or your hosting platform's secrets manager, never in browser code or the Git repository.

### Authenticated AI routes

All routes below are mounted under `/api` and use the same `Authorization: Bearer <DASHBOARD_TOKEN>` authentication as the bot controls.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ai/providers` | List configured provider availability and default model IDs; does not return credentials |
| POST | `/api/ai/chat` | Chat with a selected provider/model |
| POST | `/api/ai/plan` | Generate a task plan |
| POST | `/api/ai/decide` | Choose a next action from a supplied context object |
| POST | `/api/ai/summarize` | Summarize supplied bot context |

Example chat body:

```json
{
  "provider": "openai",
  "model": "gpt-6-luna",
  "prompt": "Assess the bot's current state and suggest a safe next step.",
  "maxTokens": 300
}
```

For `/ai/decide` and `/ai/summarize`, provide a `context` JSON object. Optional request settings are `provider`, `model`, `temperature`, and `maxTokens`; the server validates their types and bounds. AI endpoints are rate-limited to 30 requests per minute per client IP. Model-specific parameters may be ignored where the provider API doesn't support them.

## Build and checks

Use pnpm, as enforced by the repository:

```sh
pnpm install
pnpm run typecheck
pnpm run build
node --experimental-strip-types --test artifacts/api-server/tests/auth.test.mjs
```

A GitHub Actions workflow runs the authentication middleware tests, workspace typecheck, and build for pushes to the fix branch and pull requests to `main`.

The current draft branch includes source-tree cleanup, restored AI service code, authentication, chat allowlisting, AI routes and configurable provider/API options. CI passing validates installation, TypeScript typechecking, the configured authentication tests and the production build. It does **not** replace an end-to-end browser test, provider API request test, or live Minecraft session.

Before public deployment, manually verify:
- Bot API endpoints reject missing/incorrect credentials and accept the correct bearer token.
- The WebSocket rejects unauthenticated clients before sending status/logs.
- The dashboard access prompt succeeds with the configured token and controls remain usable.
- Chat commands from users absent from `MINEFLAYER_COMMAND_ALLOWLIST` have no effect.
- Each desired AI provider works with its chosen API key, model, and endpoint/mode combination.
- Connect/disconnect, stop/cancel, mining, inventory handling, navigation and reconnect behavior are safe on a test Minecraft server.

## Remaining engineering scope

The branch resolves the identified access-control issue and a mining-loop overlap/cancellation race, but it is not a claim that every possible bot bug has been eliminated. Multi-task movement ownership, navigation recovery, reconnect races, survival/inventory safety, model-output validation, and long-duration real-server testing still require a full regression pass.
