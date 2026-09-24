/**
 * Step screenshots of jobs, as JPEG files next to the database
 * (<data dir>/screenshots/<job id>/<n>.jpg, with an index.json), never inside it.
 * Without a data directory (tests), they are kept in memory.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScreenshotEntry {
  seq: number;
  stepId: string;
  stepType?: string;
  label?: string;
  status: "ok" | "error";
  source: "browser" | "desktop";
  time: string;
  bytes: number;
}

export const MAX_SCREENSHOTS_PER_JOB = 300;
export const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024;

const safeId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

export class ScreenshotStore {
  private readonly root: string | null;
  private readonly memory = new Map<string, { index: ScreenshotEntry[]; files: Map<number, Buffer> }>();

  constructor(dataDir: string | null) {
    this.root = dataDir ? join(dataDir, "screenshots") : null;
    if (this.root) mkdirSync(this.root, { recursive: true });
  }

  private dir(jobId: string) {
    if (!safeId(jobId)) throw new Error("Bad job id");
    return join(this.root!, jobId);
  }

  list(jobId: string): ScreenshotEntry[] {
    if (!safeId(jobId)) return [];
    if (!this.root) return this.memory.get(jobId)?.index ?? [];
    const file = join(this.dir(jobId), "index.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ScreenshotEntry[]) : [];
  }

  /** Adds one; undefined when the job already has as many as it may keep. */
  add(jobId: string, entry: Omit<ScreenshotEntry, "seq" | "bytes">, data: Buffer): ScreenshotEntry | undefined {
    const index = this.list(jobId);
    if (index.length >= MAX_SCREENSHOTS_PER_JOB) return undefined;
    const saved: ScreenshotEntry = { ...entry, seq: (index.at(-1)?.seq ?? 0) + 1, bytes: data.length };
    index.push(saved);
    if (!this.root) {
      const job = this.memory.get(jobId) ?? { index, files: new Map() };
      job.index = index;
      job.files.set(saved.seq, data);
      this.memory.set(jobId, job);
    } else {
      const dir = this.dir(jobId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${saved.seq}.jpg`), data);
      writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    }
    return saved;
  }

  read(jobId: string, seq: number): Buffer | undefined {
    if (!safeId(jobId) || !Number.isInteger(seq) || seq < 1) return undefined;
    if (!this.root) return this.memory.get(jobId)?.files.get(seq);
    const file = join(this.dir(jobId), `${seq}.jpg`);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  remove(jobId: string): void {
    if (!safeId(jobId)) return;
    this.memory.delete(jobId);
    if (this.root) rmSync(this.dir(jobId), { recursive: true, force: true });
  }

  /** Deletes screenshots of jobs that no longer exist, and those older than `keepDays`. */
  prune(jobExists: (jobId: string) => boolean, keepDays: number, now = Date.now()): void {
    if (!this.root) {
      for (const id of this.memory.keys()) if (!jobExists(id)) this.memory.delete(id);
      return;
    }
    for (const id of readdirSync(this.root)) {
      const dir = join(this.root, id);
      const old = now - statSync(dir).mtimeMs > keepDays * 86_400_000;
      if (!jobExists(id) || old) rmSync(dir, { recursive: true, force: true });
    }
  }
}
