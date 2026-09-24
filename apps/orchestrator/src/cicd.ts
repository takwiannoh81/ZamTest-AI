/**
 * Source control and CI/CD for customers' automations:
 * - environments: publishing puts a version in Development; it is promoted to
 *   Test, then Production (with an admin's approval when the workspace wants one);
 * - API tokens, so a CI pipeline can check, publish and promote workflows;
 * - Git: workflows as JSON files in the customer's repository, committed from the
 *   Designer, and published to Development when the repository reports a push.
 */
import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BUILTIN_ACTIONS, WorkflowSchema } from "@zamtest/core";
import type { Step, Workflow } from "@zamtest/core";
import { hashToken, newSecret, safeEqual } from "./auth.js";
import { HttpError, parse } from "./errors.js";
import { GitRepos, slugify } from "./git.js";
import type { Mail } from "./mailer.js";
import { emails } from "./mailer.js";
import { checkFeature, limitsOf } from "./plans.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { ApiToken, EnvironmentId, GitSettings, Package, Principal, Promotion, User, WorkflowDraft, Workspace, WorkspaceCicd } from "./types.js";
import { ENVIRONMENTS } from "./types.js";

/* ------------------------------ environments ------------------------------ */

export const ENV_NAMES: Record<EnvironmentId, string> = { dev: "Development", test: "Test", prod: "Production" };

export function cicdOf(workspace: Workspace | undefined): WorkspaceCicd {
  return workspace?.cicd ?? { environments: false, requireApproval: true };
}

/** Environments are in use: switched on, and in the plan. */
export function environmentsOn(store: Store, workspaceId: string): boolean {
  const workspace = store.data.workspaces[workspaceId];
  return Boolean(workspace && cicdOf(workspace).environments && limitsOf(workspace).sourceControl);
}

/** The environment that counts: always Production while environments are off. */
export function effectiveEnv(store: Store, workspaceId: string, env: EnvironmentId | undefined): EnvironmentId {
  return environmentsOn(store, workspaceId) ? (env ?? "prod") : "prod";
}

export const isIn = (pkg: Package, env: EnvironmentId) => Boolean(pkg.deployments?.[env]);

/** For each workflow, the version that runs in an environment: the newest one put there. */
export function currentVersions(store: Store, workspaceId: string, env: EnvironmentId): Package[] {
  const current = new Map<string, Package>();
  for (const pkg of Object.values(store.data.packages)) {
    const at = pkg.workspaceId === workspaceId ? pkg.deployments?.[env]?.at : undefined;
    if (!at) continue;
    const best = current.get(pkg.workflowId);
    if (!best || at > best.deployments![env]!.at) current.set(pkg.workflowId, pkg);
  }
  return [...current.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A new, immutable version of a workflow: in Development (or Production while environments are off). */
export function publishWorkflow(
  store: Store,
  wf: WorkflowDraft,
  options: { releaseNotes?: string; by: string; source?: Package["source"] },
): Package {
  const previous = Object.values(store.data.packages).filter((p) => p.workflowId === wf.id);
  const env: EnvironmentId = environmentsOn(store, wf.workspaceId) ? "dev" : "prod";
  const pkg: Package = {
    id: newId("pkg"),
    workspaceId: wf.workspaceId,
    workflowId: wf.id,
    name: wf.name,
    description: wf.description,
    version: previous.reduce((max, p) => Math.max(max, p.version), 0) + 1,
    releaseNotes: options.releaseNotes,
    definition: structuredClone(wf.definition),
    publishedAt: nowIso(),
    deployments: { [env]: { at: nowIso(), by: options.by } },
    source: options.source,
  };
  store.data.packages[pkg.id] = pkg;
  store.save();
  return pkg;
}

/** Problems that would stop a workflow from running: its shape, and actions this platform does not have. */
export function validateWorkflow(definition: unknown): { valid: boolean; errors: string[] } {
  const parsed = WorkflowSchema.safeParse(definition);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "workflow"}: ${i.message}`) };
  }
  const known = new Set(BUILTIN_ACTIONS.map((a) => a.type));
  const errors: string[] = [];
  const visit = (step: Step) => {
    if (!known.has(step.type)) errors.push(`Step ${step.id}: unknown action "${step.type}"`);
    for (const children of Object.values(step.slots ?? {})) for (const child of children) visit(child);
  };
  visit(parsed.data.root);
  return { valid: errors.length === 0, errors };
}

/** Equal as JSON, whatever the order of keys. */
function sameJson(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/* ------------------------------- API tokens ------------------------------- */

export const API_TOKEN_PREFIX = "ztat_";

/** The pipeline behind an API token, or undefined when the token is unknown or expired. */
export function apiTokenPrincipal(store: Store, token: string): Principal | undefined {
  if (!token.startsWith(API_TOKEN_PREFIX)) return undefined;
  const hash = hashToken(token);
  const found = Object.values(store.data.apiTokens).find((t) => safeEqual(t.tokenHash, hash));
  if (!found || (found.expiresAt && Date.parse(found.expiresAt) < Date.now())) return undefined;
  // Written at most once a minute: pipelines call often.
  if (!found.lastUsedAt || Date.now() - Date.parse(found.lastUsedAt) > 60_000) {
    found.lastUsedAt = nowIso();
    store.save();
  }
  return { id: found.id, name: `API token "${found.name}"`, email: "", role: found.role, kind: "api", workspaceId: found.workspaceId };
}

/* --------------------------------- routes --------------------------------- */

export interface CicdContext {
  store: Store;
  portalUrl: string;
  /** Public address of the API, for the webhook URL shown to admins. */
  apiUrl: string;
  git: GitRepos;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  mine<T extends { workspaceId: string }>(collection: Record<string, T>, req: FastifyRequest): T[];
  who(p: Principal): string;
  workspace(req: FastifyRequest): Workspace;
  requireAdmin(req: FastifyRequest): void;
  /** Sends an email when the server has email set up; never throws. */
  notify(to: string, mail: Omit<Mail, "to">): void;
  log(message: string): void;
}

const EnvSchema = z.enum(["dev", "test", "prod"]);

const packageSummary = ({ definition, ...rest }: Package) => ({ ...rest, variables: definition.variables });

export function registerCicd(app: FastifyInstance, ctx: CicdContext): void {
  const { store, git } = ctx;
  const ws = (req: FastifyRequest) => ctx.me(req).workspaceId;
  const needSourceControl = (req: FastifyRequest) => checkFeature(store, ws(req), "sourceControl");

  /* ---------- settings ---------- */
  const settingsView = (workspace: Workspace) => {
    const cicd = cicdOf(workspace);
    return {
      available: limitsOf(workspace).sourceControl,
      environments: cicd.environments,
      requireApproval: cicd.requireApproval,
    };
  };
  app.get("/api/cicd/settings", async (req) => settingsView(ctx.workspace(req)));
  app.put("/api/cicd/settings", async (req) => {
    ctx.requireAdmin(req);
    const body = parse(z.object({ environments: z.boolean(), requireApproval: z.boolean() }), req.body);
    if (body.environments) needSourceControl(req);
    const workspace = ctx.workspace(req);
    workspace.cicd = { ...cicdOf(workspace), ...body };
    store.save();
    return settingsView(workspace);
  });

  /* ---------- environments ---------- */
  app.get("/api/environments", async (req) => {
    const workspaceId = ws(req);
    const on = environmentsOn(store, workspaceId);
    const agents = ctx.mine(store.data.agents, req);
    return {
      enabled: on,
      requireApproval: cicdOf(store.data.workspaces[workspaceId]).requireApproval,
      environments: (on ? ENVIRONMENTS : (["prod"] as EnvironmentId[])).map((id) => ({
        id,
        name: ENV_NAMES[id],
        agents: agents.filter((a) => effectiveEnv(store, workspaceId, a.environment) === id).length,
        processes: currentVersions(store, workspaceId, id).map((p) => ({ ...packageSummary(p), deployedAt: p.deployments![id]!.at, deployedBy: p.deployments![id]!.by })),
      })),
    };
  });

  app.put<{ Params: { id: string } }>("/api/agents/:id/environment", async (req) => {
    ctx.requireAdmin(req);
    const agent = ctx.own(store.data.agents, req.params.id, "Agent", req);
    const body = parse(z.object({ environment: EnvSchema }), req.body);
    agent.environment = body.environment;
    store.save();
    return agent;
  });

  /* ---------- promotion ---------- */
  const deploy = (pkg: Package, env: EnvironmentId, by: string) => {
    pkg.deployments = { ...pkg.deployments, [env]: { at: nowIso(), by } };
  };

  app.post<{ Params: { id: string } }>("/api/packages/:id/promote", async (req, reply) => {
    const pkg = ctx.own(store.data.packages, req.params.id, "Package", req);
    const body = parse(z.object({ to: EnvSchema, note: z.string().max(2000).optional() }), req.body ?? {});
    if (!environmentsOn(store, pkg.workspaceId)) throw new HttpError(409, "Environments are off for this workspace; published versions go straight to Production");
    // Test takes what was tried in Development; Production takes what passed Test (or a version it had before: a rollback).
    if (body.to === "test" && !isIn(pkg, "dev") && !isIn(pkg, "test")) throw new HttpError(409, `Version ${pkg.version} is not in Development`);
    if (body.to === "prod" && !isIn(pkg, "test") && !isIn(pkg, "prod")) throw new HttpError(409, `Version ${pkg.version} must be in Test before Production`);
    const p = ctx.me(req);
    const needsApproval = body.to === "prod" && cicdOf(store.data.workspaces[pkg.workspaceId]).requireApproval;
    const promotion: Promotion = {
      id: newId("prm"),
      workspaceId: pkg.workspaceId,
      packageId: pkg.id,
      name: pkg.name,
      version: pkg.version,
      to: body.to,
      status: needsApproval ? "pending" : "approved",
      requestedBy: ctx.who(p),
      requestedById: p.id,
      requestedAt: nowIso(),
      note: body.note,
    };
    if (needsApproval) {
      const open = Object.values(store.data.promotions).find((x) => x.packageId === pkg.id && x.to === body.to && x.status === "pending");
      if (open) throw new HttpError(409, `Version ${pkg.version} is already waiting for approval`);
      const link = `${ctx.portalUrl}/#/processes?approvals=1`;
      for (const admin of Object.values(store.data.users)) {
        if (admin.workspaceId === pkg.workspaceId && admin.role === "admin" && !admin.disabled && admin.id !== p.id) {
          ctx.notify(admin.email, emails.approval(admin.name, `${pkg.name} version ${pkg.version}`, promotion.requestedBy, link));
        }
      }
    } else {
      deploy(pkg, body.to, promotion.requestedBy);
      promotion.decidedBy = promotion.requestedBy;
      promotion.decidedAt = promotion.requestedAt;
    }
    store.data.promotions[promotion.id] = promotion;
    store.save();
    return reply.status(needsApproval ? 202 : 200).send(promotion);
  });

  app.get<{ Querystring: { status?: string } }>("/api/promotions", async (req) =>
    ctx
      .mine(store.data.promotions, req)
      .filter((x) => !req.query.status || x.status === req.query.status)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, 200),
  );
  app.get<{ Params: { id: string } }>("/api/promotions/:id", async (req) => ctx.own(store.data.promotions, req.params.id, "Promotion", req));

  const decide = (req: FastifyRequest<{ Params: { id: string } }>, status: "approved" | "rejected" | "cancelled") => {
    const promotion = ctx.own(store.data.promotions, req.params.id, "Promotion", req);
    if (promotion.status !== "pending") throw new HttpError(409, `This request was already ${promotion.status}`);
    const p = ctx.me(req);
    const body = parse(z.object({ note: z.string().max(2000).optional() }), req.body ?? {});
    if (status === "cancelled") {
      if (promotion.requestedById !== p.id && p.role !== "admin") throw new HttpError(403, "Only who asked, or an admin, can withdraw this request");
    } else {
      if (p.role !== "admin") throw new HttpError(403, "This needs the admin role");
      // Approvals are for people, and a second pair of eyes: not the one who asked, and not a pipeline.
      if (p.kind === "api") throw new HttpError(403, "API tokens cannot approve or reject");
      if (promotion.requestedById === p.id) throw new HttpError(403, "Someone other than who asked must decide");
    }
    promotion.status = status;
    promotion.decidedBy = ctx.who(p);
    promotion.decidedAt = nowIso();
    promotion.decisionNote = body.note;
    if (status === "approved") {
      const pkg = store.data.packages[promotion.packageId];
      if (!pkg) throw new HttpError(409, "This version was deleted");
      deploy(pkg, promotion.to, promotion.decidedBy);
    }
    store.save();
    return promotion;
  };
  app.post<{ Params: { id: string } }>("/api/promotions/:id/approve", async (req) => decide(req, "approved"));
  app.post<{ Params: { id: string } }>("/api/promotions/:id/reject", async (req) => decide(req, "rejected"));
  app.post<{ Params: { id: string } }>("/api/promotions/:id/cancel", async (req) => decide(req, "cancelled"));

  /* ---------- API tokens ---------- */
  const tokenView = ({ tokenHash: _hash, ...rest }: ApiToken) => rest;
  app.get("/api/api-tokens", async (req) => ctx.mine(store.data.apiTokens, req).map(tokenView));
  app.post("/api/api-tokens", async (req, reply) => {
    needSourceControl(req);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100), role: z.enum(["viewer", "operator", "developer"]).default("developer"), expiresInDays: z.number().int().min(1).max(3650).optional() }),
      req.body,
    );
    const token = `${API_TOKEN_PREFIX}${newSecret()}`;
    const record: ApiToken = {
      id: newId("tok"),
      workspaceId: ws(req),
      name: body.name,
      role: body.role,
      tokenHash: hashToken(token),
      createdBy: ctx.who(ctx.me(req)),
      createdAt: nowIso(),
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : undefined,
    };
    store.data.apiTokens[record.id] = record;
    store.save();
    // The token itself is shown only now.
    return reply.status(201).send({ ...tokenView(record), token });
  });
  app.delete<{ Params: { id: string } }>("/api/api-tokens/:id", async (req, reply) => {
    ctx.own(store.data.apiTokens, req.params.id, "API token", req);
    delete store.data.apiTokens[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ---------- CI ---------- */
  app.post("/api/ci/validate", async (req) => validateWorkflow((req.body as { definition?: unknown } | undefined)?.definition));

  /** Saves a workflow (matched by its id, then its name) and publishes a new version of it. */
  app.post("/api/ci/publish", async (req, reply) => {
    const body = parse(
      z.object({ definition: z.unknown(), releaseNotes: z.string().max(5000).optional(), commit: z.string().max(100).optional(), path: z.string().max(500).optional() }),
      req.body,
    );
    const check = validateWorkflow(body.definition);
    if (!check.valid) return reply.status(400).send({ error: "The workflow is not valid", errors: check.errors });
    const definition = WorkflowSchema.parse(body.definition) as Workflow;
    const workflows = ctx.mine(store.data.workflows, req);
    let wf =
      workflows.find((w) => w.id === definition.id) ??
      (body.path ? workflows.find((w) => w.git?.path === body.path) : undefined) ??
      workflows.find((w) => w.name.toLowerCase() === definition.name.toLowerCase());
    if (!wf) {
      const id = newId("wf");
      wf = { id, workspaceId: ws(req), name: definition.name, description: definition.description, definition, createdAt: nowIso(), updatedAt: nowIso() };
      store.data.workflows[id] = wf;
    }
    wf.name = definition.name;
    wf.description = definition.description ?? wf.description;
    wf.definition = { ...definition, id: wf.id };
    wf.updatedAt = nowIso();
    const source = body.commit ? { commit: body.commit, path: body.path ?? wf.git?.path ?? "" } : undefined;
    const pkg = publishWorkflow(store, wf, { releaseNotes: body.releaseNotes, by: ctx.who(ctx.me(req)), source });
    return reply.status(201).send({ workflowId: wf.id, package: packageSummary(pkg) });
  });

  /* ---------- Git ---------- */
  const gitOf = (req: FastifyRequest): GitSettings => {
    needSourceControl(req);
    const settings = cicdOf(ctx.workspace(req)).git;
    if (!settings) throw new HttpError(409, "No Git repository is connected; an admin connects one under Source control");
    return settings;
  };
  const webhookUrl = (workspaceId: string) => `${ctx.apiUrl}/api/git/webhook/${workspaceId}`;

  app.get("/api/git/settings", async (req) => {
    const workspace = ctx.workspace(req);
    const settings = cicdOf(workspace).git;
    if (!settings) return { available: limitsOf(workspace).sourceControl, connected: false };
    const { token, webhookSecret, ...rest } = settings;
    const admin = ctx.me(req).role === "admin";
    return {
      available: limitsOf(workspace).sourceControl,
      connected: true,
      ...rest,
      tokenSet: Boolean(token),
      webhookUrl: webhookUrl(workspace.id),
      // Admins set the webhook up in the repository.
      ...(admin ? { webhookSecret } : {}),
    };
  });

  app.put("/api/git/settings", async (req) => {
    ctx.requireAdmin(req);
    needSourceControl(req);
    const body = parse(
      z.object({
        url: z.string().trim().min(1).max(500),
        branch: z.string().trim().regex(/^[A-Za-z0-9._/-]+$/, "Letters, digits, '.', '_', '/' or '-'").refine((b) => !b.startsWith("-") && !b.includes(".."), "Not a branch name").default("main"),
        folder: z.string().trim().max(200).regex(/^[A-Za-z0-9._/ -]*$/, "Letters, digits, spaces, '.', '_', '/' or '-'").default("workflows"),
        username: z.string().trim().max(200).default(""),
        token: z.string().trim().max(1000).optional(),
        autoPublish: z.boolean().default(true),
      }),
      req.body,
    );
    const workspace = ctx.workspace(req);
    const cicd = cicdOf(workspace);
    const token = body.token || cicd.git?.token;
    if (!token) throw new HttpError(400, "Enter an access token for the repository");
    const folder = body.folder.replace(/^\/+|\/+$/g, "");
    if (folder.split("/").includes("..")) throw new HttpError(400, "The folder must be inside the repository");
    const settings: GitSettings = {
      url: body.url,
      branch: body.branch,
      folder,
      username: body.username,
      token,
      autoPublish: body.autoPublish,
      webhookSecret: cicd.git?.webhookSecret ?? newSecret(),
      lastSync: cicd.git?.url === body.url ? cicd.git.lastSync : undefined,
    };
    await git.test(settings);
    if (cicd.git && cicd.git.url !== settings.url) git.remove(workspace.id);
    workspace.cicd = { ...cicd, git: settings };
    store.save();
    return { ok: true };
  });

  app.delete("/api/git/settings", async (req, reply) => {
    ctx.requireAdmin(req);
    const workspace = ctx.workspace(req);
    if (workspace.cicd?.git) {
      delete workspace.cicd.git;
      git.remove(workspace.id);
      for (const wf of ctx.mine(store.data.workflows, req)) delete wf.git;
      store.save();
    }
    return reply.status(204).send();
  });

  /** A workflow as its file in the repository: the definition, readable in diffs. */
  const fileOf = (wf: WorkflowDraft) => `${JSON.stringify({ ...wf.definition, id: wf.id, name: wf.name }, null, 2)}\n`;
  const pathFor = (settings: GitSettings, wf: WorkflowDraft, taken: Set<string>) => {
    if (wf.git?.path) return wf.git.path;
    const base = `${settings.folder ? `${settings.folder}/` : ""}${slugify(wf.name)}`;
    let path = `${base}.json`;
    for (let i = 2; taken.has(path); i++) path = `${base}-${i}.json`;
    return path;
  };

  app.post<{ Params: { id: string } }>("/api/workflows/:id/commit", async (req) => {
    const wf = ctx.own(store.data.workflows, req.params.id, "Workflow", req);
    const settings = gitOf(req);
    const body = parse(z.object({ message: z.string().trim().min(1).max(2000) }), req.body);
    const p = ctx.me(req);
    const user: User | undefined = p.kind === "user" ? store.data.users[p.id] : undefined;
    const taken = new Set(ctx.mine(store.data.workflows, req).filter((w) => w.id !== wf.id && w.git?.path).map((w) => w.git!.path));
    const path = pathFor(settings, wf, taken);
    const author = { name: user?.name ?? p.name, email: user?.email || "automation@zamtechai.com" };
    const commit = await git.commit(wf.workspaceId, settings, { path, content: fileOf(wf) }, body.message, author);
    wf.git = { ...wf.git, path, ...(commit ? { commit, committedAt: nowIso(), committedBy: ctx.who(p) } : {}) };
    store.save();
    return { commit: commit ?? null, path, unchanged: !commit };
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id/history", async (req) => {
    const wf = ctx.own(store.data.workflows, req.params.id, "Workflow", req);
    const settings = gitOf(req);
    if (!wf.git?.path) return [];
    return git.history(wf.workspaceId, settings, wf.git.path);
  });

  app.get<{ Params: { id: string; sha: string } }>("/api/workflows/:id/history/:sha", async (req) => {
    const wf = ctx.own(store.data.workflows, req.params.id, "Workflow", req);
    const settings = gitOf(req);
    if (!wf.git?.path) throw new HttpError(404, "This workflow has no history in Git yet");
    const content = await git.show(wf.workspaceId, settings, req.params.sha, wf.git.path);
    const check = WorkflowSchema.safeParse(JSON.parse(content));
    if (!check.success) throw new HttpError(422, "That version of the file is not a valid workflow");
    return { definition: { ...check.data, id: wf.id } };
  });

  /**
   * Takes the repository's workflow files into the workspace: a file updates the
   * workflow it came from (or with its id), otherwise it becomes a new workflow.
   * Workflows whose file was deleted stay.
   */
  const pullWorkspace = async (workspaceId: string, settings: GitSettings, publish: boolean, by: string) => {
    const { commit, files } = await git.pull(workspaceId, settings);
    const result = { commit: commit ?? null, created: [] as string[], updated: [] as string[], unchanged: 0, published: [] as string[], errors: [] as Array<{ path: string; error: string }> };
    const workflows = Object.values(store.data.workflows).filter((w) => w.workspaceId === workspaceId);
    for (const file of files) {
      let definition: Workflow;
      try {
        const check = validateWorkflow(JSON.parse(file.content));
        if (!check.valid) throw new Error(check.errors.slice(0, 3).join("; "));
        definition = WorkflowSchema.parse(JSON.parse(file.content)) as Workflow;
      } catch (err) {
        result.errors.push({ path: file.path, error: (err as Error).message.slice(0, 300) });
        continue;
      }
      let wf = workflows.find((w) => w.git?.path === file.path) ?? workflows.find((w) => w.id === definition.id && !w.git?.path);
      if (wf && sameJson({ ...wf.definition, id: wf.id, name: wf.name }, { ...definition, id: wf.id })) {
        wf.git = { ...wf.git, path: file.path, commit: commit ?? wf.git?.commit };
        result.unchanged++;
        continue;
      }
      if (!wf) {
        const id = newId("wf");
        wf = { id, workspaceId, name: definition.name, description: definition.description, definition, createdAt: nowIso(), updatedAt: nowIso() };
        store.data.workflows[id] = wf;
        workflows.push(wf);
        result.created.push(wf.name);
      } else {
        result.updated.push(definition.name);
      }
      wf.name = definition.name;
      wf.description = definition.description ?? wf.description;
      wf.definition = { ...definition, id: wf.id };
      wf.updatedAt = nowIso();
      wf.git = { path: file.path, commit: commit ?? undefined };
      if (publish && commit) {
        publishWorkflow(store, wf, { releaseNotes: `From Git ${commit.slice(0, 7)}`, by, source: { commit, path: file.path } });
        result.published.push(wf.name);
      }
    }
    settings.lastSync = { at: nowIso(), commit: commit ?? undefined, changed: result.created.length + result.updated.length };
    store.save();
    return result;
  };

  app.post("/api/git/pull", async (req) => {
    const settings = gitOf(req);
    const body = parse(z.object({ publish: z.boolean().default(false) }), req.body ?? {});
    return pullWorkspace(ws(req), settings, body.publish, ctx.who(ctx.me(req)));
  });

  // The repository's host calls this after a push. It proves itself with the webhook
  // secret: GitHub signs the body; GitLab and others send the secret in a header.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post<{ Params: { workspaceId: string } }>("/api/git/webhook/:workspaceId", async (req, reply) => {
      const workspace = store.data.workspaces[req.params.workspaceId];
      const settings = workspace?.cicd?.git;
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
      const signature = String(req.headers["x-hub-signature-256"] ?? "");
      const header = String(req.headers["x-gitlab-token"] ?? req.headers["x-zamtech-token"] ?? "");
      const trusted =
        settings &&
        ((signature && safeEqual(signature, `sha256=${createHmac("sha256", settings.webhookSecret).update(raw).digest("hex")}`)) ||
          (header && safeEqual(header, settings.webhookSecret)));
      if (!workspace || !settings || !trusted) return reply.status(401).send({ error: "Unknown repository or wrong webhook secret" });
      if (!limitsOf(workspace).sourceControl) return reply.status(402).send({ error: "Source control is not included in this workspace's plan", code: "plan_limit" });
      if (req.headers["x-github-event"] === "ping") return { ok: true };
      let payload: { ref?: string; resource?: { refUpdates?: Array<{ name?: string }> } } = {};
      try {
        payload = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      } catch {
        return reply.status(400).send({ error: "The body is not JSON" });
      }
      // Pushes to other branches are not ours.
      const refs = [payload.ref, ...(payload.resource?.refUpdates ?? []).map((r) => r.name)].filter(Boolean);
      if (refs.length && !refs.includes(`refs/heads/${settings.branch}`)) return { ignored: true };
      void pullWorkspace(workspace.id, settings, settings.autoPublish, "Git push").catch((err: Error) => {
        settings.lastSync = { at: nowIso(), error: err.message };
        store.save();
        ctx.log(`Git: sync of ${workspace.id} failed: ${err.message}`);
      });
      return reply.status(202).send({ accepted: true });
    });
  });
}
