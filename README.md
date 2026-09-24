# ZamTech AI

ZamTech AI is a low-code, AI-native automation (RPA) platform, in the same space as UiPath, Automation Anywhere and TITA Automation.

| ZamTech AI | UiPath | Automation Anywhere | What it does |
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
- **Actions**:
  - **Control flow and basics:** control flow, log, assign, delay, JavaScript, get asset, HTTP, JSON and files.
  - **Browser:** automation through Playwright: open, navigate, click, type, select option, get text, wait, screenshot, close.
  - **Desktop (Windows):** automates desktop applications through Microsoft UI Automation: start application, click, type, send keys, get text, select item, read table, wait, screenshot, close window.
    - **Selectors** look like `window[process="notepad"] > menuitem[name="File"]`.
    - **Self-healing:** broken selectors are healed by AI, as they are in the browser.
    - **Requirements:** a Windows bot agent running in a signed-in session. No extra software is needed.
  - **Excel & CSV:** read and write `.xlsx` sheets and CSV files.
  - **Email:** send over SMTP and read over IMAP, with attachments. The password comes from a credential asset.
  - **PDF:** read text, which pairs well with **AI Extract Data**, and merge files.
  - **Work queues:** add, take and complete items.
- **Work queues**: queues of work items (for example one per invoice) that bots process one at a time.
  - **Retries:** failed items are retried automatically. Business exceptions (bad data) are not retried.
  - **Duplicates:** a duplicate reference is rejected.
  - **Crashed jobs:** items locked by a job that crashed go back into the queue.
  - **Management:** the Portal has a **Queues** page for managing them.
- **Recorder**: run `pnpm --filter @zamtest/agent exec tsx src/cli.ts record https://your-app` on your own computer and click through the process once. For Windows applications, use `record-desktop [program.exe]` instead. `desktop-test` checks that desktop automation works on a machine.
  - **Output:** the recorder writes the workflow for you, with robust selectors and descriptions that AI self-healing can use.
  - **Passwords:** anything typed into a password field is never stored.
  - **Upload:** `--upload` sends the workflow straight to the Designer.

## Languages

The Portal and Designer are available in 14 languages:

English, 日本語 (Japanese), 简体中文 (Simplified Chinese), Français (French), Español (Spanish), Português (Brasil) (Brazilian Portuguese), Deutsch (German), Nederlands (Dutch), Русский (Russian), Tiếng Việt (Vietnamese), ไทย (Thai), Afrikaans, Kiswahili (Swahili) and العربية (Arabic).

- **What is translated:** the whole UI, plus the action catalog: action names, descriptions, categories and property labels.
- **Choosing a language:** the app picks the browser's language automatically. Users can change it in the Designer toolbar, or in the Portal sidebar and Settings page. The choice is remembered per browser.
- **Dates and times** follow the selected language.
- **Right-to-left:** in Arabic the whole layout mirrors (sidebar, panels, arrows, text alignment). Code, selectors, JSON and logs stay left-to-right so they remain readable.
- **AI answers in the selected language:** Build with AI writes its notes, step labels and log messages in that language, and the selector assistant explains its suggestions in it. Code identifiers (action types, variable names, selectors) stay in ASCII.
- **Adding a language:** see [packages/i18n/README.md](packages/i18n/README.md).

## Production

The platform is set up to run on **zamtechai.com**: the website on the main domain, plus the `portal.`, `designer.` and `api.` subdomains, with automatic HTTPS. Deploying it takes one Docker Compose command. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

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
pnpm --filter @zamtest/website dev # public website, http://localhost:5175
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
  i18n/         Translations (14 languages) for the UI and the action catalog
  core/         Workflow schema (zod), action catalog, expression language, execution engine
  actions/      Runtime implementations: system, data, files, browser (Playwright), desktop (Windows UI Automation), Excel, email, PDF, queues, AI
  ai/           Claude integration: selectors, self-healing, workflow generation, extraction, agents
apps/
  orchestrator/ Fastify REST API, JSON-file persistence, cron scheduler
  agent/        Bot agent CLI (connect | run)
  portal/       React admin console
  designer/     React visual workflow designer
  website/      Public marketing website (zamtechai.com)
deploy/         Dockerfile, Caddyfile and Docker Compose stack for production
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
- Set `ZAMTEST_ADMIN_TOKEN` to enable the master access token, then create personal accounts with roles (Admin, Developer, Operator, Viewer) under **Users** in the Portal. Once any account exists, the API requires sign-in.
- Bot agents connect with their own credential, issued when a Developer or Admin approves the PC in the Portal (or by an admin's install key); removing an agent revokes it. The shared `ZAMTEST_AGENT_KEY` still works for the cloud bot and older installs; in production, leave it unset to allow only approved PCs.
- People sign in only in the Portal; the Designer shares that sign-in through an HttpOnly cookie (`ZAMTEST_COOKIE_DOMAIN`). Changes sent with the cookie must carry the `x-zamtech-client` header, which other sites cannot add.
- Credential assets are stored **unencrypted** in `.data/db.json` for now. Encryption at rest and an external vault integration are on the roadmap. User passwords are stored only as scrypt hashes.
- Nightly encrypted backups to S3 are built in; see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Workflow expressions and the *Run JavaScript* action run with the agent's permissions. Only let trusted automation developers publish processes.
