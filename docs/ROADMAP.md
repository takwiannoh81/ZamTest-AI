# Roadmap

v0.1 is a working vertical slice: Designer → Orchestrator → Bot Agent, with AI built in. Below is a suggested order for the next milestones.

## v0.2: Production foundations
- Postgres persistence (behind `Store`) and migrations. Keep job logs in a separate table or object storage.
- Tenants/folders on top of the existing user roles, SSO through OIDC/SAML, and multi-factor authentication.
- Per-machine agent keys created in the Portal, in place of the shared key. Add mTLS as an option.
- Encrypted credential assets (envelope encryption) and connectors for HashiCorp Vault, Azure Key Vault and CyberArk.
- WebSocket/SSE push for job logs and agent commands, in place of polling.
- Audit log for every change to processes, schedules, assets and users.

## v0.3: Richer automation
- **Queues and work items**: transactions, retries, SLAs and dispatcher/performer patterns.
- **Invoke Workflow**: reusable libraries and sub-workflows with arguments.
- **Action packages**: install them on agents, give them versions and dependencies, and publish them to a feed. Planned packages:
  - Excel/CSV
  - Email (IMAP/SMTP, Microsoft Graph, Gmail)
  - PDF and OCR
  - Databases
  - SFTP
  - Office 365
  - SAP GUI scripting
- **Desktop UI automation** (Windows UI Automation actions and the desktop recorder are done in v0.1):
  - Java Access Bridge
  - Citrix/image-based automation with AI vision (Claude computer use)
- **Recorder**: capture browser clicks and typing into steps, with AI-generated descriptions and selectors.
- **Debugger** in the Designer: breakpoints, step over, variable inspection, and running from a chosen step.
- Parallel branches, a state-machine/flowchart canvas, and triggers (webhook, file watcher, email, queue).

## v0.4: AI-native features
- **AI agent designer**: goals, guardrails, tool allow-lists, human-in-the-loop approvals and memory.
- **Document understanding**: classify, extract and validate, with an action center for human review.
- Proactive self-healing: when a selector is healed often, open a Designer suggestion or PR automatically.
- Explain a failed job: AI root-cause analysis of logs, screenshots and the DOM at the point of failure.
- Process discovery: suggest automations from task recordings or event logs.
- Run AI evals on generated workflows and on healing accuracy (see `packages/ai`).

## v0.5: Scale and operations
- Horizontal scaling of the orchestrator, with a Redis/NATS job queue.
- Agent pools, machine templates, autoscaling cloud robots and high-density robots.
- Metrics and dashboards (Prometheus/OpenTelemetry), SLA alerts and webhooks.
- Helm chart and Docker images. (The Windows agent installer with a tray app is done in v0.1; unattended PCs use Windows automatic sign-in, see docs/DEPLOYMENT.md.)
