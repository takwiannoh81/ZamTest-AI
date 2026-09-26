import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresPersistence, pgSql } from "./db.js";
import type { Sql } from "./db.js";
import type { Agent, Announcement, ApiToken, Asset, AuditEvent, BugReport, EmailToken, Enrollment, InstallKey, MfaChallenge, SsoState, Job, JobLog, Package, Promotion, Queue, QueueItem, Schedule, Session, TestCase, TestFolder, TestRun, User, WorkflowDraft, Workspace } from "./types.js";
import { DEFAULT_WORKSPACE } from "./types.js";

export interface Data {
  workspaces: Record<string, Workspace>;
  workflows: Record<string, WorkflowDraft>;
  packages: Record<string, Package>;
  agents: Record<string, Agent>;
  jobs: Record<string, Job>;
  jobLogs: Record<string, JobLog[]>;
  schedules: Record<string, Schedule>;
  assets: Record<string, Asset>;
  users: Record<string, User>;
  sessions: Record<string, Session>;
  queues: Record<string, Queue>;
  queueItems: Record<string, QueueItem>;
  enrollments: Record<string, Enrollment>;
  installKeys: Record<string, InstallKey>;
  /** Runs and AI requests per workspace and month, keyed "<workspaceId>:<YYYY-MM>". */
  usage: Record<string, { runs: number; ai: number }>;
  emailTokens: Record<string, EmailToken>;
  mfaChallenges: Record<string, MfaChallenge>;
  ssoStates: Record<string, SsoState>;
  promotions: Record<string, Promotion>;
  apiTokens: Record<string, ApiToken>;
  testFolders: Record<string, TestFolder>;
  testCases: Record<string, TestCase>;
  testRuns: Record<string, TestRun>;
  /** Sessions ended because their user signed in somewhere else (one sign-in per user), so that device can be told why. */
  endedSessions: Record<string, { at: string; reason: "signed_in_elsewhere" | "idle" }>;
  /** Help assistant questions per person today (a daily limit, apart from the plan's AI requests). */
  helpUsage: Record<string, { day: string; count: number }>;
  /** Product update emails the platform owner sent to customers. */
  announcements: Record<string, Announcement>;
  /** Server-made secrets, e.g. for signing unsubscribe links. */
  secrets: { unsubscribe?: string };
  /** What people did, per workspace (newest last). */
  audit: Record<string, AuditEvent[]>;
  /** Problems reported from the Portal and the Designer. */
  bugReports: Record<string, BugReport>;
  /** One-time data changes already made. */
  migrations?: string[];
}

const MAX_LOGS_PER_JOB = 5000;

export const emptyData = (): Data => ({
  workspaces: {},
  workflows: {},
  packages: {},
  agents: {},
  jobs: {},
  jobLogs: {},
  schedules: {},
  assets: {},
  users: {},
  sessions: {},
  queues: {},
  queueItems: {},
  enrollments: {},
  installKeys: {},
  usage: {},
  emailTokens: {},
  mfaChallenges: {},
  ssoStates: {},
  promotions: {},
  apiTokens: {},
  testFolders: {},
  testCases: {},
  testRuns: {},
  endedSessions: {},
  helpUsage: {},
  announcements: {},
  secrets: {},
  audit: {},
  bugReports: {},
});

export interface OpenStoreOptions {
  dataDir: string | null;
  /** postgres://... : Postgres keeps the data (else the JSON file in dataDir). */
  databaseUrl?: string;
  /** A database to use instead of databaseUrl (tests). */
  sql?: Sql;
  log?: (message: string) => void;
}

/** How long a failed Postgres write waits before it is tried again. */
const RETRY_MS = 5_000;

/**
 * The orchestrator's data. It lives in memory (store.data) and every change is
 * made there, synchronously; save() then persists it, debounced:
 * - with Postgres (Store.open with a databaseUrl): only what changed is written,
 *   in one transaction per save, in order (see db.ts);
 * - otherwise to db.json in the data folder (atomically), or nowhere (tests).
 */
export class Store {
  data: Data;
  private file: string | null;
  private db?: PostgresPersistence;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The Postgres writes, one after another. */
  private writing: Promise<void> = Promise.resolve();
  private log: (message: string) => void;
  /** Told when a job ends (test results, alerts). */
  onJobFinished?: (job: Job) => void;
  /** Told when every test of a test run finished. */
  onTestRunFinished?: (run: TestRun) => void;
  /** Told when a schedule could not start its run. */
  onScheduleFailed?: (schedule: Schedule, message: string) => void;
  /** Told when a PC stops answering. */
  onAgentOffline?: (agent: Agent) => void;

  constructor(dataDir: string | null, db?: { persistence: PostgresPersistence; data: Partial<Data>; log?: (message: string) => void }) {
    this.log = db?.log ?? ((message) => console.log(message));
    if (db) {
      this.file = null;
      this.db = db.persistence;
      this.data = { ...emptyData(), ...db.data };
      this.migrate();
      return;
    }
    this.file = dataDir ? join(dataDir, "db.json") : null;
    this.data = emptyData();
    if (this.file && existsSync(this.file)) {
      this.data = { ...emptyData(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>) };
    } else if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.migrate();
  }

  /**
   * Data from before workspaces (and anything created without one) belongs to
   * the default workspace: the platform owner's own.
   */
  private migrate(): void {
    // The platform owner's own workspace has no limits.
    this.data.workspaces[DEFAULT_WORKSPACE] ??= { id: DEFAULT_WORKSPACE, name: "Default workspace", createdAt: nowIso(), plan: "enterprise" };
    for (const workspace of Object.values(this.data.workspaces)) workspace.plan ??= "free";
    // Accounts from before email confirmation existed were made by an admin: treat them as confirmed.
    for (const user of Object.values(this.data.users)) user.emailVerified ??= true;
    // Platform owners used to be every admin of the default workspace; they keep it, once.
    const done = (this.data.migrations ??= []);
    if (!done.includes("platform-owner")) {
      for (const user of Object.values(this.data.users)) {
        if ((user.workspaceId ?? DEFAULT_WORKSPACE) === DEFAULT_WORKSPACE && user.role === "admin" && !user.disabled) user.platformOwner = true;
      }
      done.push("platform-owner");
    }
    // Versions from before environments existed are in Production.
    for (const pkg of Object.values(this.data.packages)) pkg.deployments ??= { prod: { at: pkg.publishedAt, by: "ZamTech AI" } };
    const owned = [
      this.data.workflows, this.data.packages, this.data.agents, this.data.jobs, this.data.schedules, this.data.assets,
      this.data.users, this.data.queues, this.data.queueItems, this.data.installKeys, this.data.promotions, this.data.apiTokens, this.data.testFolders, this.data.testCases, this.data.testRuns,
    ] as Array<Record<string, { workspaceId?: string }>>;
    for (const collection of owned) {
      for (const record of Object.values(collection)) record.workspaceId ??= DEFAULT_WORKSPACE;
    }
  }

  /**
   * The store for this server: Postgres when a database address is given, else the
   * JSON file. A new, empty Postgres database takes over the data of an existing
   * db.json once (the file is kept, renamed).
   */
  static async open(options: OpenStoreOptions): Promise<Store> {
    if (!options.databaseUrl && !options.sql) return new Store(options.dataDir);
    const log = options.log ?? ((message: string) => console.log(message));
    const persistence = new PostgresPersistence(options.sql ?? (await pgSql(options.databaseUrl!)));
    await persistence.init();
    let data = await persistence.load();
    const file = options.dataDir ? join(options.dataDir, "db.json") : null;
    const importing = !data && file && existsSync(file) ? file : undefined;
    if (importing) data = JSON.parse(readFileSync(importing, "utf8")) as Partial<Data>;
    const store = new Store(options.dataDir, { persistence, data: data ?? {}, log });
    // The data as it is now (imported, or changed by migrate()) is written before anything else.
    await persistence.write(store.data);
    if (importing) {
      const kept = `${importing}.imported-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(importing, kept);
      log(`Postgres: imported the data of ${importing} (kept as ${kept})`);
    }
    return store;
  }

  /** Where the data is kept, for the log. */
  get kind(): "postgres" | "file" | "memory" {
    return this.db ? "postgres" : this.file ? "file" : "memory";
  }

  save(): void {
    if ((!this.file && !this.db) || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.db) {
      void this.writeDb();
      return;
    }
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
  }

  /** Queues a Postgres write of what changed; a failed one is tried again a little later. */
  private writeDb(): Promise<void> {
    const db = this.db!;
    this.writing = this.writing.then(
      () =>
        db.write(this.data).then(
          () => undefined,
          (err: unknown) => {
            this.log(`Postgres: saving failed (${err instanceof Error ? err.message : String(err)}); trying again in ${RETRY_MS / 1000} s`);
            setTimeout(() => this.save(), RETRY_MS).unref?.();
          },
        ),
    );
    return this.writing;
  }

  /** Saves what is left, and closes the database. */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.db) {
      await this.writeDb();
      await this.db.close();
    } else this.flush();
  }

  appendLogs(jobId: string, entries: Omit<JobLog, "seq">[]): void {
    const logs = (this.data.jobLogs[jobId] ??= []);
    let seq = logs.at(-1)?.seq ?? 0;
    for (const entry of entries) logs.push({ ...entry, seq: ++seq });
    if (logs.length > MAX_LOGS_PER_JOB) logs.splice(0, logs.length - MAX_LOGS_PER_JOB);
    this.save();
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export const nowIso = () => new Date().toISOString();
