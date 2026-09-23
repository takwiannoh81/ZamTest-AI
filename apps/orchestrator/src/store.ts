import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Asset, Job, JobLog, Package, Schedule, WorkflowDraft } from "./types.js";

export interface Data {
  workflows: Record<string, WorkflowDraft>;
  packages: Record<string, Package>;
  agents: Record<string, Agent>;
  jobs: Record<string, Job>;
  jobLogs: Record<string, JobLog[]>;
  schedules: Record<string, Schedule>;
  assets: Record<string, Asset>;
}

const MAX_LOGS_PER_JOB = 5000;

const empty = (): Data => ({
  workflows: {},
  packages: {},
  agents: {},
  jobs: {},
  jobLogs: {},
  schedules: {},
  assets: {},
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
