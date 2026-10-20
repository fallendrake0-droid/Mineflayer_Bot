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
- **AI brain (optional LLM)** — give goals in plain English ("mine 10 iron
  and bring it to me"), let it play on **autopilot** like a real player, and
  watch it **write its own JavaScript skills** (sandboxed, saved to a
  library) for tasks beyond its built-in commands. See below.

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
| `!ai <goal>` | Give the AI brain a goal in plain English (needs AI configured) |
| `!auto [on\|off]` | Toggle AI autopilot (self-chosen goals) |

If the whitelist is empty, **everyone** can use chat commands — set your
username in the connect form (stored as a setting) to restrict it.

## AI brain (optional LLM)

MineControl can use a large language model as the bot's brain — the
["Voyager"](https://voyager.minedojo.org/) pattern:

- **Goals** — type what you want in the dashboard's **AI BRAIN** panel or
  with `!ai <goal>` in game ("chop 3 oaks, then build a shelter"). The AI
  plans steps, runs them with the bot's built-in abilities, looks at the
  results, and replans until the goal is done.
- **Autopilot** — flip it on and the AI picks its own goals like a real
  survival player (food, wood, tools, shelter before night…). `!auto`,
  the panel switch, or STOP turns it off.
- **Self-written skills** — when built-in commands aren't enough, the AI
  writes JavaScript skills for itself. They run in a sealed sandbox (bot
  control only — no files, network, or app access), are screened for
  dangerous code, and successful ones are saved to a library you can
  inspect/delete in the panel. The AI reuses and improves them over time.

### Setup

1. Get a free API key: [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
   → **Create API key** (Google Gemini, no card needed). Any
   OpenAI-compatible provider works (OpenAI, OpenRouter, local Ollama…).
2. Paste it into the dashboard's **AI BRAIN** panel (stored server-side in
   `data/ai-config.json`, never sent back to the browser) — or set env vars
   instead: `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`.
3. Connect the bot and give it a goal!

### Run it fully local with Ollama (free — no key, no tokens)

The brain can run on a model on your own machine instead of a cloud API:

1. Install [Ollama](https://ollama.com) and pull
   a model that fits your RAM. 7–8B models need ~5 GB free
   (`ollama pull llama3.1:8b`; better code skills: `qwen2.5-coder:7b`) —
   low-memory machines (most Chromebooks) will crash them with
   "out of memory", so use a 1–3B model there (~2 GB):
   `ollama pull llama3.2:3b` or `ollama pull qwen2.5-coder:3b`.
2. Make sure it's serving: `ollama serve` (usually already running).
3. In the dashboard **AI BRAIN** panel click **OLLAMA · LOCAL**, then
   **Load models** to pick an installed model → **Save**. No API key
   needed for local/LAN endpoints. (Or env vars:
   `AI_BASE_URL=http://localhost:11434/v1 AI_MODEL=llama3.2:3b`.)

Local endpoints get a longer timeout (CPU inference is slow) and transient
provider errors (HTTP 429/5xx, network blips) auto-retry. Speed/smarts
depend on your hardware: on a CPU-only Chromebook an 8B model may take a
minute or more per planning step — a 3B model (`llama3.2:3b`) is much
faster but plans worse. **No-NPC-server tip:** cloud keys are never deleted
when switching presets, so you can flip between local and cloud freely.

Settings live in **AUTOMATION**: `AI brain` (master switch) and `AI chat`
(owners can talk to the AI in plain chat instead of `!ai`).

### Costs & safety

- Each planning step is one API call; cheap/fast models (Gemini Flash,
  GPT-4o-mini) cost pennies per session. Autopilot keeps calling until
  stopped — watch usage in the panel.
- The key lives only in env vars or `data/ai-config.json` on the machine
  running the API. Never commit it.
- AI code runs sandboxed with timeouts and a working STOP — but it fully
  controls the bot in-game, and it *will* make mistakes. Supervise it on
  servers you care about.

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
