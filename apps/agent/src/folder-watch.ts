/**
 * File triggers: the folders this PC watches (the orchestrator says which, in the
 * heartbeat's answer). A file is reported once it stopped changing between two
 * looks (so it has been copied completely); the orchestrator decides whether it is
 * new and starts the job on this PC.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Watch {
  triggerId: string;
  folder: string;
  /** File names, e.g. "*.pdf". */
  pattern: string;
}

export interface FileEvent {
  triggerId: string;
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

/** "*.pdf" or "invoice-??.xlsx" as a test of a file name (case-insensitive, as on Windows). */
export const patternTest = (pattern: string) =>
  new RegExp(`^${(pattern.trim() || "*").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/** Files looked at per folder and look, at most. */
const MAX_FILES = 500;

export class FolderWatcher {
  private watches: Watch[] = [];
  /** What each file looked like last time ("size|mtime"), per trigger and path. */
  private last = new Map<string, string>();
  /** Files already reported in this run of the agent (the orchestrator also remembers them). */
  private reported = new Set<string>();
  private problems = new Map<string, string>();

  constructor(private readonly log: (message: string) => void) {}

  /** The folders to watch now; files in folders no longer watched are forgotten. */
  setWatches(watches: Watch[]): void {
    const before = new Set(this.watches.map((w) => `${w.triggerId}|${w.folder}`));
    for (const w of watches) if (!before.has(`${w.triggerId}|${w.folder}`)) this.log(`Watching ${w.folder} (${w.pattern || "*"}) for a file trigger`);
    this.watches = watches;
    const kept = new Set(watches.map((w) => w.triggerId));
    for (const key of [...this.last.keys()]) if (!kept.has(key.split("\n")[0]!)) this.last.delete(key);
  }

  /** One look at every watched folder: the files that are new and complete. */
  async scan(): Promise<FileEvent[]> {
    const events: FileEvent[] = [];
    for (const watch of this.watches) {
      const test = patternTest(watch.pattern);
      let names: string[];
      try {
        names = (await readdir(watch.folder, { withFileTypes: true })).filter((e) => e.isFile() && test.test(e.name)).map((e) => e.name).slice(0, MAX_FILES);
        if (this.problems.delete(watch.triggerId)) this.log(`${watch.folder} can be read again`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (this.problems.get(watch.triggerId) !== message) this.log(`Cannot read the watched folder ${watch.folder}: ${message}`);
        this.problems.set(watch.triggerId, message);
        continue;
      }
      for (const name of names) {
        const path = join(watch.folder, name);
        const info = await stat(path).catch(() => undefined);
        if (!info) continue;
        const key = `${watch.triggerId}\n${path}`;
        const now = `${info.size}|${info.mtimeMs}`;
        const before = this.last.get(key);
        this.last.set(key, now);
        // Still being written (or seen for the first time): look again next time.
        if (before !== now) continue;
        const id = `${key}\n${now}`;
        if (this.reported.has(id)) continue;
        this.reported.add(id);
        events.push({ triggerId: watch.triggerId, path, name, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
    }
    if (this.reported.size > 20_000) this.reported.clear();
    return events;
  }
}
