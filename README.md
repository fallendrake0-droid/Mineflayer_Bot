# MineControl

A full-stack control center for an autonomous **Mineflayer** Minecraft bot.
Connect a bot to any offline-mode Minecraft Java server and drive it from a
real-time web dashboard — complete with a **live 3D view** through the bot's
eyes, a manual remote-control pad, a survival brain (auto-eat, auto-armor,
self-defense, auto-reconnect) and in-game chat commands.

## Features

### Dashboard
- **Live view** — prismarine-viewer embedded in the page (first-person or
  orbit camera), served same-origin through the API proxy at `/viewer/`.
- **Command Center** — 20+ commands: go-to coordinates, follow, wander,
  pillar up, smart mining with a target count, tree chopping + replanting,
  shelter building, drop collecting, chest depositing, mob hunting,
  guarding, sleeping…
- **Manual control pad** — drive with on-screen buttons or your keyboard
  (WASD, Space, Shift, E, arrow keys to look), with a server-side
  dead-man's switch.
- **Activity & chat console** — filterable/searchable log stream, download
  logs, and send in-game chat or `/commands` as the bot.
- **Real inventory grid** — hotbar/main/armor/off-hand with item categories,
  durability bars, and click-to equip / use / eat / drop.
- **Rich status** — hearts & hunger meters, XP, position, dimension,
  time of day, ping, session stats (blocks mined, kills, metres walked…),
  and a clickable online-players list (follow / give loot / hit).
- **Saved server profiles** (localStorage), auto version detection, and a
  reconnecting single-WebSocket UI — no polling.

### Bot brain
- **Cancellable tasks** — STOP (or any new command) cleanly interrupts
  mining, chopping, building, pathfinding, etc.
- **Smart mining** — checks pickaxe tier before wasting your time, mines
  whole veins, collects drops, explores when nothing is in range, stops at
  your target count.
- **Real combat** — equips the best weapon, chases, swings on cooldown,
  hit-and-retreats from creepers, flees and eats at critical health.
- **Survival automation** (all toggleable) — auto-eat, auto-equip best
  armor, auto-defend, auto-collect drops, anti-AFK, and **auto-reconnect
  with exponential backoff** after kicks/drops.
- **Chat commands** with an owner whitelist (see below).

## Quick start (local)

Prerequisites: Node 20+ and pnpm 9+ (`corepack enable pnpm`).

```bash
pnpm install

# Terminal 1 — API + bot engine (port 5000)
pnpm --filter @workspace/api-server run build
PORT=5000 NODE_ENV=development node --enable-source-maps artifacts/api-server/dist/index.mjs

# Terminal 2 — dashboard (http://localhost:5173, proxies /api, /ws, /viewer to the API)
PORT=5173 BASE_PATH=/ API_PORT=5000 pnpm --filter @workspace/bot-dashboard run dev
```

Then open http://localhost:5173, enter your Minecraft server's host/port, a
bot username, your own in-game name (for chat commands), and hit **Connect**.

> [!NOTE]
> The bot uses **offline-mode authentication** (a plain username), so the
> server must be offline-mode / local / LAN (`online-mode=false` in
> `server.properties`). Public servers with Microsoft-account enforcement are
> not supported.

On Replit, the two artifacts (`api-server`, `bot-dashboard`) run as before —
`/api`, `/ws` and `/viewer` are routed to the API server.

## In-game chat commands

Players on the **owner whitelist** (set at connect time or in Automation
settings) can command the bot from Minecraft chat:

| Command | What it does |
| --- | --- |
| `!help` | List commands |
| `!come` | Follow you |
| `!follow <player>` | Follow a player |
| `!goto <x> [y] <z>` | Walk to coordinates |
| `!stop` | Stop the current task |
| `!mine <resource> [count]` | Mine coal/iron/copper/gold/redstone/lapis/diamond/emerald/stone/obsidian/ancient_debris |
| `!chop [type] [trees]` | Chop tree(s), collect drops, replant saplings |
| `!kill` | Hunt nearby hostile mobs |
| `!guard` | Guard the current spot |
| `!wander` | Wander around |
| `!eat` / `!sleep` | Eat / sleep in the nearest bed |
| `!collect` | Pick up nearby drops |
| `!deposit` | Store loot in the nearest chest/barrel |
| `!drop [player]` | Drop loot (keeps gear & food) |
| `!climb [n]` | Pillar up n blocks |
| `!build [size]` | Build a walled shelter with a roof |
| `!status` / `!inv` | Report vitals / inventory |

If the whitelist is empty, **everyone** can use chat commands — set your
username in the connect form (stored as a setting) to restrict it.

## Architecture

```
lib/api-spec/openapi.yaml ──(orval codegen)──► lib/api-zod (server validation)
                                          └──► lib/api-client-react (hooks)
artifacts/api-server      Express 5 + ws. BotManager owns the Mineflayer bot,
                          prismarine-viewer (proxied at /viewer), task
                          engine and settings (data/minecontrol-settings.json).
artifacts/bot-dashboard   React + Vite + shadcn/ui. One WebSocket via
                          BotProvider; react-query for commands/mutations.
```

Key files:
- `artifacts/api-server/src/lib/bot.ts` — BotManager: connection lifecycle,
  tasks, combat, mining, building, automation, chat commands
- `artifacts/api-server/src/lib/bot-data.ts` — game knowledge (ores, tiers,
  food, trees, hostiles)
- `artifacts/api-server/src/lib/bot-utils.ts` — task-cancellation tokens, helpers
- `artifacts/api-server/src/routes/bot.ts` — REST API (`/api/bot/*`)

### API endpoints

| Method & path | Purpose |
| --- | --- |
| `POST /api/bot/connect` `{host, port, username, version="auto", owner?}` | Connect the bot |
| `POST /api/bot/disconnect` | Disconnect (cancels auto-reconnect) |
| `GET /api/bot/status` | Full status snapshot (also streamed on `/ws`) |
| `POST /api/bot/command` | Run a command (see OpenAPI spec) |
| `POST /api/bot/control` | Manual movement/look state (control pad) |
| `GET/PUT /api/bot/settings` | Automation settings |
| `GET/DELETE /api/bot/logs` | Activity log |
| `GET /api/bot/inventory` | Inventory snapshot |
| `WS /ws` | Live stream: `status`, `log(s)`, `inventory`, `settings` |
| `/viewer/` | prismarine-viewer (proxied) |

## Development

```bash
pnpm run typecheck        # typecheck every package
pnpm run build            # typecheck + build API (esbuild) + dashboard (vite)
pnpm run smoke            # boot the built API and verify REST/WS/viewer proxy
pnpm --filter @workspace/api-spec run codegen   # after editing openapi.yaml
```

For a throwaway Minecraft server without Java, the bot was validated against
[flying-squid](https://github.com/PrismarineJS/flying-squid) (a JS server
implementation) in offline mode — handy for testing changes.

### Environment variables

| Variable | Where | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | api-server | — (required) | API/WS listen port |
| `VIEWER_PORT` | api-server | `3007` | Internal prismarine-viewer port (proxied) |
| `MINECONTROL_SETTINGS_FILE` | api-server | `./data/minecontrol-settings.json` | Where automation settings persist |
| `LOG_LEVEL` | api-server | `info` | pino log level |
| `PORT`, `BASE_PATH` | bot-dashboard | — (required) | Vite dev/preview port & base path |
| `API_PORT` | bot-dashboard | `5000` | API port for the Vite dev proxy |

## Safety notes

- The dashboard API has **no authentication** — anyone who can reach the port
  can control your bot. Keep it on localhost/your LAN, or behind a
  tunnel/VPN. Don't port-forward it to the open internet.
- Offline-mode bots can be impersonated by name — use this on servers you
  control or trust, and respect the rules of any server you join (many public
  servers ban bots/AFK alts).

## Troubleshooting

- **"Connection timed out"** — is the Minecraft server reachable from the
  machine running the API (check host/port/firewall) and set to offline mode?
- **Wrong version errors** — leave version on `auto`, or pin the exact server
  version (e.g. `1.20.1`).
- **Black live view** — hit Reload in the Live View panel; very new/old MC
  versions may not be supported by prismarine-viewer's renderer even though
  the bot itself works fine.
- **Bot mines nothing** — most ores are underground. Send the bot into a cave
  with Go To / manual control first. The log tells you if a better pickaxe is
  needed.
- **Bot keeps reconnecting** — slow/loaded servers can miss keepalive
  windows; MineControl reconnects automatically. Lower the viewer's load by
  disabling Live View in Automation settings if the host is weak.
