import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AiClient, AiNotConfiguredError, AiRefusalError, ZamAI } from "@zamtest/ai";
import { BUILTIN_ACTIONS, WorkflowSchema } from "@zamtest/core";
import { languageName } from "@zamtest/i18n";
import type { EngineEvent } from "@zamtest/core";
import {
  clearedSessionCookie,
  createSession,
  deleteSession,
  deleteUserSessions,
  hashPassword,
  hashToken,
  hasRole,
  LoginLimiter,
  MASTER_SESSION,
  MIN_PASSWORD_LENGTH,
  newSecret,
  newUserCode,
  pruneSessions,
  publicUser,
  readCookie,
  requiredRole,
  resolvePrincipal,
  safeEqual,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
} from "./auth.js";
import type { BackupService } from "./backup.js";
import { PAID_STATUSES } from "./billing.js";
import type { BillingProvider, SubscriptionState } from "./billing.js";
import { emails } from "./mailer.js";
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";
import { emailDomain, OidcClient, SsoError } from "./sso.js";
import type { Mail, Mailer } from "./mailer.js";
import type { OrchestratorConfig } from "./config.js";
import { createJob, finishJob, HttpError, isFinal, sweep } from "./jobs.js";
import { addItem, completeItem, FINAL_ITEM_STATUSES, findQueue, queueCounts, takeNext } from "./queues.js";
import { checkBots, checkBuilders, checkFeature, currentUsage, FREE_LIMITS, isBuilder, limitsOf, PlanLimitError, PRO, useAi } from "./plans.js";
import { Scheduler, validateCron } from "./scheduler.js";
import { newId, nowIso, Store } from "./store.js";
import type { Agent, Asset, Enrollment, InstallKey, Job, Package, Principal, Queue, QueueItem, Schedule, User, WorkflowDraft, Workspace } from "./types.js";
import { DEFAULT_WORKSPACE, ROLES } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    /** The approved PC making an /api/agent request with its own credential. */
    agent?: Agent;
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
  /** Online payments (Stripe); null/undefined when not configured. */
  billing?: BillingProvider | null;
  /** Sends confirmation and password-reset emails; null/undefined when SMTP is not configured. */
  mailer?: Mailer | null;
  /** OpenID Connect client for company sign-in (tests point it at a fake identity provider). */
  oidc?: OidcClient;
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

  await app.register(cors, { origin: config.corsOrigins, credentials: true });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof PlanLimitError) return reply.status(402).send({ error: err.message, code: "plan_limit", limit: err.limit });
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
  const cookieOptions = { domain: config.cookieDomain, secure: config.production };
  // A PC asking to be connected has no credential yet.
  const PUBLIC_AGENT_ROUTES = new Set(["/api/agent/enroll/start", "/api/agent/enroll/poll"]);
  // Stripe's webhook proves itself with its signature (checked in the route); email links carry their own token.
  const PUBLIC_ROUTES = new Set([
    "/api/auth/login",
    "/api/auth/token",
    "/api/auth/signup",
    "/api/auth/config",
    "/api/auth/verify",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset",
    "/api/auth/login/mfa",
    "/api/auth/sso/discover",
    "/api/auth/sso/start",
    "/api/auth/sso/callback",
    "/api/billing/webhook",
  ]);
  // What a signed-in person may still do while their account is restricted (email not confirmed, ...).
  const RESTRICTED_ALLOWED = new Set(["/api/auth/me", "/api/auth/logout", "/api/auth/verify/resend", "/api/auth/mfa", "/api/auth/mfa/setup", "/api/auth/mfa/enable"]);
  const agentByToken = (token: string): Agent | undefined => {
    const hash = hashToken(token);
    return Object.values(store.data.agents).find((a) => a.tokenHash !== undefined && safeEqual(a.tokenHash, hash));
  };

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split("?")[0] ?? "";
    if (!url.startsWith("/api/") || url === "/api/health") return;
    if (url.startsWith("/api/agent/")) {
      if (PUBLIC_AGENT_ROUTES.has(url)) return;
      // A PC approved in the Portal signs in with its own credential. The shared key,
      // when configured, is for the cloud bot container and older installs.
      const token = String(req.headers["x-agent-token"] ?? "");
      if (token) {
        const agent = agentByToken(token);
        if (!agent) return reply.status(401).send({ error: "This PC is no longer approved; connect it again", code: "agent_revoked" });
        req.agent = agent;
        return;
      }
      const key = String(req.headers["x-agent-key"] ?? "");
      if (!config.agentKey || !safeEqual(key, config.agentKey)) return reply.status(401).send({ error: "Invalid agent key" });
      return;
    }
    // Stripe's webhook proves itself with its signature (checked in the route).
    if (PUBLIC_ROUTES.has(url)) return;
    const cookieToken = req.headers.authorization ? undefined : readCookie(req.headers.cookie, SESSION_COOKIE);
    const principal = resolvePrincipal(store, config.adminToken, req.headers.authorization, cookieToken);
    if (!principal) return reply.status(401).send({ error: "Sign in required", code: "unauthorized" });
    // Browsers send cookies on their own, so changes made with the sign-in cookie must carry a
    // header that other sites cannot add without CORS permission (cross-site request forgery).
    if (cookieToken && !["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-zamtech-client"] === undefined) {
      return reply.status(403).send({ error: "Requests signed in with the cookie need the x-zamtech-client header", code: "csrf" });
    }
    req.principal = principal;
    if (principal.restriction && !RESTRICTED_ALLOWED.has(url)) {
      const message = principal.restriction === "email_unverified" ? "Confirm your email address first" : "Set up two-step sign-in first";
      return reply.status(403).send({ error: message, code: principal.restriction });
    }
    if (url.startsWith("/api/auth/")) return;
    const needed = requiredRole(req.method, url);
    if (!hasRole(principal, needed)) {
      return reply.status(403).send({ error: `This needs the ${needed} role`, code: "forbidden", needed });
    }
  });

  const me = (req: FastifyRequest): Principal => req.principal!;
  const bearer = (req: FastifyRequest) => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? "";
  /** The caller's session token, from the Authorization header or the sign-in cookie. */
  const sessionToken = (req: FastifyRequest) => bearer(req) || readCookie(req.headers.cookie, SESSION_COOKIE) || "";
  /** How an approval or key is attributed in the Portal. */
  const who = (p: Principal) => (p.kind === "user" ? `${p.name} <${p.email}>` : p.name);
  const limiter = new LoginLimiter();
  const emailSchema = z.string().trim().toLowerCase().email();
  const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`).max(200);
  // Emails are unique across workspaces: people sign in with their email alone.
  const findByEmail = (email: string) => Object.values(store.data.users).find((u) => u.email === email);
  const activeAdmins = (workspaceId: string) =>
    Object.values(store.data.users).filter((u) => u.workspaceId === workspaceId && u.role === "admin" && !u.disabled);

  /* Workspaces: every request acts inside the caller's workspace. Records of other
     workspaces do not exist for it (404), whatever id is asked for. */
  const ws = (req: FastifyRequest) => me(req).workspaceId;
  const own = <T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T => {
    const item = collection[id];
    if (!item || item.workspaceId !== ws(req)) throw new HttpError(404, `${what} ${id} not found`);
    return item;
  };
  const mine = <T extends { workspaceId: string }>(collection: Record<string, T>, req: FastifyRequest): T[] =>
    Object.values(collection).filter((item) => item.workspaceId === ws(req));
  /** The platform owner (not customers): the master token, local open mode, or an admin of the default workspace. */
  const platformAdmin = (p: Principal) => p.kind !== "user" || (p.workspaceId === DEFAULT_WORKSPACE && p.role === "admin");
  const signupLimiter = new LoginLimiter(10, 60 * 60 * 1000);
  const mailLimiter = new LoginLimiter(5, 60 * 60 * 1000);

  /* Email: single-use links to confirm an address or reset a password. */
  const mailer = options.mailer ?? null;
  const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
  const RESET_TTL_MS = 60 * 60 * 1000;
  const issueEmailToken = (user: User, purpose: "verify" | "reset") => {
    for (const t of Object.values(store.data.emailTokens)) {
      if (t.userId === user.id && t.purpose === purpose) delete store.data.emailTokens[t.id];
    }
    const token = newSecret();
    const ttl = purpose === "verify" ? VERIFY_TTL_MS : RESET_TTL_MS;
    store.data.emailTokens[hashToken(token)] = { id: hashToken(token), userId: user.id, purpose, expiresAt: new Date(Date.now() + ttl).toISOString() };
    store.save();
    return token;
  };
  const takeEmailToken = (token: string, purpose: "verify" | "reset"): User => {
    const entry = store.data.emailTokens[hashToken(token)];
    const user = entry && entry.purpose === purpose && Date.parse(entry.expiresAt) > Date.now() ? store.data.users[entry.userId] : undefined;
    if (!entry || !user || user.disabled) {
      throw new HttpError(400, purpose === "verify" ? "This confirmation link has expired or was already used." : "This reset link has expired or was already used.");
    }
    delete store.data.emailTokens[entry.id];
    return user;
  };
  const sendMail = async (to: string, mail: Omit<Mail, "to">) => {
    if (!mailer) throw new HttpError(503, "Email is not set up on this server");
    try {
      await mailer.send({ to, ...mail });
    } catch (err) {
      app.log.error(`Email to ${to} failed: ${(err as Error).message}`);
      throw new HttpError(502, "The email could not be sent; try again later");
    }
  };
  const sendVerification = (user: User) =>
    sendMail(user.email, emails.verify(user.name, `${config.portalUrl}/#/verify?token=${issueEmailToken(user, "verify")}`));

  /* --------------------------- auth + users ------------------------- */
  // Public: whether the Portal offers "Create an account".
  app.get("/api/auth/config", async () => ({ signup: config.allowSignup }));

  // A new customer: creates their workspace, with them as its administrator, and signs them in.
  app.post("/api/auth/signup", async (req, reply) => {
    if (!config.allowSignup) throw new HttpError(403, "Sign-up is not open on this server; ask an administrator for an account");
    // Without email, addresses cannot be confirmed: a public server must not accept unconfirmed sign-ups.
    if (!mailer && config.production) throw new HttpError(503, "Sign-up needs email to be set up on this server (SMTP_URL)");
    const ipKey = `signup:${req.ip}`;
    if (signupLimiter.blocked(ipKey)) return reply.status(429).send({ error: "Too many sign-ups; try again later", code: "rate_limited" });
    signupLimiter.fail(ipKey);
    const body = parse(
      z.object({ company: z.string().trim().min(2).max(100), name: z.string().trim().min(1).max(100), email: emailSchema, password: passwordSchema }),
      req.body,
    );
    if (findByEmail(body.email)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    const workspace: Workspace = { id: newId("ws"), name: body.company, createdAt: nowIso(), plan: "free" };
    const user: User = {
      id: newId("usr"),
      workspaceId: workspace.id,
      email: body.email,
      name: body.name,
      role: "admin",
      passwordHash: await hashPassword(body.password),
      // With email set up, the address is confirmed by a link before the workspace can be used.
      emailVerified: !mailer,
      createdAt: nowIso(),
      lastLoginAt: nowIso(),
    };
    store.data.workspaces[workspace.id] = workspace;
    store.data.users[user.id] = user;
    if (mailer) await sendVerification(user).catch((err) => app.log.error(err));
    reply.header("set-cookie", sessionCookie(createSession(store, user), cookieOptions));
    return reply.status(201).send({ user: publicUser(user), workspace, verifyEmail: Boolean(mailer) });
  });

  app.post("/api/auth/verify", async (req) => {
    const body = parse(z.object({ token: z.string().min(10) }), req.body);
    const user = takeEmailToken(body.token, "verify");
    user.emailVerified = true;
    store.save();
    return { ok: true, email: user.email };
  });

  app.post("/api/auth/verify/resend", async (req, reply) => {
    const p = me(req);
    const user = p.kind === "user" ? store.data.users[p.id] : undefined;
    if (!user || user.emailVerified !== false) return { ok: true };
    if (mailLimiter.blocked(`verify:${user.id}`)) return reply.status(429).send({ error: "Too many emails; try again later", code: "rate_limited" });
    mailLimiter.fail(`verify:${user.id}`);
    await sendVerification(user);
    return { ok: true };
  });

  // Always answers the same, so it does not reveal which emails have accounts.
  app.post("/api/auth/password-reset/request", async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase() }), req.body);
    const keys = [`reset:${req.ip}`, `reset:${body.email}`];
    if (mailLimiter.blocked(...keys)) return reply.status(429).send({ error: "Too many requests; try again later", code: "rate_limited" });
    mailLimiter.fail(...keys);
    const user = findByEmail(body.email);
    if (user && !user.disabled && mailer) {
      const link = `${config.portalUrl}/#/reset-password?token=${issueEmailToken(user, "reset")}`;
      await sendMail(user.email, emails.reset(user.name, link)).catch((err) => app.log.error(err));
    }
    return { ok: true, email: Boolean(mailer) };
  });

  /* ----------------------- company sign-in (SSO) ----------------------- */
  const oidc = options.oidc ?? new OidcClient();
  // The identity provider sends people back to the Portal's own address (so the cookie is set there).
  const ssoRedirectUri = `${config.portalUrl}/api/auth/sso/callback`;
  const ssoWorkspaceFor = (email: string) => {
    const domain = emailDomain(email);
    return Object.values(store.data.workspaces).find((w) => w.sso?.enabled && w.ssoDomains?.includes(domain) && limitsOf(w).sso);
  };
  const safeReturn = (value?: string) => {
    if (!value) return undefined;
    try {
      const url = new URL(value, config.portalUrl);
      return [new URL(config.portalUrl).origin, new URL(config.designerUrl).origin].includes(url.origin) ? url.href : undefined;
    } catch {
      return undefined;
    }
  };
  const ssoFailure = (message: string) => `${config.portalUrl}/?sso_error=${encodeURIComponent(message)}`;

  // The Portal asks after the email is typed: does this person sign in with their company?
  app.post("/api/auth/sso/discover", async (req) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), return: z.string().optional() }), req.body);
    const workspace = ssoWorkspaceFor(body.email);
    if (!workspace) return { sso: false };
    const params = new URLSearchParams({ workspace: workspace.id, login_hint: body.email });
    if (body.return) params.set("return", body.return);
    return { sso: true, enforced: Boolean(workspace.sso!.enforce), startUrl: `/api/auth/sso/start?${params}` };
  });

  app.get<{ Querystring: { workspace?: string; return?: string; login_hint?: string } }>("/api/auth/sso/start", async (req, reply) => {
    const workspace = store.data.workspaces[req.query.workspace ?? ""];
    if (!workspace?.sso?.enabled || !limitsOf(workspace).sso) return reply.redirect(ssoFailure("Company sign-in is not set up for this workspace"));
    const state = newSecret();
    const nonce = newSecret();
    const codeVerifier = newSecret();
    store.data.ssoStates[hashToken(state)] = {
      id: hashToken(state),
      workspaceId: workspace.id,
      nonce,
      codeVerifier,
      returnTo: safeReturn(req.query.return),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    store.save();
    try {
      return reply.redirect(await oidc.authorizationUrl(workspace.sso, { redirectUri: ssoRedirectUri, state, nonce, codeVerifier, loginHint: req.query.login_hint }));
    } catch (err) {
      return reply.redirect(ssoFailure((err as Error).message));
    }
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/auth/sso/callback", async (req, reply) => {
    const q = req.query;
    const saved = q.state ? store.data.ssoStates[hashToken(q.state)] : undefined;
    if (saved) delete store.data.ssoStates[saved.id];
    const fail = (message: string) => {
      store.save();
      return reply.redirect(ssoFailure(message));
    };
    if (q.error) return fail(q.error_description ?? q.error);
    if (!saved || Date.parse(saved.expiresAt) < Date.now() || !q.code) return fail("The sign-in took too long or was already used. Please try again.");
    const workspace = store.data.workspaces[saved.workspaceId];
    if (!workspace?.sso?.enabled) return fail("Company sign-in is not set up for this workspace");
    let identity;
    try {
      identity = await oidc.signIn(workspace.sso, { code: q.code, redirectUri: ssoRedirectUri, codeVerifier: saved.codeVerifier, nonce: saved.nonce });
    } catch (err) {
      app.log.warn(`SSO for workspace ${workspace.id} failed: ${(err as Error).message}`);
      return fail(err instanceof SsoError ? err.message : "Company sign-in failed");
    }
    if (!workspace.ssoDomains?.includes(emailDomain(identity.email))) return fail(`${identity.email} is not an address of this company's domains`);
    let user = findByEmail(identity.email);
    if (user && user.workspaceId !== workspace.id) return fail("This email already has an account in another workspace");
    if (user?.disabled) return fail("This account is disabled; ask your administrator");
    if (!user) {
      if (!workspace.sso.autoProvision) return fail("You do not have an account yet; ask your administrator to add you");
      try {
        if (isBuilder(workspace.sso.defaultRole)) checkBuilders(store, workspace.id);
      } catch (err) {
        return fail((err as Error).message);
      }
      user = {
        id: newId("usr"),
        workspaceId: workspace.id,
        email: identity.email,
        name: identity.name,
        role: workspace.sso.defaultRole,
        // No password: this account signs in through the company.
        passwordHash: "sso$",
        emailVerified: true,
        authSource: "sso",
        createdAt: nowIso(),
      };
      store.data.users[user.id] = user;
    }
    user.authSource = "sso";
    user.emailVerified = true;
    user.lastLoginAt = nowIso();
    reply.header("set-cookie", sessionCookie(createSession(store, user), cookieOptions));
    store.save();
    return reply.redirect(saved.returnTo ?? `${config.portalUrl}/`);
  });

  app.post("/api/auth/password-reset", async (req) => {
    const body = parse(z.object({ token: z.string().min(10), password: passwordSchema }), req.body);
    const user = takeEmailToken(body.token, "reset");
    user.passwordHash = await hashPassword(body.password);
    // Receiving the email proves the address; every other session ends.
    user.emailVerified = true;
    deleteUserSessions(store, user.id);
    store.save();
    return { ok: true, email: user.email };
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = parse(z.object({ email: z.string().trim().toLowerCase(), password: z.string() }), req.body);
    const ssoWorkspace = ssoWorkspaceFor(body.email);
    const existing = findByEmail(body.email);
    if (ssoWorkspace?.sso?.enforce && (!existing || existing.workspaceId === ssoWorkspace.id)) {
      return reply.status(403).send({ error: "Sign in with your company account", code: "sso_required" });
    }
    const keys = [`ip:${req.ip}`, `email:${body.email}`];
    if (limiter.blocked(...keys)) return reply.status(429).send({ error: "Too many attempts", code: "rate_limited" });
    const user = findByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !ok || user.disabled) {
      limiter.fail(...keys);
      return reply.status(401).send({ error: "Email or password is incorrect", code: "invalid_login" });
    }
    limiter.reset(...keys);
    // Two-step sign-in: the password was right; a code from the authenticator app is still needed.
    if (user.mfa?.enabled) {
      const mfaToken = newSecret();
      store.data.mfaChallenges[hashToken(mfaToken)] = { id: hashToken(mfaToken), userId: user.id, attempts: 0, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
      store.save();
      return { mfaRequired: true, mfaToken };
    }
    return signIn(user, reply);
  });

  const signIn = (user: User, reply: FastifyReply) => {
    user.lastLoginAt = nowIso();
    const token = createSession(store, user);
    reply.header("set-cookie", sessionCookie(token, cookieOptions));
    return { token, user: publicUser(user) };
  };

  /** Checks a 6-digit code (once per step) or a recovery code (once each). */
  const checkSecondFactor = (user: User, code?: string, recoveryCode?: string): boolean => {
    const mfa = user.mfa;
    if (!mfa?.enabled || !mfa.secret) return false;
    if (code) {
      const step = verifyTotp(mfa.secret, code, Date.now(), mfa.lastStep ?? -1);
      if (step === null) return false;
      mfa.lastStep = step;
      store.save();
      return true;
    }
    if (recoveryCode) {
      const index = mfa.recoveryCodes.indexOf(hashRecoveryCode(recoveryCode));
      if (index < 0) return false;
      mfa.recoveryCodes.splice(index, 1);
      store.save();
      return true;
    }
    return false;
  };

  app.post("/api/auth/login/mfa", async (req, reply) => {
    const body = parse(z.object({ mfaToken: z.string(), code: z.string().optional(), recoveryCode: z.string().optional() }), req.body);
    const challenge = store.data.mfaChallenges[hashToken(body.mfaToken)];
    const user = challenge && Date.parse(challenge.expiresAt) > Date.now() ? store.data.users[challenge.userId] : undefined;
    if (!challenge || !user || user.disabled) {
      return reply.status(401).send({ error: "The sign-in has expired; enter your password again", code: "mfa_expired" });
    }
    if (!checkSecondFactor(user, body.code, body.recoveryCode)) {
      challenge.attempts++;
      if (challenge.attempts >= 5) delete store.data.mfaChallenges[challenge.id];
      store.save();
      return reply.status(401).send({ error: "That code is not right", code: challenge.attempts >= 5 ? "mfa_expired" : "invalid_code" });
    }
    delete store.data.mfaChallenges[challenge.id];
    return signIn(user, reply);
  });

  /* two-step sign-in: set up and manage your own */
  const myUser = (req: FastifyRequest): User => {
    const p = me(req);
    const user = p.kind === "user" ? store.data.users[p.id] : undefined;
    if (!user) throw new HttpError(400, "Only user accounts have two-step sign-in");
    return user;
  };
  app.get("/api/auth/mfa", async (req) => {
    const user = myUser(req);
    return {
      enabled: Boolean(user.mfa?.enabled),
      required: Boolean(store.data.workspaces[user.workspaceId]?.security?.requireMfa) && user.authSource !== "sso",
      recoveryCodesLeft: user.mfa?.enabled ? user.mfa.recoveryCodes.length : 0,
    };
  });
  app.post("/api/auth/mfa/setup", async (req) => {
    const user = myUser(req);
    if (user.mfa?.enabled) throw new HttpError(409, "Two-step sign-in is already on");
    const secret = newTotpSecret();
    user.mfa = { enabled: false, pendingSecret: secret, recoveryCodes: [] };
    store.save();
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  });
  app.post("/api/auth/mfa/enable", async (req) => {
    const user = myUser(req);
    const body = parse(z.object({ code: z.string() }), req.body);
    const pending = user.mfa?.pendingSecret;
    const step = pending ? verifyTotp(pending, body.code) : null;
    if (!pending || step === null) throw new HttpError(400, "That code is not right. Check the time on your phone and try the newest code.");
    const recoveryCodes = newRecoveryCodes();
    user.mfa = { enabled: true, secret: pending, recoveryCodes: recoveryCodes.map(hashRecoveryCode), lastStep: step };
    store.save();
    // Shown once: the person keeps them somewhere safe.
    return { recoveryCodes };
  });
  app.post("/api/auth/mfa/recovery-codes", async (req) => {
    const user = myUser(req);
    const body = parse(z.object({ code: z.string() }), req.body);
    if (!checkSecondFactor(user, body.code)) throw new HttpError(400, "That code is not right");
    const recoveryCodes = newRecoveryCodes();
    user.mfa!.recoveryCodes = recoveryCodes.map(hashRecoveryCode);
    store.save();
    return { recoveryCodes };
  });
  app.post("/api/auth/mfa/disable", async (req) => {
    const user = myUser(req);
    const body = parse(z.object({ password: z.string() }), req.body);
    if (store.data.workspaces[user.workspaceId]?.security?.requireMfa) throw new HttpError(409, "Your workspace requires two-step sign-in");
    if (!(await verifyPassword(body.password, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    user.mfa = undefined;
    store.save();
    return { ok: true };
  });

  // Sign-in with the master access token (emergencies, first-time setup) opens a normal cookie session.
  app.post("/api/auth/token", async (req, reply) => {
    const body = parse(z.object({ token: z.string().trim() }), req.body);
    const keys = [`ip:${req.ip}`];
    if (limiter.blocked(...keys)) return reply.status(429).send({ error: "Too many attempts", code: "rate_limited" });
    if (!config.adminToken || !safeEqual(body.token, config.adminToken)) {
      limiter.fail(...keys);
      return reply.status(401).send({ error: "The access token is incorrect", code: "invalid_token" });
    }
    limiter.reset(...keys);
    reply.header("set-cookie", sessionCookie(createSession(store, MASTER_SESSION), cookieOptions));
    return { ok: true };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = sessionToken(req);
    if (token) deleteSession(store, token);
    reply.header("set-cookie", clearedSessionCookie(cookieOptions));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const p = me(req);
    const workspace = store.data.workspaces[p.workspaceId];
    return {
      id: p.id,
      name: p.name,
      email: p.email,
      role: p.role,
      kind: p.kind,
      workspace: { id: p.workspaceId, name: workspace?.name ?? "" },
      platformAdmin: platformAdmin(p),
      restriction: p.restriction,
    };
  });

  app.post("/api/auth/password", async (req) => {
    const p = me(req);
    if (p.kind !== "user") throw new HttpError(400, "Only user accounts have a password");
    const body = parse(z.object({ current: z.string(), next: passwordSchema }), req.body);
    const user = get(store.data.users, p.id, "User");
    if (!(await verifyPassword(body.current, user.passwordHash))) throw new HttpError(400, "Current password is incorrect");
    user.passwordHash = await hashPassword(body.next);
    deleteUserSessions(store, user.id, sessionToken(req));
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

  app.get("/api/users", async (req) =>
    mine(store.data.users, req)
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.name.localeCompare(b.name))
      .map(publicUser),
  );

  app.post("/api/users", async (req, reply) => {
    const body = parse(UserBody, req.body);
    if (findByEmail(body.email)) throw new HttpError(409, `A user with email ${body.email} already exists`);
    if (isBuilder(body.role) && !body.disabled) checkBuilders(store, ws(req));
    const user: User = {
      id: newId("usr"),
      workspaceId: ws(req),
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
    const user = own(store.data.users, req.params.id, "User", req);
    const body = parse(UserBody.partial().extend({ password: passwordSchema.optional().or(z.literal("")) }), req.body);
    const losesAdmin = user.role === "admin" && ((body.role && body.role !== "admin") || body.disabled === true);
    if (losesAdmin && activeAdmins(user.workspaceId).length <= 1) throw new HttpError(409, "Keep at least one active administrator");
    if (body.email && body.email !== user.email && findByEmail(body.email)) {
      throw new HttpError(409, `A user with email ${body.email} already exists`);
    }
    // Becoming a Developer or Admin (or being re-enabled as one) takes a builder seat.
    const wasSeat = isBuilder(user.role) && !user.disabled;
    const isSeat = isBuilder(body.role ?? user.role) && !(body.disabled ?? user.disabled);
    if (isSeat && !wasSeat) checkBuilders(store, user.workspaceId);
    if (body.email) user.email = body.email;
    if (body.name) user.name = body.name;
    if (body.role) user.role = body.role;
    if (body.disabled !== undefined) user.disabled = body.disabled;
    if (body.password) user.passwordHash = await hashPassword(body.password);
    if (body.password || body.disabled) deleteUserSessions(store, user.id);
    store.save();
    return publicUser(user);
  });

  // For a lost phone without recovery codes: the person sets two-step sign-in up again.
  app.post<{ Params: { id: string } }>("/api/users/:id/mfa/reset", async (req) => {
    const user = own(store.data.users, req.params.id, "User", req);
    user.mfa = undefined;
    deleteUserSessions(store, user.id);
    store.save();
    return publicUser(user);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const user = own(store.data.users, req.params.id, "User", req);
    if (user.id === me(req).id) throw new HttpError(409, "You cannot delete your own account");
    if (user.role === "admin" && !user.disabled && activeAdmins(user.workspaceId).length <= 1) {
      throw new HttpError(409, "Keep at least one active administrator");
    }
    delete store.data.users[user.id];
    deleteUserSessions(store, user.id);
    return reply.status(204).send();
  });

  /* ------------------------------ backups --------------------------- */
  // The whole database, all workspaces: for the platform owner only.
  const requirePlatformAdmin = (req: FastifyRequest) => {
    if (!platformAdmin(me(req))) throw new HttpError(403, "Only the platform owner can do this");
  };
  app.get("/api/admin/backup", async (req) => {
    requirePlatformAdmin(req);
    return options.backup?.getStatus() ?? { configured: false, running: false };
  });
  app.post("/api/admin/backup", async (req) => {
    requirePlatformAdmin(req);
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
  // Public: the agent's tray app reads where the Portal and Designer are.
  app.get("/api/health", async () => ({ ok: true, time: nowIso(), portalUrl: config.portalUrl, designerUrl: config.designerUrl }));
  app.get("/api/actions", async () => BUILTIN_ACTIONS);
  app.get("/api/stats", async (req) => {
    const jobs = mine(store.data.jobs, req);
    const agents = mine(store.data.agents, req);
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
      workflows: mine(store.data.workflows, req).length,
      packages: mine(store.data.packages, req).length,
      schedules: mine(store.data.schedules, req).filter((s) => s.enabled).length,
      healedSelectors: jobs.reduce((n, j) => n + j.healedSelectors.length, 0),
      ai: { configured: ai === undefined ? AiClient.isConfigured() : Boolean(ai) },
    };
  });

  /* ---------------------------- workflows --------------------------- */
  app.get("/api/workflows", async (req) =>
    mine(store.data.workflows, req)
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
    const wf: WorkflowDraft = { id, workspaceId: ws(req), name, description: body.description, definition: { ...definition, id, name }, createdAt: nowIso(), updatedAt: nowIso() };
    store.data.workflows[id] = wf;
    store.save();
    return reply.status(201).send(wf);
  });

  app.get<{ Params: { id: string } }>("/api/workflows/:id", async (req) => own(store.data.workflows, req.params.id, "Workflow", req));

  app.put<{ Params: { id: string } }>("/api/workflows/:id", async (req) => {
    const wf = own(store.data.workflows, req.params.id, "Workflow", req);
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
    own(store.data.workflows, req.params.id, "Workflow", req);
    delete store.data.workflows[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/workflows/:id/publish", async (req, reply) => {
    const wf = own(store.data.workflows, req.params.id, "Workflow", req);
    const body = parse(z.object({ releaseNotes: z.string().optional() }).default({}), req.body ?? {});
    const previous = Object.values(store.data.packages).filter((p) => p.workflowId === wf.id);
    const pkg: Package = {
      id: newId("pkg"),
      workspaceId: wf.workspaceId,
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
  app.get("/api/packages", async (req) =>
    mine(store.data.packages, req)
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
      .map(({ definition, ...rest }) => ({ ...rest, variables: definition.variables })),
  );
  app.get<{ Params: { id: string } }>("/api/packages/:id", async (req) => own(store.data.packages, req.params.id, "Package", req));
  app.delete<{ Params: { id: string } }>("/api/packages/:id", async (req, reply) => {
    own(store.data.packages, req.params.id, "Package", req);
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
    return mine(store.data.jobs, req)
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
    const job = createJob(store, { ...body, workspaceId: who.workspaceId, startedBy: who.email || who.name });
    return reply.status(201).send(jobSummary(job));
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => own(store.data.jobs, req.params.id, "Job", req));

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/jobs/:id/logs", async (req) => {
    own(store.data.jobs, req.params.id, "Job", req);
    const after = Number(req.query.after ?? 0);
    return (store.data.jobLogs[req.params.id] ?? []).filter((l) => l.seq > after);
  });

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    const job = own(store.data.jobs, req.params.id, "Job", req);
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
  app.get("/api/agents", async (req) =>
    mine(store.data.agents, req)
      .map(({ tokenHash: _secret, ...agent }) => agent)
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    own(store.data.agents, req.params.id, "Agent", req);
    delete store.data.agents[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ----------------------------- schedules -------------------------- */
  const withNextRun = (s: Schedule) => ({ ...s, nextRunAt: scheduler.nextRun(s.id) });
  const checkSchedule = (body: z.infer<typeof ScheduleBody>, req: FastifyRequest) => {
    own(store.data.packages, body.packageId, "Package", req);
    if (body.targetAgentId) own(store.data.agents, body.targetAgentId, "Agent", req);
    const cronError = validateCron(body.cron, body.timezone);
    if (cronError) throw new HttpError(400, `Invalid cron expression: ${cronError}`);
  };

  app.get("/api/schedules", async (req) => mine(store.data.schedules, req).map(withNextRun));
  app.post("/api/schedules", async (req, reply) => {
    const body = parse(ScheduleBody, req.body);
    checkSchedule(body, req);
    if (body.enabled) checkFeature(store, ws(req), "schedules");
    const schedule: Schedule = { id: newId("sch"), workspaceId: ws(req), ...body, createdAt: nowIso() };
    store.data.schedules[schedule.id] = schedule;
    store.save();
    scheduler.sync(schedule);
    return reply.status(201).send(withNextRun(schedule));
  });
  app.put<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const existing = own(store.data.schedules, req.params.id, "Schedule", req);
    const body = parse(ScheduleBody, { ...existing, ...(req.body as object) });
    checkSchedule(body, req);
    if (body.enabled && !existing.enabled) checkFeature(store, ws(req), "schedules");
    const schedule: Schedule = { ...existing, ...body, workspaceId: existing.workspaceId };
    store.data.schedules[schedule.id] = schedule;
    store.save();
    scheduler.sync(schedule);
    return withNextRun(schedule);
  });
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    own(store.data.schedules, req.params.id, "Schedule", req);
    delete store.data.schedules[req.params.id];
    store.save();
    scheduler.sync(undefined, req.params.id);
    return reply.status(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req) => {
    own(store.data.schedules, req.params.id, "Schedule", req);
    checkFeature(store, ws(req), "schedules");
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

  app.get("/api/queues", async (req) => mine(store.data.queues, req).sort((a, b) => a.name.localeCompare(b.name)).map(withCounts));

  app.post("/api/queues", async (req, reply) => {
    const body = parse(QueueBody, req.body);
    if (mine(store.data.queues, req).some((q) => q.name.toLowerCase() === body.name.toLowerCase())) {
      throw new HttpError(409, `Queue "${body.name}" already exists`);
    }
    const queue: Queue = { id: newId("que"), workspaceId: ws(req), ...body, createdAt: nowIso() };
    store.data.queues[queue.id] = queue;
    store.save();
    return reply.status(201).send(withCounts(queue));
  });

  app.put<{ Params: { id: string } }>("/api/queues/:id", async (req) => {
    const queue = own(store.data.queues, req.params.id, "Queue", req);
    const body = parse(QueueBody.partial(), req.body);
    Object.assign(queue, Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
    store.save();
    return withCounts(queue);
  });

  app.delete<{ Params: { id: string } }>("/api/queues/:id", async (req, reply) => {
    own(store.data.queues, req.params.id, "Queue", req);
    delete store.data.queues[req.params.id];
    for (const item of Object.values(store.data.queueItems)) if (item.queueId === req.params.id) delete store.data.queueItems[item.id];
    store.save();
    return reply.status(204).send();
  });

  app.get<{ Params: { id: string }; Querystring: { status?: string; limit?: string } }>("/api/queues/:id/items", async (req) => {
    own(store.data.queues, req.params.id, "Queue", req);
    const limit = Math.min(Number(req.query.limit ?? 200), 2000);
    return Object.values(store.data.queueItems)
      .filter((i) => i.queueId === req.params.id && (!req.query.status || i.status === req.query.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  });

  app.post<{ Params: { id: string } }>("/api/queues/:id/items", async (req, reply) => {
    const queue = own(store.data.queues, req.params.id, "Queue", req);
    const body = parse(z.object({ data: z.unknown(), reference: z.string().trim().max(200).optional() }), req.body);
    return reply.status(201).send(addItem(store, queue, body.data ?? {}, body.reference));
  });

  app.post<{ Params: { id: string } }>("/api/queue-items/:id/retry", async (req) => {
    const item = own(store.data.queueItems, req.params.id, "Queue item", req);
    if (item.status !== "failed" && item.status !== "business-exception") {
      throw new HttpError(409, "Only failed items can be retried");
    }
    Object.assign(item, { status: "new", jobId: undefined, agentId: undefined, startedAt: undefined, finishedAt: undefined });
    store.save();
    return item;
  });

  app.delete<{ Params: { id: string } }>("/api/queue-items/:id", async (req, reply) => {
    own(store.data.queueItems, req.params.id, "Queue item", req);
    delete store.data.queueItems[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ------------------------------ assets ---------------------------- */
  app.get("/api/assets", async (req) => mine(store.data.assets, req).map(maskAsset));
  app.post("/api/assets", async (req, reply) => {
    const body = parse(AssetBody, req.body);
    if (mine(store.data.assets, req).some((a) => a.name === body.name)) {
      throw new HttpError(409, `Asset "${body.name}" already exists`);
    }
    const asset: Asset = { id: newId("ast"), workspaceId: ws(req), ...body, value: body.value ?? null, updatedAt: nowIso() };
    store.data.assets[asset.id] = asset;
    store.save();
    return reply.status(201).send(maskAsset(asset));
  });
  app.put<{ Params: { id: string } }>("/api/assets/:id", async (req) => {
    const existing = own(store.data.assets, req.params.id, "Asset", req);
    const body = parse(AssetBody.partial(), req.body);
    if (body.name && body.name !== existing.name && mine(store.data.assets, req).some((a) => a.name === body.name)) {
      throw new HttpError(409, `Asset "${body.name}" already exists`);
    }
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
    own(store.data.assets, req.params.id, "Asset", req);
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
    getAi();
    useAi(store, ws(req));
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
    getAi();
    useAi(store, ws(req));
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
  /** The calling agent: from its own credential, or (shared key) from the agentId it sends. */
  const agentFor = (req: FastifyRequest): Agent => {
    const agentId = req.agent?.id ?? (req.body as { agentId?: unknown } | undefined)?.agentId;
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
    // Shared-key agents may only take over records of other shared-key agents, never an approved PC.
    // The shared key belongs to the platform owner, so its agents work for the default workspace.
    const sharedKeyAgent = (a: Agent | undefined) => a && !a.tokenHash && a.workspaceId === DEFAULT_WORKSPACE ? a : undefined;
    const existing = req.agent
      ? store.data.agents[req.agent.id]
      : (body.agentId && sharedKeyAgent(store.data.agents[body.agentId])) ||
        Object.values(store.data.agents).find((a) => sharedKeyAgent(a) && a.name === body.name && a.machine === body.machine);
    const info = { name: body.name, machine: body.machine, os: body.os, version: body.version };
    const agent: Agent = existing
      ? { ...existing, ...info, status: "online", currentJobId: undefined, lastHeartbeat: nowIso() }
      : { id: newId("agt"), workspaceId: DEFAULT_WORKSPACE, ...info, status: "online", lastHeartbeat: nowIso(), registeredAt: nowIso() };
    store.data.agents[agent.id] = agent;
    // Jobs that were running on this agent before it restarted are lost.
    for (const job of Object.values(store.data.jobs)) {
      if (job.agentId === agent.id && !isFinal(job) && job.status !== "pending") finishJob(store, job, "failed", "Agent restarted");
    }
    store.save();
    return { agentId: agent.id };
  });

  app.post("/api/agent/heartbeat", async (req) => {
    const agent = agentFor(req);
    store.save();
    const cancelJobIds = Object.values(store.data.jobs)
      .filter((j) => j.agentId === agent.id && j.status === "cancelling")
      .map((j) => j.id);
    return { cancelJobIds };
  });

  app.post("/api/agent/jobs/next", async (req, reply) => {
    const agent = agentFor(req);
    if (agent.currentJobId && store.data.jobs[agent.currentJobId] && !isFinal(store.data.jobs[agent.currentJobId]!)) {
      return reply.status(204).send();
    }
    const job = Object.values(store.data.jobs)
      .filter((j) => j.workspaceId === agent.workspaceId && j.status === "pending" && (!j.targetAgentId || j.targetAgentId === agent.id))
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
    const agent = agentFor(req);
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
      z.object({ agentId: z.string().optional(), status: z.enum(["succeeded", "failed", "cancelled"]), error: z.string().optional(), outputs: z.record(z.unknown()).optional() }),
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
    agentFor(req);
    const body = parse(z.object({ data: z.unknown(), reference: z.string().trim().max(200).optional() }).passthrough(), req.body);
    const item = addItem(store, findQueue(store, req.params.name, agentFor(req).workspaceId), body.data ?? {}, body.reference);
    return reply.status(201).send({ id: item.id });
  });

  app.post<{ Params: { name: string } }>("/api/agent/queues/:name/next", async (req, reply) => {
    const agent = agentFor(req);
    const item = takeNext(store, findQueue(store, req.params.name, agent.workspaceId), jobOfAgent(agent, agentBody(req).jobId), agent.id);
    if (!item) return reply.status(204).send();
    const queue = store.data.queues[item.queueId]!;
    return { id: item.id, queue: queue.name, reference: item.reference, data: item.data, retries: item.retries };
  });

  app.post<{ Params: { id: string } }>("/api/agent/queue-items/:id/complete", async (req) => {
    const agent = agentFor(req);
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
    // Shared-key agents send no agentId here; they work for the default workspace.
    const workspaceId = req.agent?.workspaceId ?? DEFAULT_WORKSPACE;
    const asset = Object.values(store.data.assets).find((a) => a.workspaceId === workspaceId && a.name === req.params.name);
    if (!asset) throw new HttpError(404, `Asset "${req.params.name}" not found`);
    return { name: asset.name, type: asset.type, value: asset.value };
  });

  /* ------------- connecting a PC: approval in the Portal ------------- */
  // Like signing in to a TV app: the agent shows a link with a short code, a signed-in
  // user approves it in the Portal, and the agent receives its own credential.
  const ENROLL_TTL_MS = 15 * 60 * 1000;
  const MAX_PENDING_ENROLLMENTS = 500;
  const enrollLimiter = new LoginLimiter(30, 10 * 60 * 1000);
  const EnrollBody = z.object({
    name: z.string().trim().min(1).max(100),
    machine: z.string().max(200).default(""),
    os: z.string().max(200).default(""),
    version: z.string().max(50).default(""),
    installKey: z.string().trim().optional(),
  });
  const approvalUrl = (userCode: string) => `${config.portalUrl}/#/connect?code=${userCode}`;

  const usableInstallKey = (key: string): InstallKey | undefined => {
    const hash = hashToken(key);
    const found = Object.values(store.data.installKeys).find((k) => safeEqual(k.keyHash, hash));
    if (!found || (found.expiresAt && Date.parse(found.expiresAt) < Date.now())) return undefined;
    if (found.maxUses !== undefined && found.uses >= found.maxUses) return undefined;
    return found;
  };

  app.post("/api/agent/enroll/start", async (req, reply) => {
    const ipKey = `enroll:${req.ip}`;
    if (enrollLimiter.blocked(ipKey)) return reply.status(429).send({ error: "Too many requests; try again in a few minutes", code: "rate_limited" });
    enrollLimiter.fail(ipKey);
    const body = parse(EnrollBody, req.body);
    const pending = Object.values(store.data.enrollments).filter((e) => e.status === "pending").length;
    if (pending >= MAX_PENDING_ENROLLMENTS) return reply.status(503).send({ error: "Too many PCs are waiting for approval; try again later" });
    let approvedBy: string | undefined;
    let approvedFor: string | undefined;
    if (body.installKey) {
      const key = usableInstallKey(body.installKey);
      if (!key) return reply.status(401).send({ error: "The install key is invalid, expired or used up", code: "invalid_install_key" });
      checkBots(store, key.workspaceId);
      key.uses++;
      approvedBy = `Install key "${key.name}"`;
      approvedFor = key.workspaceId;
    }
    const deviceCode = newSecret();
    const taken = new Set(Object.values(store.data.enrollments).map((e) => e.userCode));
    let userCode = newUserCode();
    while (taken.has(userCode)) userCode = newUserCode();
    const enrollment: Enrollment = {
      id: hashToken(deviceCode),
      userCode,
      name: body.name,
      machine: body.machine,
      os: body.os,
      version: body.version,
      status: approvedBy ? "approved" : "pending",
      approvedBy,
      workspaceId: approvedFor,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + ENROLL_TTL_MS).toISOString(),
    };
    store.data.enrollments[enrollment.id] = enrollment;
    store.save();
    return {
      deviceCode,
      userCode,
      verificationUrl: approvalUrl(userCode),
      portalUrl: config.portalUrl,
      designerUrl: config.designerUrl,
      expiresIn: ENROLL_TTL_MS / 1000,
      interval: 3,
      approved: Boolean(approvedBy),
    };
  });

  app.post("/api/agent/enroll/poll", async (req) => {
    const body = parse(z.object({ deviceCode: z.string().min(20) }), req.body);
    const enrollment = store.data.enrollments[hashToken(body.deviceCode)];
    if (!enrollment || Date.parse(enrollment.expiresAt) < Date.now()) return { status: "expired" };
    if (enrollment.status === "pending") return { status: "pending" };
    delete store.data.enrollments[enrollment.id];
    if (enrollment.status === "denied") {
      store.save();
      return { status: "denied" };
    }
    // The credential is handed over once and only its hash is kept.
    const agentToken = newSecret();
    const agent: Agent = {
      id: newId("agt"),
      workspaceId: enrollment.workspaceId ?? DEFAULT_WORKSPACE,
      name: enrollment.name,
      machine: enrollment.machine,
      os: enrollment.os,
      version: enrollment.version,
      status: "offline",
      lastHeartbeat: nowIso(),
      registeredAt: nowIso(),
      tokenHash: hashToken(agentToken),
      approvedBy: enrollment.approvedBy,
    };
    store.data.agents[agent.id] = agent;
    store.save();
    return { status: "approved", agentId: agent.id, agentToken, name: agent.name, approvedBy: agent.approvedBy, portalUrl: config.portalUrl, designerUrl: config.designerUrl };
  });

  const enrollmentByCode = (code: string): Enrollment => {
    const wanted = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const found = Object.values(store.data.enrollments).find((e) => e.userCode.replace("-", "") === wanted && Date.parse(e.expiresAt) > Date.now());
    if (!found) throw new HttpError(404, "This code has expired or does not exist. Start the ZamTech AI Agent on the PC again for a new one.");
    return found;
  };
  const publicEnrollment = (e: Enrollment) => ({
    userCode: e.userCode,
    name: e.name,
    machine: e.machine,
    os: e.os,
    version: e.version,
    status: e.status,
    approvedBy: e.approvedBy,
    expiresAt: e.expiresAt,
  });
  const decide = (req: FastifyRequest<{ Params: { code: string } }>, status: "approved" | "denied") => {
    const enrollment = enrollmentByCode(req.params.code);
    if (enrollment.status !== "pending") throw new HttpError(409, `This PC was already ${enrollment.status}`);
    if (status === "approved") checkBots(store, ws(req));
    enrollment.status = status;
    enrollment.approvedBy = who(me(req));
    // The PC joins the approver's workspace.
    enrollment.workspaceId = ws(req);
    store.save();
    return publicEnrollment(enrollment);
  };
  // Reading needs any role; approving needs Developer (an approved PC can read asset values).
  app.get<{ Params: { code: string } }>("/api/enrollments/:code", async (req) => {
    const enrollment = enrollmentByCode(req.params.code);
    // Once decided, a request is only visible in the workspace that decided it.
    if (enrollment.status !== "pending" && enrollment.workspaceId !== ws(req)) throw new HttpError(404, "This code has expired or does not exist.");
    return publicEnrollment(enrollment);
  });
  app.post<{ Params: { code: string } }>("/api/enrollments/:code/approve", async (req) => decide(req, "approved"));
  app.post<{ Params: { code: string } }>("/api/enrollments/:code/deny", async (req) => decide(req, "denied"));

  /* install keys: silent installs by IT (admin only, via the /api/admin prefix) */
  const publicInstallKey = ({ keyHash: _secret, ...key }: InstallKey) => key;
  app.get("/api/admin/install-keys", async (req) =>
    mine(store.data.installKeys, req)
      .map(publicInstallKey)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  );
  app.post("/api/admin/install-keys", async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        maxUses: z.number().int().min(1).max(100_000).optional(),
      }),
      req.body,
    );
    checkFeature(store, ws(req), "installKeys");
    const key = `ztik_${newSecret()}`;
    const installKey: InstallKey = {
      id: newId("ik"),
      workspaceId: ws(req),
      name: body.name,
      keyHash: hashToken(key),
      createdAt: nowIso(),
      createdBy: who(me(req)),
      expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : undefined,
      maxUses: body.maxUses,
      uses: 0,
    };
    store.data.installKeys[installKey.id] = installKey;
    store.save();
    // The key is shown once; only its hash is kept.
    return reply.status(201).send({ ...publicInstallKey(installKey), key });
  });
  app.delete<{ Params: { id: string } }>("/api/admin/install-keys/:id", async (req, reply) => {
    own(store.data.installKeys, req.params.id, "Install key", req);
    delete store.data.installKeys[req.params.id];
    store.save();
    return reply.status(204).send();
  });

  /* ------------------------- workspace and plan ------------------------ */
  // Anyone can have an address there, so no company can claim them for SSO.
  const PUBLIC_EMAIL_DOMAINS = new Set([
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
    "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com",
    "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "126.com",
  ]);
  const workspaceSummary = (workspace: Workspace) => ({
    ssoDomains: workspace.ssoDomains ?? [],
    billingAvailable: Boolean(options.billing),
    id: workspace.id,
    name: workspace.name,
    plan: workspace.plan,
    seats: workspace.seats,
    limits: limitsOf(workspace),
    usage: currentUsage(store, workspace.id),
    billing: workspace.billing
      ? {
          status: workspace.billing.status,
          interval: workspace.billing.interval,
          currentPeriodEnd: workspace.billing.currentPeriodEnd,
          cancelAtPeriodEnd: workspace.billing.cancelAtPeriodEnd,
        }
      : undefined,
  });
  app.get("/api/workspace", async (req) => workspaceSummary(get(store.data.workspaces, ws(req), "Workspace")));
  app.put("/api/workspace", async (req) => {
    if (me(req).role !== "admin") throw new HttpError(403, "This needs the admin role");
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    const body = parse(z.object({ name: z.string().trim().min(2).max(100) }), req.body);
    workspace.name = body.name;
    store.save();
    return workspaceSummary(workspace);
  });

  const requireAdmin = (req: FastifyRequest) => {
    if (me(req).role !== "admin") throw new HttpError(403, "This needs the admin role");
  };
  app.get("/api/workspace/sso", async (req) => {
    requireAdmin(req);
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    const { clientSecret, ...settings } = workspace.sso ?? { enabled: false, issuer: "", clientId: "", clientSecret: "", defaultRole: "operator", autoProvision: true, enforce: false };
    return { available: limitsOf(workspace).sso, domains: workspace.ssoDomains ?? [], redirectUri: ssoRedirectUri, settings: { ...settings, secretSet: Boolean(clientSecret) } };
  });
  app.put("/api/workspace/sso", async (req) => {
    requireAdmin(req);
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    checkFeature(store, workspace.id, "sso");
    const body = parse(
      z.object({
        enabled: z.boolean(),
        issuer: z.string().trim().url().or(z.literal("")),
        clientId: z.string().trim().max(300),
        clientSecret: z.string().max(2000).optional(),
        defaultRole: z.enum(["admin", "developer", "operator", "viewer"]).default("operator"),
        autoProvision: z.boolean().default(true),
        enforce: z.boolean().default(false),
      }),
      req.body,
    );
    const clientSecret = body.clientSecret || workspace.sso?.clientSecret || "";
    if (body.enabled) {
      if (!workspace.ssoDomains?.length) throw new HttpError(409, "ZamTech AI has not set up your company's email domains yet; contact us to add them");
      if (!body.issuer || !body.clientId || !clientSecret) throw new HttpError(400, "Enter the issuer, client ID and client secret from your identity provider");
      try {
        await oidc.discover(body.issuer);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    workspace.sso = { ...body, issuer: body.issuer.replace(/\/+$/, ""), clientSecret };
    store.save();
    return { ok: true };
  });

  app.get("/api/workspace/security", async (req) => get(store.data.workspaces, ws(req), "Workspace").security ?? {});
  app.put("/api/workspace/security", async (req) => {
    if (me(req).role !== "admin") throw new HttpError(403, "This needs the admin role");
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    const body = parse(z.object({ requireMfa: z.boolean().optional() }), req.body);
    // Otherwise the admin would lock themselves out of this very page.
    const admin = me(req).kind === "user" ? store.data.users[me(req).id] : undefined;
    if (body.requireMfa && admin && !admin.mfa?.enabled && admin.authSource !== "sso") {
      throw new HttpError(409, "Turn on two-step sign-in for your own account first");
    }
    workspace.security = { ...workspace.security, ...body };
    store.save();
    return workspace.security;
  });

  /* platform owner: all customers, and plans agreed outside Stripe (Enterprise) */
  app.get("/api/platform/workspaces", async (req) => {
    requirePlatformAdmin(req);
    return Object.values(store.data.workspaces)
      .map((w) => ({ ...workspaceSummary(w), createdAt: w.createdAt, users: Object.values(store.data.users).filter((u) => u.workspaceId === w.id).length }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  const LimitsBody = z
    .object({
      builders: z.number().int().min(1),
      bots: z.number().int().min(1),
      runsPerMonth: z.number().int().min(0),
      aiPerMonth: z.number().int().min(0),
      schedules: z.boolean(),
      installKeys: z.boolean(),
    })
    .partial();
  app.put<{ Params: { id: string } }>("/api/platform/workspaces/:id", async (req) => {
    requirePlatformAdmin(req);
    const workspace = get(store.data.workspaces, req.params.id, "Workspace");
    const body = parse(
      z.object({
        name: z.string().trim().min(2).max(100).optional(),
        plan: z.enum(["free", "pro", "enterprise"]).optional(),
        ssoDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter domains like acme.com")).max(50).optional(),
        seats: z.object({ builders: z.number().int().min(1), bots: z.number().int().min(1) }).optional(),
        customLimits: LimitsBody.nullable().optional(),
      }),
      req.body,
    );
    if (body.name) workspace.name = body.name;
    if (body.ssoDomains) {
      for (const domain of body.ssoDomains) {
        if (PUBLIC_EMAIL_DOMAINS.has(domain)) throw new HttpError(400, `${domain} is a public email service and cannot belong to one company`);
        const other = Object.values(store.data.workspaces).find((w) => w.id !== workspace.id && w.ssoDomains?.includes(domain));
        if (other) throw new HttpError(409, `${domain} already belongs to ${other.name}`);
      }
      workspace.ssoDomains = [...new Set(body.ssoDomains)];
    }
    if (body.plan) workspace.plan = body.plan;
    if (body.seats) workspace.seats = body.seats;
    if (body.customLimits !== undefined) workspace.customLimits = body.customLimits ?? undefined;
    store.save();
    return workspaceSummary(workspace);
  });

  /* ------------------------ billing (Stripe) ------------------------ */
  const billing = options.billing ?? null;
  const needBilling = () => {
    if (!billing) throw new HttpError(503, "Online payments are not set up on this server");
    return billing;
  };
  const isPaid = (status?: string) => PAID_STATUSES.includes(status ?? "");

  /** Keeps a workspace's plan and seats in step with its Stripe subscription. */
  const applySubscription = (state: SubscriptionState) => {
    const workspace =
      (state.workspaceId ? store.data.workspaces[state.workspaceId] : undefined) ??
      Object.values(store.data.workspaces).find((w) => w.billing?.customerId === state.customerId);
    if (!workspace) {
      app.log.warn(`Billing: no workspace for Stripe subscription ${state.subscriptionId}`);
      return;
    }
    // A leftover event of an older subscription must not end the one that is paid now.
    const current = workspace.billing;
    if (current?.subscriptionId && current.subscriptionId !== state.subscriptionId && isPaid(current.status) && !isPaid(state.status)) return;
    workspace.billing = {
      ...current,
      customerId: state.customerId,
      subscriptionId: state.subscriptionId,
      status: state.status,
      interval: state.interval,
      currentPeriodEnd: state.currentPeriodEnd,
      cancelAtPeriodEnd: state.cancelAtPeriodEnd,
    };
    // Enterprise agreements are managed by the platform owner, not by the subscription.
    if (workspace.plan !== "enterprise") {
      if (isPaid(state.status)) {
        workspace.plan = "pro";
        workspace.seats = { builders: Math.max(1, state.builders), bots: Math.max(1, state.bots) };
      } else {
        // Ended or unpaid: back to Free. Nothing is deleted; schedules pause.
        workspace.plan = "free";
        workspace.seats = undefined;
      }
    }
    store.save();
    app.log.info(`Billing: workspace ${workspace.id} is on ${workspace.plan} (subscription ${state.status})`);
  };

  app.get("/api/billing/plans", async () => {
    if (!billing) return { configured: false, included: { free: FREE_LIMITS, pro: PRO } };
    return { configured: true, prices: await billing.prices(), included: { free: FREE_LIMITS, pro: PRO } };
  });

  app.post("/api/billing/checkout", async (req) => {
    const provider = needBilling();
    const body = parse(
      z.object({ interval: z.enum(["month", "year"]).default("month"), builders: z.number().int().min(1).max(1000), bots: z.number().int().min(1).max(1000) }),
      req.body,
    );
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    if (workspace.plan === "enterprise") throw new HttpError(409, "This workspace has an Enterprise agreement; contact ZamTech AI to change it");
    if (isPaid(workspace.billing?.status)) throw new HttpError(409, "This workspace already has a subscription; change it under Manage billing");
    const usage = currentUsage(store, workspace.id);
    if (body.builders < usage.builders || body.bots < usage.bots) {
      throw new HttpError(400, `Choose at least ${usage.builders} builder seat(s) and ${usage.bots} bot(s): that is what this workspace uses now`);
    }
    let customerId = workspace.billing?.customerId;
    if (!customerId) {
      customerId = await provider.createCustomer({ workspaceId: workspace.id, name: workspace.name, email: me(req).email || undefined });
      workspace.billing = { ...workspace.billing, customerId };
      store.save();
    }
    const url = await provider.checkout({
      customerId,
      workspaceId: workspace.id,
      interval: body.interval,
      builders: body.builders,
      bots: body.bots,
      successUrl: `${config.portalUrl}/#/billing?checkout=done`,
      cancelUrl: `${config.portalUrl}/#/billing`,
    });
    return { url };
  });

  app.post("/api/billing/portal", async (req) => {
    const provider = needBilling();
    const workspace = get(store.data.workspaces, ws(req), "Workspace");
    if (!workspace.billing?.customerId) throw new HttpError(409, "This workspace has no billing account yet; choose a plan first");
    return { url: await provider.portal({ customerId: workspace.billing.customerId, returnUrl: `${config.portalUrl}/#/billing` }) };
  });

  // Stripe's webhook needs the exact bytes it signed, so this route reads the body raw.
  await app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/api/billing/webhook", async (req, reply) => {
      if (!billing) return reply.status(404).send({ error: "Billing is not set up" });
      let state: SubscriptionState | null;
      try {
        state = await billing.parseWebhook(req.body as Buffer, String(req.headers["stripe-signature"] ?? ""));
      } catch (err) {
        app.log.warn(`Billing: rejected a webhook: ${(err as Error).message}`);
        return reply.status(400).send({ error: "Invalid webhook signature" });
      }
      if (state) applySubscription(state);
      return { received: true };
    });
  });

  /* ---------------------------- lifecycle --------------------------- */
  const sweeper = setInterval(() => {
    sweep(store, config);
    pruneSessions(store);
    for (const e of Object.values(store.data.enrollments)) {
      if (Date.parse(e.expiresAt) < Date.now()) delete store.data.enrollments[e.id];
    }
    for (const t of Object.values(store.data.emailTokens)) {
      if (Date.parse(t.expiresAt) < Date.now()) delete store.data.emailTokens[t.id];
    }
    for (const c of Object.values(store.data.mfaChallenges)) {
      if (Date.parse(c.expiresAt) < Date.now()) delete store.data.mfaChallenges[c.id];
    }
    for (const s of Object.values(store.data.ssoStates)) {
      if (Date.parse(s.expiresAt) < Date.now()) delete store.data.ssoStates[s.id];
    }
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
