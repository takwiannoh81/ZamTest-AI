/**
 * Alerts: a message when something needs attention - a process run failed, a
 * scheduled or pipeline test run finished with failures, a PC stopped answering,
 * a schedule could not start. By email, in Slack and in Microsoft Teams.
 * Runs someone watches (Designer try-outs, test runs they started) send nothing.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, parse } from "./errors.js";
import type { Mail, Mailer } from "./mailer.js";
import type { ScreenshotStore } from "./screenshots.js";
import type { Store } from "./store.js";
import type { Agent, Job, Principal, Schedule, TestRun, Workspace, WorkspaceAlerts } from "./types.js";

export interface AlertsOptions {
  store: Store;
  mailer: Mailer | null;
  screenshots: ScreenshotStore;
  portalUrl: string;
  designerUrl: string;
  log: (message: string) => void;
  /** Tests catch the Slack and Teams calls. */
  fetch?: typeof fetch;
}

/** One alert, in words every channel can show. */
export interface Alert {
  workspaceId: string;
  kind: "jobFailed" | "testRun" | "agentOffline" | "scheduleFailed" | "test";
  /** Failure or all good (a test run that passed). */
  ok: boolean;
  title: string;
  lines: string[];
  link?: { label: string; url: string };
  /** The failed step's screen (email only). */
  screenshot?: Buffer;
}

/** At most this many alerts per workspace an hour, so a broken schedule every minute does not flood anyone. */
const MAX_PER_HOUR = 30;

const SLACK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+$/;
const TEAMS_HOSTS = [".webhook.office.com", ".logic.azure.com", ".powerplatform.com", ".powerautomate.com"];

/** Slack and Teams webhooks only: they carry their own secret, and nothing else on the internet is called. */
export function checkWebhook(kind: "slack" | "teams", value: string): string {
  const url = value.trim();
  if (kind === "slack") {
    if (!SLACK.test(url)) throw new HttpError(400, "A Slack address looks like https://hooks.slack.com/services/... (Slack: Apps, Incoming Webhooks)");
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "That is not a web address");
  }
  if (parsed.protocol !== "https:" || !TEAMS_HOSTS.some((h) => parsed.hostname.endsWith(h))) {
    throw new HttpError(400, "A Teams address comes from Teams: the channel's ... menu, Workflows, \"Post to a channel when a webhook request is received\"");
  }
  return url;
}

/** What a workspace gets when its admin has not chosen yet: failures to its admins by email. */
export function alertSettings(store: Store, workspace: Workspace): WorkspaceAlerts {
  if (workspace.alerts) return workspace.alerts;
  const admins = Object.values(store.data.users)
    .filter((u) => u.workspaceId === workspace.id && u.role === "admin" && !u.disabled && u.emailVerified !== false)
    .map((u) => u.email);
  return { emails: admins, jobFailed: true, testRuns: "failures", agentOffline: false };
}

const mask = (url: string | undefined) => (url ? `${url.slice(0, url.indexOf("/", 8) + 1)}…${url.slice(-4)}` : undefined);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class Alerts {
  private sent = new Map<string, number[]>();
  private readonly post: typeof fetch;

  constructor(private readonly o: AlertsOptions) {
    this.post = o.fetch ?? fetch;
  }

  /** A process run that failed (Designer try-outs and tests are watched by someone, or reported per run). */
  jobFinished(job: Job): void {
    if (job.status !== "failed" || job.source === "designer" || job.source === "test") return;
    const workspace = this.o.store.data.workspaces[job.workspaceId];
    if (!workspace || !alertSettings(this.o.store, workspace).jobFailed) return;
    const agent = job.agentId ? this.o.store.data.agents[job.agentId] : undefined;
    const schedule = job.scheduleId ? this.o.store.data.schedules[job.scheduleId] : undefined;
    const failedStep = this.failedStepOf(job);
    void this.send({
      workspaceId: job.workspaceId,
      kind: "jobFailed",
      ok: false,
      title: `${job.name} failed`,
      lines: [
        job.error ? `Error: ${job.error}` : "It failed without a message.",
        ...(failedStep ? [`Step: ${failedStep}`] : []),
        `Started by: ${schedule ? `the schedule "${schedule.name}"` : (job.startedBy ?? job.source)}`,
        ...(agent ? [`PC: ${agent.name}`] : []),
        `When: ${job.finishedAt ?? job.createdAt} (UTC)`,
      ],
      link: { label: "Open the job (logs, screenshots, Fix with AI)", url: `${this.o.portalUrl}/#/jobs/${job.id}` },
      screenshot: this.errorScreenshot(job.id),
    });
  }

  /** A test run started by a schedule or a pipeline finished. */
  testRunFinished(run: TestRun): void {
    if (run.source === "person" || !run.source) return;
    const workspace = this.o.store.data.workspaces[run.workspaceId];
    if (!workspace) return;
    const when = alertSettings(this.o.store, workspace).testRuns;
    const failed = run.items.filter((i) => i.result?.status !== "passed");
    if (when === "off" || (when === "failures" && !failed.length)) return;
    const total = run.items.length;
    const label = (i: TestRun["items"][number]) => `${i.path ? `${i.path} / ` : ""}${i.name}${i.row ? ` (row ${i.row}${i.rowLabel ? `: ${i.rowLabel}` : ""})` : ""}`;
    const firstFailedJob = failed.find((i) => i.jobId)?.jobId;
    void this.send({
      workspaceId: run.workspaceId,
      kind: "testRun",
      ok: !failed.length,
      title: failed.length ? `${failed.length} of ${total} tests failed: ${run.name}` : `All ${total} tests passed: ${run.name}`,
      lines: [
        `Started by: ${run.startedBy}`,
        ...failed.slice(0, 10).map((i) => `✕ ${label(i)}${i.result?.message ? ` - ${i.result.message.slice(0, 200)}` : ""}`),
        ...(failed.length > 10 ? [`... and ${failed.length - 10} more`] : []),
      ],
      link: { label: "Open the report", url: `${this.o.portalUrl}/#/test-reports?run=${run.id}` },
      screenshot: firstFailedJob ? this.errorScreenshot(firstFailedJob) : undefined,
    });
  }

  agentOffline(agent: Agent): void {
    const workspace = this.o.store.data.workspaces[agent.workspaceId];
    if (!workspace || !alertSettings(this.o.store, workspace).agentOffline) return;
    void this.send({
      workspaceId: agent.workspaceId,
      kind: "agentOffline",
      ok: false,
      title: `${agent.name} is offline`,
      lines: [`The PC ${agent.machine || agent.name} stopped answering at ${agent.lastHeartbeat} (UTC).`, "Jobs for it wait until it is back: check that the PC is on and the ZamTech AI Agent is running."],
      link: { label: "Open Bot Agents", url: `${this.o.portalUrl}/#/agents` },
    });
  }

  scheduleFailed(schedule: Schedule, message: string): void {
    const workspace = this.o.store.data.workspaces[schedule.workspaceId];
    if (!workspace) return;
    const settings = alertSettings(this.o.store, workspace);
    if (schedule.tests ? settings.testRuns === "off" : !settings.jobFailed) return;
    void this.send({
      workspaceId: schedule.workspaceId,
      kind: "scheduleFailed",
      ok: false,
      title: `The schedule "${schedule.name}" could not start`,
      lines: [message],
      link: { label: "Open Schedules", url: `${this.o.portalUrl}/#/schedules` },
    });
  }

  /** Sends to every channel; says per channel whether it worked (for "Send a test alert"). */
  async send(alert: Alert, settingsOverride?: WorkspaceAlerts): Promise<Record<"email" | "slack" | "teams", string | undefined>> {
    const result: Record<"email" | "slack" | "teams", string | undefined> = { email: undefined, slack: undefined, teams: undefined };
    const workspace = this.o.store.data.workspaces[alert.workspaceId];
    if (!workspace) return result;
    if (alert.kind !== "test" && !this.allowed(alert.workspaceId)) {
      this.o.log(`Alerts: ${workspace.name} reached ${MAX_PER_HOUR} alerts this hour; "${alert.title}" was not sent`);
      return result;
    }
    const settings = settingsOverride ?? alertSettings(this.o.store, workspace);
    const tasks: Array<Promise<void>> = [];
    const attempt = (channel: keyof typeof result, task: () => Promise<void>) =>
      tasks.push(
        task().then(
          () => void (result[channel] = "sent"),
          (err: Error) => {
            result[channel] = err.message;
            this.o.log(`Alerts: ${channel} for ${workspace.name} failed: ${err.message}`);
          },
        ),
      );
    if (settings.emails.length) {
      if (!this.o.mailer) result.email = "Email is not set up on this server";
      else for (const to of settings.emails) attempt("email", () => this.o.mailer!.send({ to, ...this.email(alert, workspace) }));
    }
    if (settings.slackUrl) attempt("slack", () => this.call(settings.slackUrl!, this.slack(alert)));
    if (settings.teamsUrl) attempt("teams", () => this.call(settings.teamsUrl!, this.teams(alert)));
    await Promise.all(tasks);
    return result;
  }

  sendTest(workspaceId: string, settings: WorkspaceAlerts) {
    return this.send(
      {
        workspaceId,
        kind: "test",
        ok: true,
        title: "Test alert from ZamTech AI",
        lines: ["Alerts work: failed runs will be reported here."],
        link: { label: "Open the Portal", url: this.o.portalUrl },
      },
      settings,
    );
  }

  private allowed(workspaceId: string): boolean {
    const now = Date.now();
    const recent = (this.sent.get(workspaceId) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    if (recent.length >= MAX_PER_HOUR) return false;
    recent.push(now);
    this.sent.set(workspaceId, recent);
    return true;
  }

  private async call(url: string, body: unknown): Promise<void> {
    const res = await this.post(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim());
  }

  private email(alert: Alert, workspace: Workspace): Omit<Mail, "to"> {
    const icon = alert.ok ? "✅" : "❌";
    const text = [`${alert.title}`, "", ...alert.lines, "", ...(alert.link ? [`${alert.link.label}: ${alert.link.url}`, ""] : []), `ZamTech AI · ${workspace.name}`, `Change who gets alerts: ${this.o.portalUrl}/#/settings`].join("\n");
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1f2330;max-width:640px">
<h2 style="margin:0 0 12px;font-size:18px">${icon} ${escapeHtml(alert.title)}</h2>
${alert.lines.map((l) => `<p style="margin:4px 0">${escapeHtml(l)}</p>`).join("\n")}
${alert.link ? `<p style="margin:18px 0"><a href="${escapeHtml(alert.link.url)}" style="background:#6d5dfc;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none">${escapeHtml(alert.link.label)}</a></p>` : ""}
${alert.screenshot ? `<p style="margin:12px 0 4px;color:#666">The screen when it failed:</p><img src="cid:failed-step" alt="" style="max-width:100%;border:1px solid #ddd;border-radius:4px">` : ""}
<p style="margin-top:24px;color:#888;font-size:12px">ZamTech AI · ${escapeHtml(workspace.name)} · <a href="${escapeHtml(`${this.o.portalUrl}/#/settings`)}" style="color:#888">Change who gets alerts</a></p>
</div>`;
    return {
      subject: `${icon} ${alert.title}`,
      text,
      html,
      attachments: alert.screenshot ? [{ filename: "failed-step.jpg", content: alert.screenshot, contentType: "image/jpeg", cid: "failed-step" }] : undefined,
    };
  }

  private slack(alert: Alert) {
    const icon = alert.ok ? ":white_check_mark:" : ":x:";
    const text = [`${icon} *${alert.title}*`, ...alert.lines, ...(alert.link ? [`<${alert.link.url}|${alert.link.label}>`] : [])].join("\n");
    return { text };
  }

  /** An Adaptive Card, as Teams Workflows ("when a webhook request is received") expects. */
  private teams(alert: Alert) {
    return {
      type: "message",
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", size: "Medium", weight: "Bolder", wrap: true, color: alert.ok ? "Good" : "Attention", text: `${alert.ok ? "✅" : "❌"} ${alert.title}` },
              ...alert.lines.map((l) => ({ type: "TextBlock", wrap: true, spacing: "Small", text: l })),
            ],
            actions: alert.link ? [{ type: "Action.OpenUrl", title: alert.link.label, url: alert.link.url }] : [],
          },
        },
      ],
    };
  }

  private failedStepOf(job: Job): string | undefined {
    const logs = this.o.store.data.jobLogs[job.id] ?? [];
    const stepId = [...logs].reverse().find((l) => l.level === "error" && l.stepId && l.stepId !== "root")?.stepId;
    if (!stepId) return undefined;
    const find = (step: Job["definition"]["root"]): string | undefined => {
      if (step.id === stepId) return step.label || step.type;
      for (const children of Object.values(step.slots ?? {})) for (const c of children) {
        const found = find(c);
        if (found) return found;
      }
      return undefined;
    };
    return find(job.definition.root) ?? stepId;
  }

  private errorScreenshot(jobId: string): Buffer | undefined {
    try {
      const shots = this.o.screenshots.list(jobId);
      const shot = [...shots].reverse().find((s) => s.status === "error") ?? shots.at(-1);
      return shot ? this.o.screenshots.read(jobId, shot.seq) : undefined;
    } catch {
      return undefined;
    }
  }
}

const AlertsBody = z.object({
  emails: z.array(z.string().trim().toLowerCase().email("One of the email addresses is not valid")).max(50),
  /** null: remove; unset: keep. */
  slackUrl: z.string().max(500).nullish(),
  teamsUrl: z.string().max(2000).nullish(),
  jobFailed: z.boolean(),
  testRuns: z.enum(["failures", "always", "off"]),
  agentOffline: z.boolean(),
});

export function registerAlerts(
  app: FastifyInstance,
  ctx: { store: Store; alerts: Alerts; me(req: FastifyRequest): Principal; requireAdmin(req: FastifyRequest): void; emailReady: boolean },
): void {
  const workspaceOf = (req: FastifyRequest) => {
    const workspace = ctx.store.data.workspaces[ctx.me(req).workspaceId];
    if (!workspace) throw new HttpError(404, "Workspace not found");
    return workspace;
  };
  const view = (workspace: Workspace) => {
    const { slackUrl, teamsUrl, ...rest } = alertSettings(ctx.store, workspace);
    return { ...rest, slack: mask(slackUrl), teams: mask(teamsUrl), chosen: Boolean(workspace.alerts), emailReady: ctx.emailReady };
  };

  app.get("/api/workspace/alerts", async (req) => {
    ctx.requireAdmin(req);
    return view(workspaceOf(req));
  });

  app.put("/api/workspace/alerts", async (req) => {
    ctx.requireAdmin(req);
    const workspace = workspaceOf(req);
    const body = parse(AlertsBody, req.body);
    const current = alertSettings(ctx.store, workspace);
    const url = (kind: "slack" | "teams", value: string | null | undefined, old: string | undefined) =>
      value === undefined ? old : value === null || !value.trim() ? undefined : checkWebhook(kind, value);
    workspace.alerts = {
      emails: [...new Set(body.emails)],
      slackUrl: url("slack", body.slackUrl, current.slackUrl),
      teamsUrl: url("teams", body.teamsUrl, current.teamsUrl),
      jobFailed: body.jobFailed,
      testRuns: body.testRuns,
      agentOffline: body.agentOffline,
    };
    ctx.store.save();
    return view(workspace);
  });

  /** Sends a sample alert to every channel now, and says what happened on each. */
  app.post("/api/workspace/alerts/test", async (req) => {
    ctx.requireAdmin(req);
    const workspace = workspaceOf(req);
    const settings = alertSettings(ctx.store, workspace);
    if (!settings.emails.length && !settings.slackUrl && !settings.teamsUrl) throw new HttpError(400, "Add an email address, Slack or Teams first");
    return ctx.alerts.sendTest(workspace.id, settings);
  });
}
