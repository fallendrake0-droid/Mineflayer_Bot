# Mineflayer_Bot

A Mineflayer bot and web dashboard in a pnpm workspace.

## Security configuration

Before deploying the API or dashboard on a network, configure a unique dashboard token. The bot-control API and telemetry WebSocket fail closed when `DASHBOARD_TOKEN` is missing.

1. Copy `.env.example` to your private environment configuration; do not commit a real `.env` file.
2. Generate a strong secret, for example with `openssl rand -hex 32`, and set it as `DASHBOARD_TOKEN`.
3. Start the API server and open the dashboard. Enter the same token in the dashboard access prompt. The dashboard keeps it in session storage for the current browser tab/session and sends it as a bearer token.
4. Use HTTPS for remote access. Do not publish the API or dashboard without network-level controls and a strong token.
5. If the dashboard uses a different origin from the API, set `DASHBOARD_ORIGINS` to a comma-separated list of exact allowed origins. Same-origin deployment is the default; cross-origin response headers are disabled by default.

The `/api/healthz` health check remains public and does not return bot state. Bot connection, status, task, inventory, log and command endpoints require authentication. The WebSocket at `/ws` sends no status or log events until its first-message token handshake succeeds.

### In-game command allowlist

In-game commands are disabled unless `MINEFLAYER_COMMAND_ALLOWLIST` is set. Configure a comma-separated list of exact Minecraft usernames and/or UUIDs that may use commands such as `!follow`, `!mine`, `!drop`, `!chop` and `!stop`. Username comparisons are case-insensitive. Leave this value empty to deny chat-issued commands to everyone. Dashboard commands still require the dashboard bearer token.

### OpenAI and other AI providers

Keep `OPENAI_API_KEY`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` in the process environment or your hosting platform's secret manager. Never add a real key to source control, frontend variables, screenshots or logs. A browser-side token is not an appropriate place to store provider API keys.

## Development checks

Use the package manager enforced by this repository:

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

The security changes in the branch `fix/security-auth-allowlist-2026-10-23` have been applied through repository edits, but they have **not yet been run through the TypeScript build or a live Minecraft/dashboard integration test** in this environment. Run the commands above and verify all of the following before deployment:

- A request to `/api/bot/status` without a bearer token returns `401` (or `503` if `DASHBOARD_TOKEN` is not configured).
- The same request with the correct `Authorization: Bearer …` token succeeds.
- `/ws` sends no initial status/log payload until the client authenticates; an invalid token is rejected.
- A player absent from `MINEFLAYER_COMMAND_ALLOWLIST` cannot issue in-game commands.
- The dashboard access prompt accepts the configured token and all authenticated dashboard controls continue to work.
- No secrets appear in logs or HTTP responses.

## Known engineering priorities

The original project still needs a full regression pass over task cancellation, single movement ownership, navigation recovery, reconnect races, mining overlap, inventory safety and provider-specific AI behaviour. Do not treat an issue or successful static check as evidence of a completed real-server test.
