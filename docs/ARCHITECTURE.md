# Architecture

```
 ┌──────────────┐    ┌──────────────┐
 │   Designer   │    │    Portal    │        React SPAs (Vite)
 └──────┬───────┘    └──────┬───────┘
        │  REST /api/*      │  (optional Bearer ZAMTEST_ADMIN_TOKEN)
        ▼                   ▼
 ┌──────────────────────────────────────┐
 │            Orchestrator              │    Fastify
 │ workflows · packages · jobs · logs   │
 │ schedules (cron) · assets · agents   │──── Claude (Build with AI, selector assistant)
 │ JSON-file store (swap for Postgres)  │
 └──────────────────┬───────────────────┘
                    │  REST /api/agent/*  (x-agent-key)
                    │  register · heartbeat · jobs/next · events · complete · assets
        ┌───────────┴───────────┐
        ▼                       ▼
 ┌──────────────┐        ┌──────────────┐
 │  Bot Agent   │  ...   │  Bot Agent   │    Node process on each robot machine
 │ core engine  │        │              │──── Claude (self-healing, AI actions, AI agents)
 │ + actions    │        │              │──── Playwright browsers, HTTP, files
 │              │        │              │──── Windows apps (UI Automation, via PowerShell)
 └──────────────┘        └──────────────┘
```

## Workflow model (`packages/core`)

A workflow is JSON, validated with zod (`WorkflowSchema`):

```jsonc
{
  "schemaVersion": 1,
  "id": "invoice-bot",
  "name": "Invoice bot",
  "variables": [
    { "name": "invoices", "type": "array", "direction": "in" },
    { "name": "total", "type": "number", "direction": "out", "default": 0 }
  ],
  "root": {
    "id": "root", "type": "core.sequence", "props": {},
    "slots": { "body": [
      { "id": "s1", "type": "core.forEach", "props": { "items": "invoices", "itemVariable": "inv" },
        "slots": { "body": [
          { "id": "s2", "type": "core.assign", "props": { "variable": "total", "value": "total + inv.amount" } }
        ] } }
    ] }
  }
}
```

- **Steps** have a `type` that points at an action, some `props`, and named child `slots` for containers. A step can also carry the execution policies `retry`, `timeoutMs`, `continueOnError` and `disabled`.
- **Props** are resolved using the prop type from the catalog:
  - `expression` props are JavaScript expressions over variables.
  - String props support `{{ template }}` interpolation. A string that is exactly one `{{ x }}` keeps its type.
  - `variable` props name a variable.
- **Action metadata** (`BUILTIN_ACTIONS`) is pure data. The Designer uses it to render the palette and the properties panel, the AI uses it to plan workflows, and the engine uses it to resolve props and assign `output` variables.
- **The engine** (`runWorkflow`):
  - Executes control flow itself: sequence, if, forEach, while, tryCatch and break.
  - Delegates every leaf action to handlers.
  - Emits `stepStart`, `stepEnd`, `log` and `custom` events.
  - Honours an `AbortSignal` for cancellation.
  - Runs registered disposers at the end, for example to close a browser.

## Actions (`packages/actions`)

The handlers are grouped as follows:

| Group | Actions |
|---|---|
| `system` | `core.log`, `core.assign`, `core.delay`, `core.getAsset`, `core.runScript`, `core.throw` |
| `data` | HTTP, JSON, files |
| `browser` | Playwright (loaded lazily, so agents without browsers still work) |
| `desktop` | Windows desktop applications through Microsoft UI Automation (see below) |
| `ai` | AI Prompt, AI Extract Data, AI Agent |

An `ActionPackage` bundles metadata and handlers. This is the extension point for custom action packages (Excel, SAP, email, desktop UI...).

### AI self-healing

`browser.*` actions run through `withSelector()`. If the selector fails and AI is available (`aiHeal` defaults to true):

1. Capture a condensed DOM snapshot. Scripts, styles and SVG internals are dropped, and only semantic attributes are kept. The snapshot is capped at 150k characters, and Claude is told when it has been truncated.
2. Ask Claude for ranked replacement selectors, using structured JSON output. The request includes the step's plain-language `description`.
3. Check each candidate against the live page. A candidate is only used if it matches exactly one element.
4. Retry the action with the first candidate that passes. Log the change and emit a `selectorHealed` event.
5. The orchestrator stores healed selectors on the job. The Portal lists them, and the Designer offers **Apply fix**.

### Desktop automation (`packages/actions/src/desktop`)

Desktop actions run only on Windows agents:

- **Driver.** On first use, the agent starts `driver.ps1` with the built-in Windows PowerShell 5.1. It is one process per job and is closed with the job. Requests and responses are JSON lines over stdin/stdout.
- **What the script does.** It loads the .NET UI Automation client and compiles a small C# helper for real mouse clicks, DPI awareness and the recorder's low-level mouse/keyboard hooks. Nothing needs to be installed.
- **Selectors** (`selector.ts`) read like CSS: `window[process="notepad"] > menuitem[name="File"]`.
  - Segments are separated by `>`. Each segment is a control type (or `*`) with `[name|id|class|process op "value"]` attributes and an optional `[index=N]`.
  - Operators are `=`, `~=`, `^=` and `$=`, all case-insensitive.
  - The first segment matches top-level windows, and each later segment searches the descendants of the previous match.
  - The Node side parses selectors, so syntax errors are reported before anything runs.
- **Clicks** use UI Automation patterns first (Invoke, Toggle, SelectionItem, ExpandCollapse), so they work even when the window is covered. `mode: mouse` moves the real pointer instead.
- **Typing** uses ValuePattern and falls back to keystrokes (SendKeys).
- **Self-healing** mirrors the browser version:
  1. On "not found", the bot sends the window's UI Automation tree (at most 1,500 nodes) and the step description to Claude.
  2. It checks each suggested selector with `count == 1` before retrying.
  3. It then emits `selectorHealed`.
- **AI agents** get `desktop_*` tools plus `desktop_snapshot` on Windows agents.
- **Recorder** (`agent record-desktop`): hooks produce click, right-click, Enter and typed-value events with the element's ancestor chain. `selectorFromChain` turns each chain into a stable selector, preferring AutomationId, then Name, then ClassName, anchored on the window's process.
- **Testing without Windows:** the protocol and a static C# 5 compile check (against stub UI Automation types) run in CI with PowerShell 7 on Linux. The handlers and healing are tested with a fake driver.

### AI agents

`ai.agent` turns every catalog action marked `agentTool: true` into a Claude tool. The input schemas are derived from the actions' prop definitions. It also adds a `browser_snapshot` tool.

A manual agent loop in `packages/ai/src/agent.ts` runs tool calls one at a time, because UI actions must not race each other. The loop enforces `maxSteps`, supports cancellation, and logs every tool call to the job log.

## Orchestrator (`apps/orchestrator`)

| Entity | Notes |
|---|---|
| Workflow (draft) | Edited by the Designer |
| Package ("process") | Immutable, versioned snapshot created by **Publish** |
| Job | Status: `pending → running → succeeded / failed / cancelled` (with `cancelling` in between). Stores inputs, outputs, logs and healed selectors |
| Agent | `online / busy / offline`, derived from heartbeats. Jobs on an agent that stays silent for 2 minutes are failed |
| Schedule | Cron (croner) with an optional IANA time zone, inputs and a target agent |
| Asset | text / number / boolean / credential. Credentials are masked for the Portal and only returned in full to agents |

| Queue / item | Work queues. Items are `new → in-progress → successful / failed / business-exception`. A failed item goes back to `new` until the queue's retry limit is reached. Items locked by a job that ends are released as failed |
| User / session | Accounts with roles (admin, developer, operator, viewer). Only the SHA-256 of each session token is stored, and passwords are stored as scrypt hashes |

Persistence is a debounced, atomic JSON file (`ZAMTEST_DATA_DIR/db.json`) behind the small `Store` class. That class is the seam for moving to Postgres.

### Agent protocol

| Endpoint | Purpose |
|---|---|
| `POST /api/agent/register` | Returns an `agentId`. Re-registration fails jobs that were running on the agent before it restarted |
| `POST /api/agent/heartbeat` | Every 10 s. The response lists jobs to cancel |
| `POST /api/agent/jobs/next` | Pull model, FIFO. Respects `targetAgentId`. Returns 204 when there is no work |
| `POST /api/agent/jobs/:id/events` | Batched engine events (about 1 s). The response can request cancellation |
| `POST /api/agent/jobs/:id/complete` | Final status and outputs |
| `GET /api/agent/assets/:name` | Used by the Get Asset action |
| `POST /api/agent/queues/:name/items` | Add Queue Item |
| `POST /api/agent/queues/:name/next` | Get Next Queue Item: locks the oldest `new` item for the job, or returns 204 |
| `POST /api/agent/queue-items/:id/complete` | Set Queue Item Result: records successful, failed (retried) or business-exception |

Agents use a pull model, so they only need outbound HTTPS to the orchestrator and work behind NAT and firewalls.
