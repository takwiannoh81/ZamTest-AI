/**
 * Event triggers: a process (or test cases) starts when something happens,
 * instead of by hand or on a schedule.
 *
 * - webhook: another system calls POST /api/hooks/<trigger id>/<secret>. Its JSON
 *   body is the event; top-level fields named like the process's in-arguments fill them.
 * - email: the server checks a mailbox (IMAP) every minute; each new email that
 *   matches the filters is an event. New means after the trigger was set up.
 * - file: a bot PC watches a folder on it; each new file (once it stopped growing)
 *   is an event, and the job runs on that PC. Needs agent 0.3.9.
 *
 * The event goes into the process's in-argument named by `eventArgument`
 * ("trigger" by default), e.g. {{ trigger.subject }} or {{ trigger.path }}.
 * Triggers are part of the plans that include schedules.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { safeEqual } from "./auth.js";
import { effectiveEnv, ENV_NAMES, environmentsOn, isIn } from "./cicd.js";
import { HttpError, parse } from "./errors.js";
import { createJob } from "./jobs.js";
import { checkFeature, scheduleAllowed } from "./plans.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import { startTestRun } from "./testcases.js";
import type { Agent, Principal, Trigger } from "./types.js";

/** Agents that watch folders for file triggers. */
export const canWatchFiles = (version: string | undefined) => {
  const parts = (version ?? "").split(".").map(Number);
  const want = [0, 3, 9];
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== want[i]) return have > want[i]!;
  }
  return true;
};

/** How often mailboxes are checked. */
export const EMAIL_POLL_MS = 60_000;
/** Emails started per trigger and check, at most (the rest wait for the next check). */
const EMAILS_PER_CHECK = 20;
/** Web requests per trigger and minute, at most. */
const HOOKS_PER_MINUTE = 60;
/** Files remembered per trigger, so each starts only once. */
const FILES_REMEMBERED = 2000;

/** An email as the process gets it. */
export interface EmailEvent {
  uid: number;
  messageId?: string;
  from: string;
  to: string;
  subject: string;
  date?: string;
  text: string;
  attachments: Array<{ filename: string; size: number }>;
}

/** Reads new emails from a mailbox: IMAP in production, a fake in tests. */
export interface Mailbox {
  /**
   * The emails after `afterUid` (all of them when the mailbox changed: another uidValidity).
   * Without afterUid, none: only where the mailbox is now (so older emails do not start anything).
   */
  fetchNew(input: {
    server: string;
    username: string;
    password: string;
    folder: string;
    afterUid?: number;
    uidValidity?: string;
    limit: number;
    markAsRead: boolean;
    /** Marks only these as read (the ones that matched the filters). */
    matches: (email: EmailEvent) => boolean;
  }): Promise<{ uidValidity: string; lastUid: number; emails: EmailEvent[] }>;
}

export const imapMailbox: Mailbox = {
  async fetchNew(input) {
    const { ImapFlow } = await import("imapflow");
    const { simpleParser } = await import("mailparser");
    const [host, portText] = input.server.trim().split(":");
    if (!host) throw new Error("The IMAP server is missing, e.g. outlook.office365.com:993");
    const port = portText ? Number(portText) : 993;
    const client = new ImapFlow({ host, port, secure: port === 993, auth: { user: input.username, pass: input.password }, logger: false });
    await client.connect();
    try {
      const lock = await client.getMailboxLock(input.folder || "INBOX");
      try {
        const box = client.mailbox as { uidValidity?: bigint | number; uidNext?: number };
        const uidValidity = String(box.uidValidity ?? "");
        const top = Math.max(0, (box.uidNext ?? 1) - 1);
        // First check (or a mailbox that was recreated): start from here.
        if (input.afterUid === undefined || input.uidValidity !== uidValidity) return { uidValidity, lastUid: top, emails: [] };
        if (top <= input.afterUid) return { uidValidity, lastUid: input.afterUid, emails: [] };
        const uids = ((await client.search({ uid: `${input.afterUid + 1}:*` }, { uid: true })) || []).filter((u) => u > input.afterUid!).sort((a, b) => a - b).slice(0, input.limit);
        const emails: EmailEvent[] = [];
        const read: number[] = [];
        for (const uid of uids) {
          const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const mail = await simpleParser(msg.source);
          const email: EmailEvent = {
            uid,
            messageId: mail.messageId,
            from: mail.from?.text ?? "",
            to: Array.isArray(mail.to) ? mail.to.map((t) => t.text).join(", ") : (mail.to?.text ?? ""),
            subject: mail.subject ?? "",
            date: mail.date?.toISOString(),
            text: (mail.text ?? "").slice(0, 20_000),
            attachments: mail.attachments.map((a) => ({ filename: a.filename ?? "attachment", size: a.size })),
          };
          emails.push(email);
          if (input.markAsRead && input.matches(email)) read.push(uid);
        }
        if (read.length) await client.messageFlagsAdd(read.join(","), ["\\Seen"], { uid: true });
        return { uidValidity, lastUid: uids.length ? uids.at(-1)! : input.afterUid, emails };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  },
};

const contains = (text: string, wanted?: string) => !wanted?.trim() || text.toLowerCase().includes(wanted.trim().toLowerCase());
export const emailMatches = (trigger: Trigger, email: EmailEvent) => contains(email.from, trigger.email?.from) && contains(email.subject, trigger.email?.subject);

/** "*.pdf", "invoice-*.xlsx" or "*": the file names a file trigger starts for. */
export function patternMatches(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.trim().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(name);
}

export interface TriggerContext {
  store: Store;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  mine<T extends { workspaceId: string }>(collection: Record<string, T>, req: FastifyRequest): T[];
  agentFor(req: FastifyRequest): Agent;
  mailbox?: Mailbox;
  log?: (message: string) => void;
}

const TriggerBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(["webhook", "email", "file"]),
  enabled: z.boolean().default(true),
  packageId: z.string().nullish(),
  tests: z.object({ caseIds: z.array(z.string()).optional(), folderId: z.string().nullish() }).nullish(),
  inputs: z.record(z.unknown()).default({}),
  targetAgentId: z.string().nullish(),
  environment: z.enum(["dev", "test", "prod"]).nullish(),
  eventArgument: z
    .string()
    .trim()
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "The argument name must be a valid variable name")
    .default("trigger"),
  email: z
    .object({
      server: z.string().trim().min(1).max(300),
      credential: z.string().trim().min(1).max(200),
      folder: z.string().trim().max(200).default("INBOX"),
      from: z.string().trim().max(300).optional(),
      subject: z.string().trim().max(300).optional(),
      markAsRead: z.boolean().default(false),
    })
    .nullish(),
  file: z
    .object({
      folder: z.string().trim().min(1).max(1000),
      pattern: z.string().trim().max(200).default("*"),
    })
    .nullish(),
});

/** What others see of a trigger (the webhook's secret only in its address). */
export function registerTriggers(app: FastifyInstance, ctx: TriggerContext) {
  const { store } = ctx;
  const log = ctx.log ?? (() => undefined);
  const mailbox = ctx.mailbox ?? imapMailbox;

  /** Starts what the trigger runs, with the event. */
  const fire = (trigger: Trigger, event: unknown, extra: { inputs?: Record<string, unknown>; targetAgentId?: string } = {}): { jobId?: string; testRunId?: string } => {
    if (!scheduleAllowed(store, trigger.workspaceId)) throw new HttpError(402, "The workspace's plan does not include triggers");
    try {
      let result: { jobId?: string; testRunId?: string };
      if (trigger.tests) {
        const run = startTestRun(store, {
          workspaceId: trigger.workspaceId,
          ...trigger.tests,
          startedBy: `trigger: ${trigger.name}`,
          source: "api",
          targetAgentId: extra.targetAgentId ?? trigger.targetAgentId,
        });
        result = { testRunId: run.id };
      } else {
        const job = createJob(store, {
          workspaceId: trigger.workspaceId,
          packageId: trigger.packageId,
          inputs: { ...trigger.inputs, ...extra.inputs, [trigger.eventArgument || "trigger"]: event },
          targetAgentId: extra.targetAgentId ?? trigger.targetAgentId,
          environment: trigger.environment,
          source: "trigger",
          startedBy: `trigger: ${trigger.name}`,
        });
        result = { jobId: job.id };
      }
      trigger.lastFiredAt = nowIso();
      trigger.fired = (trigger.fired ?? 0) + 1;
      trigger.lastError = undefined;
      store.save();
      return result;
    } catch (err) {
      trigger.lastError = { at: nowIso(), message: err instanceof Error ? err.message : String(err) };
      store.save();
      throw err;
    }
  };

  /** Process in-arguments that a webhook's top-level fields fill by name. */
  const inArguments = (trigger: Trigger): string[] => {
    const pkg = trigger.packageId ? store.data.packages[trigger.packageId] : undefined;
    return (pkg?.definition.variables ?? []).filter((v) => v.direction === "in" || v.direction === "inout").map((v) => v.name);
  };

  const view = (t: Trigger) => ({
    ...t,
    webhook: t.webhook ? { path: `/api/hooks/${t.id}/${t.webhook.token}` } : undefined,
    email: t.email ? { ...t.email, lastUid: undefined, uidValidity: undefined } : undefined,
    file: t.file ? { folder: t.file.folder, pattern: t.file.pattern, since: t.file.since } : undefined,
    agentName: t.targetAgentId ? store.data.agents[t.targetAgentId]?.name : undefined,
  });

  const check = (body: z.infer<typeof TriggerBody>, req: FastifyRequest, existing?: Trigger): Trigger => {
    if (body.packageId && body.tests) throw new HttpError(400, "A trigger runs either a process or test cases, not both");
    if (!body.packageId && !body.tests) throw new HttpError(400, "Choose what to run: a published process, or test cases");
    const agent = body.targetAgentId ? ctx.own(store.data.agents, body.targetAgentId, "Agent", req) : undefined;
    if (body.packageId) {
      const pkg = ctx.own(store.data.packages, body.packageId, "Process", req);
      const env = effectiveEnv(store, pkg.workspaceId, body.environment ?? undefined);
      if (environmentsOn(store, pkg.workspaceId) && !isIn(pkg, env)) throw new HttpError(409, `Version ${pkg.version} of ${pkg.name} is not in ${ENV_NAMES[env]}`);
    } else {
      for (const id of body.tests!.caseIds ?? []) ctx.own(store.data.testCases, id, "Test case", req);
      if (body.tests!.folderId) ctx.own(store.data.testFolders, body.tests!.folderId, "Folder", req);
    }
    if (body.kind === "email") {
      if (!body.email) throw new HttpError(400, "Enter the mailbox to check");
      const credential = Object.values(store.data.assets).find((a) => a.workspaceId === ctx.me(req).workspaceId && a.name === body.email!.credential);
      if (!credential) throw new HttpError(404, `There is no asset called "${body.email.credential}"`);
      if (credential.type !== "credential") throw new HttpError(400, `"${credential.name}" is not a credential (a user name and password)`);
    }
    if (body.kind === "file") {
      if (!body.file) throw new HttpError(400, "Enter the folder to watch");
      if (!agent) throw new HttpError(400, "Choose the PC whose folder is watched");
      if (!canWatchFiles(agent.version)) throw new HttpError(409, `Update the ZamTech AI agent on ${agent.name} to 0.3.9 or newer to watch folders (it has version ${agent.version || "unknown"})`);
    }
    // The same mailbox or folder, and not turned on again: go on from where it was (else only what arrives from now on).
    const goOn = Boolean(existing && (existing.enabled || !body.enabled));
    const sameMailbox =
      goOn && existing?.email && body.email && existing.email.server === body.email.server && existing.email.credential === body.email.credential && existing.email.folder === body.email.folder;
    const sameFolder = goOn && existing?.file && body.file && existing.targetAgentId === body.targetAgentId && existing.file.folder === body.file.folder;
    return {
      id: existing?.id ?? newId("trg"),
      workspaceId: existing?.workspaceId ?? ctx.me(req).workspaceId,
      name: body.name,
      kind: body.kind,
      enabled: body.enabled,
      packageId: body.packageId ?? undefined,
      tests: body.tests ? { caseIds: body.tests.caseIds, folderId: body.tests.folderId ?? undefined } : undefined,
      inputs: body.inputs,
      targetAgentId: body.targetAgentId ?? undefined,
      environment: body.environment ?? undefined,
      eventArgument: body.eventArgument,
      webhook: body.kind === "webhook" ? (existing?.webhook ?? { token: randomBytes(24).toString("base64url") }) : undefined,
      // Another mailbox: new emails are counted from when it is first checked.
      email: body.kind === "email" ? { ...body.email!, lastUid: sameMailbox ? existing!.email!.lastUid : undefined, uidValidity: sameMailbox ? existing!.email!.uidValidity : undefined } : undefined,
      // Another folder (or turned on again): only files from now on.
      file:
        body.kind === "file"
          ? {
              ...body.file!,
              since: sameFolder ? existing!.file!.since : nowIso(),
              seen: sameFolder ? existing!.file!.seen : [],
            }
          : undefined,
      fired: existing?.fired ?? 0,
      lastFiredAt: existing?.lastFiredAt,
      createdAt: existing?.createdAt ?? nowIso(),
    };
  };

  /* ------------------------------ the Portal ------------------------------ */
  app.get("/api/triggers", async (req) => ctx.mine(store.data.triggers, req).sort((a, b) => a.name.localeCompare(b.name)).map(view));
  app.post("/api/triggers", async (req, reply) => {
    const trigger = check(parse(TriggerBody, req.body), req);
    if (trigger.enabled) checkFeature(store, trigger.workspaceId, "schedules");
    store.data.triggers[trigger.id] = trigger;
    store.save();
    return reply.status(201).send(view(trigger));
  });
  app.put<{ Params: { id: string } }>("/api/triggers/:id", async (req) => {
    const existing = ctx.own(store.data.triggers, req.params.id, "Trigger", req);
    const merged = { ...view(existing), webhook: undefined, ...(req.body as object) };
    const trigger = check(parse(TriggerBody, merged), req, existing);
    if (trigger.enabled && !existing.enabled) checkFeature(store, trigger.workspaceId, "schedules");
    store.data.triggers[trigger.id] = trigger;
    store.save();
    return view(trigger);
  });
  app.delete<{ Params: { id: string } }>("/api/triggers/:id", async (req, reply) => {
    ctx.own(store.data.triggers, req.params.id, "Trigger", req);
    delete store.data.triggers[req.params.id];
    store.save();
    return reply.status(204).send();
  });
  /** A new secret address for a webhook (the old one stops working). */
  app.post<{ Params: { id: string } }>("/api/triggers/:id/new-secret", async (req) => {
    const trigger = ctx.own(store.data.triggers, req.params.id, "Trigger", req);
    if (trigger.kind !== "webhook") throw new HttpError(400, "Only web request triggers have a secret address");
    trigger.webhook = { token: randomBytes(24).toString("base64url") };
    store.save();
    return view(trigger);
  });
  /** Try it: starts it now with an example event. */
  app.post<{ Params: { id: string } }>("/api/triggers/:id/test", async (req) => {
    const trigger = ctx.own(store.data.triggers, req.params.id, "Trigger", req);
    checkFeature(store, trigger.workspaceId, "schedules");
    const example =
      trigger.kind === "email"
        ? { uid: 0, from: "someone@example.com", to: "", subject: "Test from the Portal", date: nowIso(), text: "This is a test of the trigger.", attachments: [] }
        : trigger.kind === "file"
          ? { path: `${trigger.file?.folder ?? ""}${/[\\/]$/.test(trigger.file?.folder ?? "") ? "" : "\\"}example.txt`, name: "example.txt", size: 0, modifiedAt: nowIso(), test: true }
          : { test: true };
    return fire(trigger, example);
  });

  /* ------------------------ web requests (webhooks) ----------------------- */
  const hits = new Map<string, { minute: number; count: number }>();
  app.post<{ Params: { id: string; token: string } }>("/api/hooks/:id/:token", async (req, reply) => {
    const trigger = store.data.triggers[req.params.id];
    if (!trigger?.webhook || !safeEqual(trigger.webhook.token, req.params.token)) throw new HttpError(404, "No such trigger");
    if (!trigger.enabled) throw new HttpError(409, "This trigger is turned off");
    const minute = Math.floor(Date.now() / 60_000);
    const hit = hits.get(trigger.id);
    if (hit?.minute === minute && hit.count >= HOOKS_PER_MINUTE) throw new HttpError(429, `At most ${HOOKS_PER_MINUTE} requests a minute`);
    hits.set(trigger.id, { minute, count: hit?.minute === minute ? hit.count + 1 : 1 });
    const body = (req.body ?? {}) as unknown;
    const fields = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const inputs = Object.fromEntries(inArguments(trigger).filter((name) => name !== trigger.eventArgument && name in fields).map((name) => [name, fields[name]]));
    const event = { body, query: req.query, receivedAt: nowIso() };
    return reply.status(202).send(fire(trigger, event, { inputs }));
  });

  /* ------------------------ files on a bot PC ------------------------ */
  /** The heartbeat tells each PC which folders to watch. */
  const watchesFor = (agent: Agent) =>
    Object.values(store.data.triggers)
      .filter((t) => t.kind === "file" && t.enabled && t.targetAgentId === agent.id && t.file)
      .map((t) => ({ triggerId: t.id, folder: t.file!.folder, pattern: t.file!.pattern || "*" }));

  app.post("/api/agent/file-events", async (req) => {
    const agent = ctx.agentFor(req);
    const body = parse(
      z.object({
        events: z
          .array(z.object({ triggerId: z.string(), path: z.string().max(2000), name: z.string().max(500), size: z.number().nonnegative(), modifiedAt: z.string() }))
          .max(200),
      }),
      req.body,
    );
    const started: string[] = [];
    for (const event of body.events) {
      const trigger = store.data.triggers[event.triggerId];
      if (!trigger?.file || trigger.kind !== "file" || !trigger.enabled || trigger.targetAgentId !== agent.id) continue;
      if (!patternMatches(trigger.file.pattern || "*", event.name)) continue;
      // Only files from when the trigger was set up, and each file (by path, size and time) once.
      if (trigger.file.since && event.modifiedAt < trigger.file.since) continue;
      const key = `${event.path}|${event.size}|${event.modifiedAt}`;
      const seen = (trigger.file.seen ??= []);
      if (seen.includes(key)) continue;
      seen.push(key);
      if (seen.length > FILES_REMEMBERED) seen.splice(0, seen.length - FILES_REMEMBERED);
      try {
        const result = fire(trigger, { path: event.path, name: event.name, size: event.size, modifiedAt: event.modifiedAt }, { targetAgentId: agent.id });
        if (result.jobId) started.push(result.jobId);
        log(`Trigger "${trigger.name}": ${event.name} on ${agent.name} started ${result.jobId ?? result.testRunId}`);
      } catch (err) {
        log(`Trigger "${trigger.name}" could not start for ${event.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    store.save();
    return { started };
  });

  /* ------------------------------ mailboxes ------------------------------ */
  let checking = false;
  /** Checks every enabled email trigger's mailbox once. */
  const checkMailboxes = async () => {
    if (checking) return;
    checking = true;
    try {
      for (const trigger of Object.values(store.data.triggers)) {
        if (trigger.kind !== "email" || !trigger.enabled || !trigger.email) continue;
        if (!scheduleAllowed(store, trigger.workspaceId)) continue;
        const email = trigger.email;
        try {
          const named = Object.values(store.data.assets).filter((a) => a.workspaceId === trigger.workspaceId && a.name === email.credential);
          const env = effectiveEnv(store, trigger.workspaceId, trigger.environment);
          const asset = named.find((a) => a.environment === env) ?? named.find((a) => !a.environment);
          const value = asset?.value as { username?: string; password?: string } | undefined;
          if (!value?.username || !value.password) throw new Error(`The credential "${email.credential}" was not found, or has no user name and password`);
          const result = await mailbox.fetchNew({
            server: email.server,
            username: value.username,
            password: value.password,
            folder: email.folder || "INBOX",
            afterUid: email.lastUid,
            uidValidity: email.uidValidity,
            limit: EMAILS_PER_CHECK,
            markAsRead: email.markAsRead,
            matches: (e) => emailMatches(trigger, e),
          });
          // The trigger may have been changed or deleted meanwhile.
          const now = store.data.triggers[trigger.id];
          if (now !== trigger || now.email !== email) continue;
          email.uidValidity = result.uidValidity;
          email.lastUid = result.lastUid;
          email.checkedAt = nowIso();
          for (const message of result.emails) {
            if (!emailMatches(trigger, message)) continue;
            try {
              fire(trigger, message);
            } catch (err) {
              log(`Trigger "${trigger.name}" could not start for "${message.subject}": ${err instanceof Error ? err.message : err}`);
            }
          }
          if (trigger.lastError?.message.startsWith("Mailbox: ")) trigger.lastError = undefined;
        } catch (err) {
          trigger.lastError = { at: nowIso(), message: `Mailbox: ${err instanceof Error ? err.message : String(err)}` };
          log(`Trigger "${trigger.name}": ${trigger.lastError.message}`);
        }
        store.save();
      }
    } finally {
      checking = false;
    }
  };

  return { watchesFor, checkMailboxes, fire };
}
