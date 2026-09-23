import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AiClient, AiNotConfiguredError, AiRefusalError, ZamAI } from "@zamtest/ai";
import { BUILTIN_ACTIONS, WorkflowSchema } from "@zamtest/core";
import { languageName } from "@zamtest/i18n";
import type { EngineEvent } from "@zamtest/core";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  hasRole,
  LoginLimiter,
  MIN_PASSWORD_LENGTH,
  pruneSessions,
  publicUser,
  requiredRole,
  resolvePrincipal,
  safeEqual,
  verifyPassword,
} from "./auth.js";
import type { BackupService } from "./backup.js";
import type { OrchestratorConfig } from "./config.js";
import { createJob, finishJob, HttpError, isFinal, sweep } from "./jobs.js";
import { addItem, completeItem, FINAL_ITEM_STATUSES, findQueue, queueCounts, takeNext } from "./queues.js";
import { Scheduler, validateCron } from "./scheduler.js";
import { newId, nowIso, Store } from "./store.js";
import type { Agent, Asset, Job, Package, Principal, Queue, QueueItem, Schedule, User, WorkflowDraft } from "./types.js";
import { ROLES } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AppOptions {
  config: OrchestratorConfig;
  store?: Store;
  /** Inject an AI facade (tests); defaults to a real client when an API key is configured. */
  ai?: ZamAI | null;
  logger?: boolean;
  /** Nightly S3 backups; null/undefined when not configured. */
  backup?: BackupService | null;
}


function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  }
  return result.data;
}

function maskAsset(asset: Asset): Asset {
  if (asset.type !== "credential") return asset;
  const value = (asset.value ?? {}) as { username?: string };
  return { ...asset, value: { username: value.username ?? "", password: "********" } };
}

function jobSummary(job: Job) {
  const { definition: _definition, ...rest } = job;
  return rest;
}

const WorkflowBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  definition: WorkflowSchema.optional(),
});

const JobBody = z.object({
  packageId: z.string().optional(),
  definition: WorkflowSchema.optional(),
  inputs: z.record(z.unknown()).optional(),
  targetAgentId: z.string().optional(),
  source: z.enum(["manual", "designer", "api"]).default("manual"),
});

const ScheduleBody = z.object({
  name: z.string().min(1),
  packageId: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  inputs: z.record(z.unknown()).default({}),
  targetAgentId: z.string().optional(),
  enabled: z.boolean().default(true),
});

const AssetBody = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/, "Use letters, digits, '.', '_' or '-'"),
  type: z.enum(["text", "number", "boolean", "credential"]),
  value: z.unknown(),
  description: z.string().optional(),
});

export async function buildApp(options: AppOptions): Promise<{ app: FastifyInstance; store: Store; scheduler: Scheduler }> {
  const { config } = options;
  const store = options.store ?? new Store(config.dataDir);
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 10 * 1024 * 1024, trustProxy: config.production });
  const scheduler = new Scheduler(store, (msg) => app.log.info(msg));
  let ai: ZamAI | null | undefined = options.ai;
  const getAi = () => {
    if (ai === undefined) ai = AiClient.isConfigured() ? new ZamAI() : null;
    if (!ai) throw new AiNotConfiguredError();
    return ai;
  };

  await app.register(cors, { origin: config.corsOrigins });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, ...(err.statusCode === 403 ? { code: "forbidden" } : {}) });
    }
    if (err instanceof AiNotConfiguredError) return reply.status(503).send({ error: err.message });
    if (err instanceof AiRefusalError) return reply.status(422).send({ error: err.message });
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: err.message });
  });

  /* ------------------------------ auth ------------------------------ */
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/") || url === "/api/health") return;
    if (url.startsWith("/api/agent/")) {
      const key = String(req.headers["x-agent-key"] ?? "");
      if (!safeEqual(key, config.agentKey)) return reply.status(401).send({ error: "Invalid agent key" });
      return;
    }
    if (url === "/api/auth/login") return;
    const principal = resolvePrincipal(store, config.adminToken, req.headers.authorization);
    if (!principal) return reply.status(401).send({ error: "Sign in required", code: "unauthorized" });
    req.principal = principal;
    if (url.startsWith("/api/auth/")) return;
    const needed = requiredRole(req.method, url);
    if (!hasRole(principal, needed)) {
      return reply.status(403).send({ error: `This needs the ${needed} role`, code: "forbidden", needed });
    }
  });

  const me = (req: FastifyRequest): Principal => req.principal!;
  const bearer = (req: FastifyRequest) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  const limiter = new LoginLimiter();
  const emailSchema = z.string().trim().toLowerCase().email();
  const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(200);
  const findByEmail = (email: string) => Object.values(store.data.users).find((u) => u.email === email);
  const activeAdmins = () => Object.values(store.data.users).filter((u) => u.role === "admin" && !u.disabled);

  /* --------------------------- auth + users ------------------------- */
  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
    const keys = [`ip:${req.ip}`, `email:${body.email}`];
    if (limiter.blocked(...keys)) return reply.status(429).send({ error: "Too many attempts", code: "rate_limited" });
    const user = findByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !ok || user.disabled) {
      limiter.fail(...keys);
      return reply.status(401).send({ error: "Email or password is incorrect", code: "invalid_login" });
    }
    limiter.reset(...keys);
    user.lastLoginAt = nowIso();
    const token = createSession(store, user);
    return { token, user: publicUser(user) };
  });

  app.post("/api/auth/logout", async (req) => {
    if (me(req).kind === "user") deleteSession(store, bearer(req));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const p = me(req);
    return { id: p.id, name: p.name, email: p.email, role: p.role, kind: p.kind };
  });

  app.post("/api/auth/password", async (req) => {
    const p = me(req);
    if (p.kind !== "user") throw new HttpError(400, "Only user accounts have a password");
    const body = parse(z.object({ current: z.string(), next: passwordSchema }), req.body);
    const user = get(store.data.users, p.id, "User");
    if (!(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    user.passwordHash = await hashPassword(body.next);
    deleteUserSessions(store, user.id, bearer(req));
    store.save();
    return { ok: true };
  });

  const UserBody = z.object({
    email: emailSchema,
    name: z.string().trim().min(1).max(100),
    role: z.enum(["admin", "developer", "operator", "viewer"]),
    password: passwordSchema,
    disabled: z.boolean().optional(),
  });

  app.get("/api/users", async () =>
    Object.values(store.data.users)
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.name.localeCompare(b.name))
      .map(publicUser),
  );

  app.post("/api/users", async (req, reply) => {
    const body = parse(UserBody, req.body);
    if (findByEmail(body.email)) throw new HttpError(409, `A user with email ${body.email} already exists`);
    const user: User = {
      id: newId("usr"),
      email: body.email,
      name: body.name,
      role: body.role,
      disabled: body.disabled,
      passwordHash: await hashPassword(body.password),
      createdAt: nowIso(),
    };
    store.data.users[user.id] = user;
    store.save();
    return reply.status(201).send(publicUser(user));
  });

  app.put<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const user = get(store.data.users, req.params.id, "User");
    const body = parse(UserBody.partial().extend({ password: passwordSchema.optional().or(z.literal("")) }), req.body);
    const losesAdmin = user.role === "admin" && ((body.role && body.role !== "admin") || body.disabled === true);
    if (losesAdmin && activeAdmins().length <= 1) throw new HttpError(409, "Keep at least one active administrator");
    if (body.email && body.email !== user.email && findByEmail(body.email)) {
      throw new HttpError(409, `A user with email ${body.email} already exists`);
    }
    if (body.email) user.email = body.email;
    if (body.name) user.name = body.name;
    if (body.role) user.role = body.role;
    if (body.disabled !== undefined) user.disabled = body.disabled;
    if (body.password) user.passwordHash = await hashPassword(body.password);
    if (body.password || body.disabled) deleteUserSessions(store, user.id);
    store.save();
    return publicUser(user);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const user = get(store.data.users, req.params.id, "User");
    if (user.id === me(req).id) throw new HttpError(409, "You cannot delete your own account");
    if (user.role === "admin" && !user.disabled && activeAdmins().length <= 1) {
      throw new HttpError(409, "Keep at least one active administrator");
    }
    delete store.data.users[user.id];
    deleteUserSessions(store, user.id);
    return reply.status(204).send();
  });

  /* ------------------------------ backups --------------------------- */
  app.get("/api/admin/backup", async () => options.backup?.getStatus() ?? { configured: false, running: false });
  app.post("/api/admin/backup", async () => {
    if (!options.backup) throw new HttpError(409, "Backups are not configured");
    const key = await options.backup.runNow();
    return { ...options.backup.getStatus(), key };
  });

  const get = <T>(collection: Record<string, T>, id: string, what: string): T => {
    const item = collection[id];
    if (!item) throw new HttpError(404, `${what} ${id} not found`);
    return item;
  };

  /* ----------------------------- general ---------------------------- */
  app.get("/api/health", async () => ({ ok: true, time: nowIso() }));
  app.get("/api/actions", async () => BUILTIN_ACTIONS);
  app.get("/api/stats", async () => {
    const jobs = Object.values(store.data.jobs);
    const agents = Object.values(store.data.agents);
    const count = (s: Job["status"]) => jobs.filter((j) => j.status === s).length;
    return {
      agents: { total: agents.length, online: agents.filter((a) => a.status !== "offline").length, busy: agents.filter((a) => a.status === "busy").length },
      jobs: {
        total: jobs.length,
        pending: count("pending"),
        running: count("running") + count("cancelling"),
        succeeded: count("succeeded"),
        failed: count("failed"),
        cancelled: count("cancelled"),
      },
      workflows: Object.keys(store.data.workflows).length,
      packages: Object.keys(store.data.packages).length,
      schedules: Object.values(store.data.schedules).filter((s) => s.enabled).length,
      healedSelectors: jobs.reduce((n, j) => n + j.healedSelectors.length, 0),
      ai: { configured: ai === undefined ? AiClient.isConfigured() : Boolean(ai) },
    };
  });

  /* ---------------------------- workflows --------------------------- */
  app.get("/api/workflows", async () =>
    Object.values(store.data.workflows)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(({ definition, ...rest }) => ({ ...rest, steps: countSteps(definition.root) })),
  );

  app.post("/api/workflows", async (req, reply) => {
    const body = parse(WorkflowBody, req.body);
    const id = newId("wf");
    const name = body.name ?? body.definition?.name ?? "New workflow";
    const definition = body.definition ?? {
      schemaVersion: 1 as const,
      id,
      name,
      variables: [],
      root: { id: "root", type: "core.sequence", props: {}, slots: { body: [] } },
    };
    const wf: WorkflowDraft = { id, name, description: body.description, definition: { ...definition, id, name }, createdAt: nowIso(), updatedAt: nowIso() };
    store.data.workflows[id] = wf;
    store.save();
    return reply.status(201).send(wf);
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req) => get(store.data.workflows, req.params.id, "Workflow"));

  app.put<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    const wf = get(store.data.workflows, req.params.id, "Workflow");
    const body = parse(WorkflowBody, req.body);
    if (body.name) wf.name = body.name;
    if (body.description !== undefined) wf.description = body.description;
    if (body.definition) wf.definition = body.definition;
    wf.definition = { ...wf.definition, id: wf.id, name: wf.name, description: wf.description ?? wf.definition.description };
    wf.updatedAt = nowIso();
    store.save();
    return wf;
  });

  app.delete<{ Params: { id: string } }>("/api/workflows/:id", async (req, reply) => {
    get(store.data.workflows, req.params.id, "Workflow");
    delete store.data.workflows[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/publish", async (req, reply) => {
    const wf = get(store.data.workflows, req.params.id, "Workflow");
    const body = parse(z.object({ releaseNotes: z.string().optional() }).default({}), req.body ?? {});
    const previous = Object.values(store.data.packages).filter((p) => p.workflowId === wf.id);
    const pkg: Package = {
      id: newId("pkg"),
      workflowId: wf.id,
      name: wf.name,
      description: wf.description,
      version: previous.reduce((max, p) => Math.max(max, p.version), 0) + 1,
      releaseNotes: body.releaseNotes,
      definition: structuredClone(wf.definition),
      publishedAt: nowIso(),
    };
    store.data.packages[pkg.id] = pkg;
    store.save();
    return reply.status(201).send(pkg);
  });

  /* ----------------------------- packages --------------------------- */
  app.get("/api/packages", async () =>
    Object.values(store.data.packages)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map(({ definition, ...rest }) => ({ ...rest, variables: definition.variables })),
  );
  app.get<{ Params: { id: string } }>("/api/packages/:id", async (req) => get(store.data.packages, req.params.id, "Package"));
  app.delete<{ Params: { id: string } }>("/api/packages/:id", async (req, reply) => {
    get(store.data.packages, req.params.id, "Package");
    if (Object.values(store.data.schedules).some((s) => s.packageId === req.params.id)) {
      throw new HttpError(409, "Package is used by a schedule");
    }
    delete store.data.packages[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ------------------------------- jobs ----------------------------- */
  app.get<{ Querystring: { status?: string; limit?: string } }>("/api/jobs", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    return Object.values(store.data.jobs)
      .filter((j) => !req.query.status || j.status === req.query.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(jobSummary);
  });

  app.post("/api/jobs", async (req, reply) => {
    const body = parse(JobBody, req.body);
    // Running an unpublished definition (Designer test run) is a developer action.
    if (body.definition && !hasRole(me(req), "developer")) {
      throw new HttpError(403, "Test runs of unpublished workflows need the developer role");
    }
    const who = me(req);
    const job = createJob(store, { ...body, startedBy: who.email || who.name });
    return reply.status(201).send(jobSummary(job));
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => get(store.data.jobs, req.params.id, "Job"));

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/jobs/:id/logs", async (req) => {
    get(store.data.jobs, req.params.id, "Job");
    const after = Number(req.query.after ?? 0);
    return (store.data.jobLogs[req.params.id] ?? []).filter((l) => l.seq > after);
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    const job = get(store.data.jobs, req.params.id, "Job");
    if (isFinal(job)) throw new HttpError(409, `Job is already ${job.status}`);
    if (job.status === "pending") finishJob(store, job, "cancelled", "Cancelled before start");
    else {
      job.status = "cancelling";
      store.appendLogs(job.id, [{ time: nowIso(), level: "warn", message: "Cancellation requested" }]);
    }
    store.save();
    return jobSummary(job);
  });

  /* ------------------------------ agents ---------------------------- */
  app.get("/api/agents", async () => Object.values(store.data.agents).sort((a, b) => a.name.localeCompare(b.name)));
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    get(store.data.agents, req.params.id, "Agent");
    delete store.data.agents[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ----------------------------- schedules -------------------------- */
  const withNextRun = (s: Schedule) => ({ ...s, nextRunAt: scheduler.nextRun(s.id) });
  const checkSchedule = (body: z.infer<typeof ScheduleBody>) => {
    get(store.data.packages, body.packageId, "Package");
    const cronError = validateCron(body.cron, body.timezone);
    if (cronError) throw new HttpError(400, `Invalid cron expression: ${cronError}`);
  };

  app.get("/api/schedules", async () => Object.values(store.data.schedules).map(withNextRun));
  app.post("/api/schedules", async (req, reply) => {
    const body = parse(ScheduleBody, req.body);
    checkSchedule(body);
    const schedule: Schedule = { id: newId("sch"), ...body, createdAt: nowIso() };
    store.data.schedules[schedule.id] = schedule;
    store.save();
    scheduler.sync(schedule);
    return reply.status(201).send(withNextRun(schedule));
  });
  app.put<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const existing = get(store.data.schedules, req.params.id, "Schedule");
    const body = parse(ScheduleBody, { ...existing, ...(req.body as object) });
    checkSchedule(body);
    const schedule: Schedule = { ...existing, ...body };
    store.data.schedules[schedule.id] = schedule;
    store.save();
    scheduler.sync(schedule);
    return withNextRun(schedule);
  });
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    get(store.data.schedules, req.params.id, "Schedule");
    delete store.data.schedules[req.params.id];
    store.save();
    scheduler.sync(undefined, req.params.id);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req) => {
    get(store.data.schedules, req.params.id, "Schedule");
    scheduler.fire(req.params.id);
    return { ok: true };
  });

  /* ------------------------------ queues ---------------------------- */
  const QueueBody = z.object({
    name: z.string().trim().regex(/^[A-Za-z0-9_. -]{1,80}$/, "Use letters, digits, spaces, '.', '_' or '-'"),
    description: z.string().optional(),
    maxRetries: z.number().int().min(0).max(10).default(2),
  });
  const withCounts = (q: Queue) => ({ ...q, counts: queueCounts(store, q.id) });

  app.get("/api/queues", async () => Object.values(store.data.queues).sort((a, b) => a.name.localeCompare(b.name)).map(withCounts));

  app.post("/api/queues", async (req, reply) => {
    const body = parse(QueueBody, req.body);
    if (Object.values(store.data.queues).some((q) => q.name.toLowerCase() === body.name.toLowerCase())) {
      throw new HttpError(409, `Queue "${body.name}" already exists`);
    }
    const queue: Queue = { id: newId("que"), ...body, createdAt: nowIso() };
    store.data.queues[queue.id] = queue;
    store.save();
    return reply.status(201).send(withCounts(queue));
  });

  app.put<{ Params: { id: string } }>("/api/queues/:id", async (req) => {
    const queue = get(store.data.queues, req.params.id, "Queue");
    const body = parse(QueueBody.partial(), req.body);
    Object.assign(queue, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
    store.save();
    return withCounts(queue);
  });

  app.delete<{ Params: { id: string } }>("/api/queues/:id", async (req, reply) => {
    get(store.data.queues, req.params.id, "Queue");
    delete store.data.queues[req.params.id];
    for (const item of Object.values(store.data.queueItems)) if (item.queueId === req.params.id) delete store.data.queueItems[item.id];
    store.save();
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>("/api/queues/:id/items", async (req) => {
    get(store.data.queues, req.params.id, "Queue");
    const limit = Math.min(Number(req.query.limit ?? 200), 2000);
    return Object.values(store.data.queueItems)
      .filter((i) => i.queueId === req.params.id && (!req.query.status || i.status === req.query.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  });

  app.post<{ Params: { id: string } }>("/api/queues/:id/items", async (req, reply) => {
    const queue = get(store.data.queues, req.params.id, "Queue");
    const body = parse(z.object({ data: z.unknown(), reference: z.string().trim().max(200).optional() }), req.body);
    return reply.status(201).send(addItem(store, queue, body.data ?? {}, body.reference));
  });

  app.post<{ Params: { id: string } }>("/api/queue-items/:id/retry", async (req) => {
    const item = get(store.data.queueItems, req.params.id, "Queue item");
    if (item.status !== "failed" && item.status !== "business-exception") {
      throw new HttpError(409, "Only failed items can be retried");
    }
    Object.assign(item, { status: "new", jobId: undefined, agentId: undefined, startedAt: undefined, finishedAt: undefined });
    store.save();
    return item;
  });

  app.delete<{ Params: { id: string } }>("/api/queue-items/:id", async (req, reply) => {
    get(store.data.queueItems, req.params.id, "Queue item");
    delete store.data.queueItems[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ------------------------------ assets ---------------------------- */
  app.get("/api/assets", async () => Object.values(store.data.assets).map(maskAsset));
  app.post("/api/assets", async (req, reply) => {
    const body = parse(AssetBody, req.body);
    if (Object.values(store.data.assets).some((a) => a.name === body.name)) {
      throw new HttpError(409, `Asset "${body.name}" already exists`);
    }
    const asset: Asset = { id: newId("ast"), ...body, value: body.value ?? null, updatedAt: nowIso() };
    store.data.assets[asset.id] = asset;
    store.save();
    return reply.status(201).send(maskAsset(asset));
  });
  app.put<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const existing = get(store.data.assets, req.params.id, "Asset");
    const body = parse(AssetBody.partial(), req.body);
    const asset: Asset = { ...existing, ...body, value: body.value ?? existing.value, updatedAt: nowIso() };
    // Masked credential passwords sent back by the UI mean "unchanged".
    if (asset.type === "credential" && (body.value as { password?: string } | undefined)?.password === "********") {
      asset.value = { ...(body.value as object), password: (existing.value as { password?: string }).password };
    }
    store.data.assets[asset.id] = asset;
    store.save();
    return maskAsset(asset);
  });
  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    get(store.data.assets, req.params.id, "Asset");
    delete store.data.assets[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* -------------------------------- AI ------------------------------ */
  app.get("/api/ai/status", async () => {
    const configured = ai === undefined ? AiClient.isConfigured() : Boolean(ai);
    return { configured, model: configured ? getAi().model : null };
  });

  app.post("/api/ai/generate-workflow", async (req) => {
    const body = parse(
      z.object({ prompt: z.string().min(3), existing: WorkflowSchema.optional(), language: z.string().optional() }),
      req.body,
    );
    return getAi().generateWorkflow({
      prompt: body.prompt,
      existing: body.existing,
      catalog: BUILTIN_ACTIONS,
      language: body.language ? languageName(body.language) : undefined,
    });
  });

  app.post("/api/ai/suggest-selectors", async (req) => {
    const body = parse(
      z.object({
        html: z.string().min(1).max(400_000),
        description: z.string().min(1),
        url: z.string().optional(),
        currentSelector: z.string().optional(),
        language: z.string().optional(),
      }),
      req.body,
    );
    return getAi().suggestSelectors({ ...body, language: body.language ? languageName(body.language) : undefined });
  });

  /* --------------------------- bot agent API ------------------------ */
  const agentFor = (agentId: unknown): Agent => {
    const agent = store.data.agents[String(agentId ?? "")];
    if (!agent) throw new HttpError(404, "Unknown agent; register again");
    agent.lastHeartbeat = nowIso();
    if (agent.status === "offline") agent.status = agent.currentJobId ? "busy" : "online";
    return agent;
  };

  app.post("/api/agent/register", async (req) => {
    const body = parse(
      z.object({ agentId: z.string().optional(), name: z.string().min(1), machine: z.string().default(""), os: z.string().default(""), version: z.string().default("") }),
      req.body,
    );
    const existing =
      (body.agentId && store.data.agents[body.agentId]) ||
      Object.values(store.data.agents).find((a) => a.name === body.name && a.machine === body.machine);
    const agent: Agent = existing
      ? { ...existing, ...body, id: existing.id, status: "online", currentJobId: undefined, lastHeartbeat: nowIso() }
      : { id: newId("agt"), name: body.name, machine: body.machine, os: body.os, version: body.version, status: "online", lastHeartbeat: nowIso(), registeredAt: nowIso() };
    store.data.agents[agent.id] = agent;
    // Jobs that were running on this agent before it restarted are lost.
    for (const job of Object.values(store.data.jobs)) {
      if (job.agentId === agent.id && !isFinal(job) && job.status !== "pending") finishJob(store, job, "failed", "Agent restarted");
    }
    store.save();
    return { agentId: agent.id };
  });

  app.post("/api/agent/heartbeat", async (req) => {
    const body = req.body as { agentId?: string };
    const agent = agentFor(body.agentId);
    store.save();
    const cancelJobIds = Object.values(store.data.jobs)
      .filter((j) => j.agentId === agent.id && j.status === "cancelling")
      .map((j) => j.id);
    return { cancelJobIds };
  });

  app.post("/api/agent/jobs/next", async (req, reply) => {
    const agent = agentFor((req.body as { agentId?: string }).agentId);
    if (agent.currentJobId && store.data.jobs[agent.currentJobId] && !isFinal(store.data.jobs[agent.currentJobId]!)) {
      return reply.status(204).send();
    }
    const job = Object.values(store.data.jobs)
      .filter((j) => j.status === "pending" && (!j.targetAgentId || j.targetAgentId === agent.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) {
      agent.status = "online";
      agent.currentJobId = undefined;
      return reply.status(204).send();
    }
    job.status = "running";
    job.agentId = agent.id;
    job.startedAt = nowIso();
    agent.status = "busy";
    agent.currentJobId = job.id;
    store.appendLogs(job.id, [{ time: job.startedAt, level: "info", message: `Started on agent ${agent.name}` }]);
    store.save();
    return { id: job.id, name: job.name, definition: job.definition, inputs: job.inputs };
  });

  const agentJob = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const agent = agentFor((req.body as { agentId?: string }).agentId);
    const job = get(store.data.jobs, req.params.id, "Job");
    if (job.agentId !== agent.id) throw new HttpError(403, "Job belongs to another agent");
    return job;
  };

  app.post<{ Params: { id: string } }>("/api/agent/jobs/:id/events", async (req) => {
    const job = agentJob(req);
    const events = ((req.body as { events?: EngineEvent[] }).events ?? []).slice(0, 1000);
    const logs = [];
    for (const e of events) {
      if (e.type === "log") logs.push({ time: e.time, level: e.level, message: e.message, stepId: e.stepId, data: e.data });
      else if (e.type === "stepEnd" && e.status === "error") {
        logs.push({ time: e.time, level: "error" as const, message: `Step failed: ${e.error}`, stepId: e.stepId });
      } else if (e.type === "custom" && e.name === "selectorHealed") {
        const data = e.data as { oldSelector: string; newSelector: string; reason?: string };
        job.healedSelectors.push({ stepId: e.stepId, ...data });
      }
    }
    if (logs.length) store.appendLogs(job.id, logs);
    store.save();
    return { cancel: job.status === "cancelling" };
  });

  app.post<{ Params: { id: string } }>("/api/agent/jobs/:id/complete", async (req) => {
    const job = agentJob(req);
    const body = parse(
      z.object({ agentId: z.string(), status: z.enum(["succeeded", "failed", "cancelled"]), error: z.string().optional(), outputs: z.record(z.unknown()).optional() }),
      req.body,
    );
    if (!isFinal(job)) finishJob(store, job, body.status, body.error, body.outputs);
    return { ok: true };
  });

  /* bot side of work queues */
  const agentBody = (req: FastifyRequest) => (req.body ?? {}) as { agentId?: string; jobId?: string };
  const jobOfAgent = (agent: Agent, jobId: string | undefined): string | undefined => {
    if (jobId && store.data.jobs[jobId]?.agentId !== agent.id) throw new HttpError(403, "Job belongs to another agent");
    return jobId;
  };

  app.post<{ Params: { name: string } }>("/api/agent/queues/:name/items", async (req, reply) => {
    agentFor(agentBody(req).agentId);
    const body = parse(z.object({ data: z.unknown(), reference: z.string().trim().max(200).optional() }).passthrough(), req.body);
    const item = addItem(store, findQueue(store, req.params.name), body.data ?? {}, body.reference);
    return reply.status(201).send({ id: item.id });
  });

  app.post<{ Params: { name: string } }>("/api/agent/queues/:name/next", async (req, reply) => {
    const agent = agentFor(agentBody(req).agentId);
    const item = takeNext(store, findQueue(store, req.params.name), jobOfAgent(agent, agentBody(req).jobId), agent.id);
    if (!item) return reply.status(204).send();
    const queue = store.data.queues[item.queueId]!;
    return { id: item.id, queue: queue.name, reference: item.reference, data: item.data, retries: item.retries };
  });

  app.post<{ Params: { id: string } }>("/api/agent/queue-items/:id/complete", async (req) => {
    const agent = agentFor(agentBody(req).agentId);
    const item: QueueItem = get(store.data.queueItems, req.params.id, "Queue item");
    if (item.agentId !== agent.id || item.status !== "in-progress") throw new HttpError(409, "This item is not locked by this agent");
    const body = parse(
      z.object({ status: z.enum(["successful", "failed", "business-exception"]), result: z.unknown().optional(), message: z.string().optional() }).passthrough(),
      req.body,
    );
    completeItem(store, item, body.status, body.result, body.message);
    return { status: item.status, final: FINAL_ITEM_STATUSES.includes(item.status) };
  });

  app.get<{ Params: { name: string } }>("/api/agent/assets/:name", async (req) => {
    const asset = Object.values(store.data.assets).find((a) => a.name === req.params.name);
    if (!asset) throw new HttpError(404, `Asset "${req.params.name}" not found`);
    return { name: asset.name, type: asset.type, value: asset.value };
  });

  /* ---------------------------- lifecycle --------------------------- */
  const sweeper = setInterval(() => {
    sweep(store, config);
    pruneSessions(store);
  }, 5_000);
  sweeper.unref();
  scheduler.start();
  options.backup?.start();
  app.addHook("onClose", async () => {
    clearInterval(sweeper);
    scheduler.stop();
    options.backup?.stop();
    store.flush();
  });

  return { app, store, scheduler };
}

function countSteps(step: { slots?: Record<string, Array<{ slots?: unknown }>> }): number {
  let n = 1;
  for (const children of Object.values(step.slots ?? {})) {
    for (const child of children) n += countSteps(child as typeof step);
  }
  return n;
}
