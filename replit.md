# MineControl

A full-stack Minecraft Mineflayer bot control dashboard. Connect a bot to any Minecraft server and control it via a sleek, real-time web interface.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required env: none for dev (no DB used)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 + WebSocket (ws) server at `/ws`
- Bot: Mineflayer + mineflayer-pathfinder (externalized in esbuild)
- Frontend: React + Vite + shadcn/ui + Tailwind
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — API contract source of truth
- `artifacts/api-server/src/lib/bot.ts` — BotManager singleton (all bot logic)
- `artifacts/api-server/src/routes/bot.ts` — REST route handlers
- `artifacts/bot-dashboard/src/` — React frontend

## Architecture decisions

- mineflayer, mineflayer-pathfinder, minecraft-data, and prismarine-* are all externalized in esbuild (not bundled) because they use dynamic requires and path traversal to load data files at runtime.
- WebSocket at `/ws` is added to the API server's `artifact.toml` paths array so the proxy forwards WS connections.
- The `globalThis.require` banner in build.mjs enables `require()` calls at runtime in the ESM bundle — used by mineflayer-pathfinder at runtime.
- No database — bot state is in-memory only (BotManager singleton).

## Product

- Connect a bot to any Minecraft Java Edition server (1.12 – 1.20.x)
- Real-time status: health, food, XYZ position, online players
- Live activity log via WebSocket streaming
- 10 bot commands: follow, stop, kill mobs, mine resources, drop items, build base, climb, hit entity, pull lever, hit player

## Gotchas

- After any OpenAPI spec change, run `pnpm --filter @workspace/api-spec run codegen` before using updated types
- mineflayer-pathfinder must be imported as default (`import pkg from "mineflayer-pathfinder"`) then destructured — named exports don't work with ESM interop
- The bot runs in the API server process — only one bot instance at a time

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._
