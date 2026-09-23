# ZamTest AI

ZamTest AI is a low-code, AI-native automation (RPA) platform, in the same space as UiPath, Automation Anywhere and TITA Automation.

| ZamTest AI | UiPath | Automation Anywhere | What it does |
|---|---|---|---|
| **Designer** (`apps/designer`) | Studio | Bot Creator | Visual, drag-and-drop workflow editor with AI assistance |
| **Portal** (`apps/portal`) | Orchestrator | Control Room | Processes, jobs, schedules, bot agents, assets and credentials |
| **Orchestrator API** (`apps/orchestrator`) | Orchestrator backend | Control Room backend | REST API that the Portal, Designer and agents talk to |
| **Bot Agent** (`apps/agent`) | Robot | Bot Runner / Bot Agent | Runs workflows on a machine, attended or unattended |
| **AI** (`packages/ai`) | Autopilot / Healing Agent | AARI / Generative AI | Selector suggestions, self-healing, workflow generation, AI agents |

## What works today (v0.1)

- **Visual Designer**: action palette, drag-and-drop canvas with nested containers (If / For Each / While / Try-Catch), a properties panel, variables and in/out arguments, undo/redo, design-time validation, JSON import/export, a test run on a live bot with a streaming log, and publishing versioned processes.
- **AI in the Designer**:
  - *Build with AI* generates a whole workflow from a plain-language description, or edits the current one. Output is checked against the workflow schema and the action catalog, and any errors go back to Claude to fix.
  - The *AI selector assistant* proposes robust selectors from a page's HTML and a plain-language description of the element.
- **AI at run time**:
  - *Self-healing selectors*: when a browser selector breaks, the bot sends a condensed DOM to Claude and tries each suggested replacement against the live page. It continues with the first one that matches exactly one element. The Portal and Designer show every healed selector, and the Designer can apply the fix with one click.
  - *AI actions*: **AI Prompt**, **AI Extract Data** (structured output validated against a JSON Schema) and **AI Agent**. The agent is given a goal and decides which platform actions to call (browser, HTTP, files) until the goal is met.
- **Portal**: dashboard, processes (start with inputs, target a specific agent), jobs (live logs, cancel, outputs, healed selectors), cron schedules with time zones, bot agent health, and assets/credentials (credentials are masked in the UI).
- **Bot Agent**: registers with the orchestrator, sends heartbeats, pulls jobs, streams logs, supports cancellation and reads assets. `run` mode executes a workflow file locally.
- **Actions**: control flow, log, assign, delay, JavaScript, get asset, HTTP, JSON, files, and browser automation through Playwright (open, navigate, click, type, get text, wait, screenshot, close).

## Quick start

Requires Node 20+ and pnpm 9+.

```bash
pnpm install
cp .env.example .env              # optional; set ANTHROPIC_API_KEY to enable AI features

# 1. Orchestrator API (http://127.0.0.1:4000)
pnpm dev:orchestrator

# 2. A bot agent (in another terminal)
pnpm dev:agent

# 3. The web apps
pnpm dev:portal                   # http://localhost:5173
pnpm dev:designer                 # http://localhost:5174
```

Next, open the Designer and create a workflow. Click **Run** to test it on your agent, then **Publish** it. In the Portal, go to **Processes** and click **Start**, or add a schedule.

Browser actions need Playwright browsers on the agent machine: `pnpm --filter @zamtest/agent exec playwright install chromium`. To use a Chromium that is already installed, set `ZAMTEST_BROWSER_EXECUTABLE=/path/to/chrome` instead.

### Run a workflow file without the orchestrator

```bash
pnpm --filter @zamtest/agent run-file ../../examples/hello-world.json
pnpm --filter @zamtest/agent run-file ../../examples/browser-login.json \
  --inputs "{\"url\":\"file://$PWD/examples/site/login.html\"}"
```

## AI configuration

AI features use Claude through the official Anthropic SDK:

- **Model**: `claude-opus-5` by default. Override it with `ZAMTEST_AI_MODEL`.
- **Refusal fallbacks**: server-side fallbacks (`fallbacks: "default"`) are turned on for models that support them.
- **Where to set the key**:
  - Set `ANTHROPIC_API_KEY` on the **orchestrator** to enable Build with AI and the selector assistant.
  - Set it on each **bot agent** to enable self-healing and the AI actions.

Without a key, every non-AI feature still works, and the AI buttons are disabled.

## Repository layout

```
packages/
  core/         Workflow schema (zod), action catalog, expression language, execution engine
  actions/   Runtime implementations: system, data, files, browser (Playwright), AI
  ai/           Claude integration: selectors, self-healing, workflow generation, extraction, agents
apps/
  orchestrator/ Fastify REST API, JSON-file persistence, cron scheduler
  agent/        Bot agent CLI (connect | run)
  portal/       React admin console
  designer/     React visual workflow designer
examples/       Sample workflows and a demo login page
docs/           Architecture and roadmap
```

## Development

```bash
pnpm typecheck     # all packages
pnpm test          # unit + API tests (set ZAMTEST_BROWSER_EXECUTABLE to also run the browser test)
pnpm build         # production builds of the web apps
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together, and [docs/ROADMAP.md](docs/ROADMAP.md) for what comes next.

## Security notes

These are MVP defaults. Read them before exposing the platform on a network.

- The orchestrator binds to `127.0.0.1` by default.
- Set `ZAMTEST_ADMIN_TOKEN` to require a bearer token for the Portal and Designer API.
- Set `ZAMTEST_AGENT_KEY` to replace the default agent key.
- Credential assets are stored **unencrypted** in `.data/db.json` for now. Encryption at rest and an external vault integration are on the roadmap.
- Workflow expressions and the *Run JavaScript* action run with the agent's permissions. Only let trusted automation developers publish processes.
