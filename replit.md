# MineControl

A full-stack Minecraft Mineflayer bot control dashboard. Connect a bot to any offline-mode Minecraft Java server and control it — with a live 3D view — via a real-time web interface.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (Replit sets PORT via artifact)
- Local dev: API on `PORT=5000` (node dist/index.mjs), dashboard on `PORT=5173 BASE_PATH=/ API_PORT=5000` (vite dev proxies /api, /ws, /viewer)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm run smoke` — boot built API on a scratch port and verify REST/WS/viewer proxy (no Minecraft server needed)
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: none for dev (no DB used)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + WebSocket (ws) server at `/ws` (noServer mode; upgrade routing in index.ts)
- Bot: Mineflayer + mineflayer-pathfinder + prismarine-viewer (all externalized in esbuild)
- Frontend: React + Vite + shadcn/ui + Tailwind; single shared WebSocket via BotProvider
- Build: esbuild (ESM bundle with require banner)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract source of truth
- `artifacts/api-server/src/lib/bot.ts` — BotManager (connection lifecycle, task engine, automation, chat commands)
- `artifacts/api-server/src/lib/bot-data.ts` / `bot-utils.ts` — game tables; cancellation tokens & helpers
- `artifacts/api-server/src/routes/bot.ts` — REST handlers (`startLongTask` races quick validations to HTTP 400)
- `artifacts/api-server/src/index.ts` — HTTP server, WS snapshot+heartbeat, `/viewer` reverse proxy (HTTP + upgrade) to prismarine-viewer on `VIEWER_PORT` (default 3007)
- `artifacts/bot-dashboard/src/lib/bot-context.tsx` — one WebSocket for the whole UI (status/logs/inventory/settings)
- `scripts/smoke-test.mjs` — post-build verification

## Architecture decisions

- mineflayer, mineflayer-pathfinder, minecraft-data, prismarine-* and vec3 are direct deps of api-server and externalized in esbuild (dynamic requires / runtime data files). minecraft-data MUST be a direct dep or the runtime `require("minecraft-data")` fails under pnpm's isolated layout.
- prismarine-viewer's `canvas` require is patched to be optional (`patches/prismarine-viewer@1.33.0.patch`, wired via root package.json `pnpm.patchedDependencies`) — canvas is only a devDependency of the viewer (nametag textures/headless) and native builds are fragile. The bot also lazy-requires the viewer so a broken viewer can never block boot.
- The viewer runs on its own internal port with `prefix: "/viewer"` and is reverse-proxied by index.ts so it's always same-origin in the browser. `/viewer` was added to the api-server artifact.toml paths for Replit routing.
- Long bot tasks are cancellable via TaskToken (bot-utils.ts): STOP/new task cancels pathfinder goals, digging, sleeps. Task completion streams via logs/status, not HTTP responses.
- Status is broadcast on a 250 ms tick (not per move event); inventory/settings are pushed on change. No REST polling in the UI.
- Settings persist to `data/minecontrol-settings.json` (cwd-relative, `MINECONTROL_SETTINGS_FILE` overrides). Bot state otherwise in-memory; one bot at a time.
- Auto-reconnect only engages after a session has spawned once, with 3→30 s backoff; manual disconnect cancels it.

## Product

- Offline-mode Java servers (1.8 – 1.21.x, version auto-detect via ping)
- Live first-person/orbit view, manual keyboard driving, in-game chat console
- 20+ dashboard commands + owner-whitelisted `!` chat commands (type `!help` in game)
- Survival automation: auto-eat, auto-armor, auto-defend, drop collection, anti-AFK, auto-reconnect

## Gotchas

- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen`
- mineflayer-pathfinder must be imported as default (`import pkg from "mineflayer-pathfinder"`) then destructured — named exports don't work with ESM interop
- Modern mineflayer injects plugins asynchronously: `bot.inventory` is **undefined until spawn** — wire inventory listeners in the spawn handler
- The whole prismarine ecosystem types against vec3 ^0.1.x; keep api-server's vec3 on 0.1.x or types clash (0.2.x adds methods like angleTo)
- Never rebuild the API (`rm -rf dist`) while a dev API process is running from that dist — pino worker files vanish mid-run
- Validated live against flying-squid (JS MC server) on 1.20.1: connect, follow, mine, chat commands, viewer proxy, auto-reconnect after keepalive drops

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
