import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ApiToken, Asset, EmailToken, Enrollment, InstallKey, MfaChallenge, SsoState, Job, JobLog, Package, Promotion, Queue, QueueItem, Schedule, Session, TestCase, TestFolder, TestRun, User, WorkflowDraft, Workspace } from "./types.js";
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
  /** One-time data changes already made. */
  migrations?: string[];
}

const MAX_LOGS_PER_JOB = 5000;

const empty = (): Data => ({
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
});

/**
 * Minimal persistence: everything lives in memory and is flushed to a JSON
 * file (atomically, debounced). Swap for Postgres behind the same methods
 * when scaling out - see docs/ARCHITECTURE.md.
 */
export class Store {
  data: Data;
  private file: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? join(dataDir, "db.json") : null;
    this.data = empty();
    if (this.file && existsSync(this.file)) {
      this.data = { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<Data>) };
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

  save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
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
