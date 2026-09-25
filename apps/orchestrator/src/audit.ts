/**
 * Audit log: who did what, when, from where - every change made through the
 * Portal, the Designer or the API, sign-ins (and failed ones), and exports.
 * Admins read it in the Portal and export it as CSV. Values are never kept:
 * no passwords, secrets or asset values, only which record and a few safe facts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parse } from "./errors.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { AuditEvent, Principal } from "./types.js";

/** Kept per workspace: the newest ones, for about a year. */
export const MAX_AUDIT_EVENTS = 20_000;
const KEEP_DAYS = 400;
/** The same person saving the same thing again within this time is one line (with a count). */
const MERGE_MS = 10 * 60 * 1000;

/** "METHOD /route" to "record.verb". Routes not listed here are not recorded (bots, AI, help, previews). */
const ACTIONS: Record<string, string> = {
  "POST /api/workflows": "workflow.create",
  "PUT /api/workflows/:id": "workflow.change",
  "DELETE /api/workflows/:id": "workflow.delete",
  "POST /api/workflows/:id/publish": "workflow.publish",
  "POST /api/workflows/:id/commit": "workflow.commit",
  "DELETE /api/packages/:id": "process.delete",
  "POST /api/packages/:id/promote": "process.promote",
  "POST /api/ci/publish": "process.publish",
  "POST /api/jobs": "job.run",
  "POST /api/jobs/:id/cancel": "job.cancel",
  "POST /api/jobs/:id/rerun": "job.rerun",
  "DELETE /api/jobs/:id": "job.delete",
  "POST /api/schedules": "schedule.create",
  "PUT /api/schedules/:id": "schedule.change",
  "DELETE /api/schedules/:id": "schedule.delete",
  "POST /api/schedules/:id/run": "schedule.run",
  "POST /api/assets": "asset.create",
  "PUT /api/assets/:id": "asset.change",
  "DELETE /api/assets/:id": "asset.delete",
  "POST /api/users": "user.create",
  "PUT /api/users/:id": "user.change",
  "DELETE /api/users/:id": "user.delete",
  "POST /api/users/:id/mfa/reset": "user.resetMfa",
  "POST /api/queues": "queue.create",
  "PUT /api/queues/:id": "queue.change",
  "DELETE /api/queues/:id": "queue.delete",
  "POST /api/queues/:id/items": "queueItem.create",
  "POST /api/queue-items/:id/retry": "queueItem.retry",
  "DELETE /api/queue-items/:id": "queueItem.delete",
  "DELETE /api/agents/:id": "pc.delete",
  "PUT /api/agents/:id/environment": "pc.change",
  "POST /api/enrollments/:code/approve": "pc.approve",
  "POST /api/enrollments/:code/deny": "pc.deny",
  "POST /api/admin/install-keys": "installKey.create",
  "DELETE /api/admin/install-keys/:id": "installKey.delete",
  "POST /api/api-tokens": "apiToken.create",
  "DELETE /api/api-tokens/:id": "apiToken.delete",
  "POST /api/promotions/:id/approve": "promotion.approve",
  "POST /api/promotions/:id/reject": "promotion.reject",
  "POST /api/promotions/:id/cancel": "promotion.cancel",
  "PUT /api/workspace": "workspace.change",
  "GET /api/workspace/export": "workspace.export",
  "PUT /api/workspace/security": "security.change",
  "PUT /api/workspace/sso": "sso.change",
  "PUT /api/workspace/alerts": "alerts.change",
  "POST /api/workspace/alerts/test": "alerts.test",
  "PUT /api/git/settings": "git.change",
  "DELETE /api/git/settings": "git.delete",
  "POST /api/git/pull": "git.pull",
  "PUT /api/cicd/settings": "cicd.change",
  "POST /api/test-cases": "testCase.create",
  "PUT /api/test-cases/:id": "testCase.change",
  "DELETE /api/test-cases/:id": "testCase.delete",
  "POST /api/test-folders": "testFolder.create",
  "PUT /api/test-folders/:id": "testFolder.change",
  "DELETE /api/test-folders/:id": "testFolder.delete",
  "POST /api/test-runs": "testRun.run",
  "POST /api/project/import": "project.import",
  "GET /api/project/export": "project.export",
  "POST /api/admin/backup": "backup.create",
  "POST /api/billing/checkout": "billing.checkout",
  "GET /api/audit/export.csv": "audit.export",
  // Sign-ins are recorded where they happen (app.ts), with how the person signed in.
  "POST /api/auth/logout": "session.signOut",
  "POST /api/auth/password": "account.changePassword",
  "POST /api/auth/mfa/enable": "account.enableMfa",
  "POST /api/auth/mfa/disable": "account.disableMfa",
  "POST /api/auth/mfa/recovery-codes": "account.newRecoveryCodes",
};

/** Body fields worth keeping as they are (never secrets). */
const SAFE_FIELDS = ["role", "disabled", "enabled", "environment", "to", "requireMfa", "idleTimeoutMinutes", "cron", "timezone", "requireApproval", "environments", "autoPublish", "jobFailed", "testRuns", "agentOffline", "plan"];
const SECRET = /pass|secret|token|value|key|credential|definition|code/i;

/** Records by the first part of the path, to name what was changed. */
const COLLECTIONS: Record<string, keyof Store["data"]> = {
  workflows: "workflows",
  packages: "packages",
  jobs: "jobs",
  schedules: "schedules",
  assets: "assets",
  users: "users",
  queues: "queues",
  "queue-items": "queueItems",
  agents: "agents",
  "test-cases": "testCases",
  "test-folders": "testFolders",
  "test-runs": "testRuns",
  "install-keys": "installKeys",
  "api-tokens": "apiTokens",
  promotions: "promotions",
};

declare module "fastify" {
  interface FastifyRequest {
    audit?: { targetId?: string; target?: string };
  }
}

type Named = { workspaceId?: string; name?: string; email?: string; reference?: string; version?: number; to?: string };

function nameOf(record: Named): string | undefined {
  if (record.version !== undefined && record.to) return `${record.name} v${record.version} → ${record.to}`;
  if (record.email) return record.name ? `${record.name} <${record.email}>` : record.email;
  return record.name ?? record.reference;
}

export interface AuditContext {
  store: Store;
  me(req: FastifyRequest): Principal;
  who(p: Principal): string;
}

/** Adds an event (or counts it into the same person's same change a moment ago). */
export function recordAudit(store: Store, event: Omit<AuditEvent, "id" | "at"> & { at?: string }): void {
  const list = (store.data.audit[event.workspaceId] ??= []);
  const at = event.at ?? nowIso();
  const last = list.at(-1);
  if (
    last &&
    last.actor === event.actor &&
    last.action === event.action &&
    last.targetId === event.targetId &&
    last.status === event.status &&
    event.action.endsWith(".change") &&
    Date.parse(at) - Date.parse(last.at) < MERGE_MS
  ) {
    last.at = at;
    last.count = (last.count ?? 1) + 1;
    if (event.details) last.details = { ...last.details, ...event.details };
  } else {
    list.push({ id: newId("aud"), at, ...event });
  }
  const oldest = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const drop = Math.max(list.length - MAX_AUDIT_EVENTS, list.findIndex((e) => e.at >= oldest));
  if (drop > 0) list.splice(0, drop);
  store.save();
}

export function registerAudit(app: FastifyInstance, ctx: AuditContext): void {
  const { store } = ctx;
  const actionOf = (req: FastifyRequest) => ACTIONS[`${req.method} ${req.routeOptions.url ?? ""}`];

  // Before the change: the record's name (it may be renamed or deleted by the request).
  app.addHook("preHandler", async (req) => {
    if (!actionOf(req)) return;
    const params = (req.params ?? {}) as { id?: string; code?: string };
    const workspaceId = req.principal?.workspaceId;
    if (params.code) {
      const e = Object.values(store.data.enrollments).find((x) => x.userCode === params.code);
      req.audit = { targetId: params.code, target: e?.name };
      return;
    }
    if (!params.id) return;
    const section = (req.routeOptions.url ?? "").split("/").filter(Boolean)[req.routeOptions.url?.startsWith("/api/admin/") ? 2 : 1] ?? "";
    const key = COLLECTIONS[section];
    const record = key ? ((store.data[key] as Record<string, Named>)[params.id] as Named | undefined) : undefined;
    req.audit = { targetId: params.id, target: record && (!workspaceId || record.workspaceId === workspaceId) ? nameOf(record) : undefined };
  });

  // Something created: its id and name, from the answer.
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload) => {
    if (req.audit?.targetId || reply.statusCode >= 400 || typeof payload !== "string" || payload.length > 200_000 || !actionOf(req)?.endsWith(".create")) return payload;
    try {
      const body = JSON.parse(payload) as Named & { id?: string; key?: { id?: string } };
      if (body && typeof body.id === "string") req.audit = { targetId: body.id, target: nameOf(body) };
    } catch {
      /* not JSON */
    }
    return payload;
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const action = actionOf(req);
    const principal = req.principal;
    // Done, or refused (not allowed); not requests with mistakes in them.
    const status = reply.statusCode;
    if (!action || !principal || (status >= 400 && status !== 403)) return;
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;

    const details: Record<string, unknown> = {};
    for (const field of SAFE_FIELDS) if (field in body && typeof body[field] !== "object") details[field] = body[field];
    if (req.method === "PUT" && !action.startsWith("workflow.") && !action.startsWith("testCase.")) {
      const changed = Object.keys(body).filter((k) => !SAFE_FIELDS.includes(k));
      if (changed.length) details.fields = changed.map((k) => (SECRET.test(k) ? `${k} (hidden)` : k)).slice(0, 20);
    }
    if (action.endsWith(".change") && typeof body.name === "string" && req.audit?.target && body.name !== req.audit.target) details.newName = body.name;

    recordAudit(store, {
      workspaceId: principal.workspaceId,
      actor: ctx.who(principal),
      actorKind: principal.kind,
      ip: req.ip,
      action,
      method: req.method,
      route: req.routeOptions.url ?? req.url.split("?")[0]!,
      targetId: req.audit?.targetId,
      target: req.audit?.target,
      status,
      details: Object.keys(details).length ? details : undefined,
    });
  });

  const Query = z.object({
    q: z.string().max(200).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    /** Page back: events before this time. */
    before: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  });
  const matching = (req: FastifyRequest) => {
    const q = parse(Query, req.query);
    const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const list = store.data.audit[ctx.me(req).workspaceId] ?? [];
    const out: AuditEvent[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (q.before && e.at >= q.before) continue;
      if (q.to && e.at > q.to) continue;
      if (q.from && e.at < q.from) break;
      if (words.length) {
        const text = `${e.actor} ${e.action} ${e.target ?? ""} ${e.targetId ?? ""} ${e.ip ?? ""}`.toLowerCase();
        if (!words.every((w) => text.includes(w))) continue;
      }
      out.push(e);
    }
    return { q, events: out };
  };

  app.get("/api/audit", async (req) => {
    const { q, events } = matching(req);
    return { events: events.slice(0, q.limit), more: events.length > q.limit };
  });

  app.get("/api/audit/export.csv", async (req, reply) => {
    const { events } = matching(req);
    const cell = (v: unknown) => {
      const s = v === undefined || v === null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [
      ["Time (UTC)", "Who", "Action", "Target", "Target id", "Result", "Times", "IP address", "Details", "Request"].join(","),
      ...events.map((e) =>
        [e.at, e.actor, e.action, e.target, e.targetId, e.status < 400 ? "done" : e.status === 401 ? "failed" : "refused", e.count ?? 1, e.ip, e.details, `${e.method} ${e.route}`].map(cell).join(","),
      ),
    ];
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="audit-log-${nowIso().slice(0, 10)}.csv"`)
      .send(`﻿${lines.join("\r\n")}\r\n`);
  });
}
