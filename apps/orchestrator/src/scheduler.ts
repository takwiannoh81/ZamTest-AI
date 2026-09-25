import { Cron } from "croner";
import { createJob, HttpError } from "./jobs.js";
import { startTestRun } from "./testcases.js";
import { scheduleAllowed } from "./plans.js";
import { nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Schedule } from "./types.js";

/** Triggers jobs from enabled schedules (cron expressions, optional time zone). */
export class Scheduler {
  private crons = new Map<string, Cron>();

  constructor(
    private store: Store,
    private log: (msg: string) => void = () => undefined,
  ) {}

  start() {
    for (const schedule of Object.values(this.store.data.schedules)) this.sync(schedule);
  }

  stop() {
    for (const cron of this.crons.values()) cron.stop();
    this.crons.clear();
  }

  /** (Re)registers a schedule after it is created, updated or deleted. */
  sync(schedule: Schedule | undefined, id = schedule?.id) {
    if (!id) return;
    this.crons.get(id)?.stop();
    this.crons.delete(id);
    if (!schedule?.enabled) return;
    const cron = new Cron(schedule.cron, { timezone: schedule.timezone, protect: true }, () => this.fire(schedule.id));
    this.crons.set(id, cron);
  }

  nextRun(id: string): string | undefined {
    return this.crons.get(id)?.nextRun()?.toISOString();
  }

  fire(id: string) {
    const schedule = this.store.data.schedules[id];
    if (!schedule) return;
    // Plans without schedules (e.g. after a downgrade) keep them, paused.
    if (!scheduleAllowed(this.store, schedule.workspaceId)) {
      this.log(`Schedule "${schedule.name}" skipped: the workspace's plan does not include schedules`);
      return;
    }
    try {
      if (schedule.tests) {
        // Test cases: a test run, as "Run all" (its results in the Test cases tab).
        const run = startTestRun(this.store, {
          workspaceId: schedule.workspaceId,
          ...schedule.tests,
          startedBy: `schedule: ${schedule.name}`,
          targetAgentId: schedule.targetAgentId,
        });
        schedule.lastRunAt = nowIso();
        this.store.save();
        this.log(`Schedule "${schedule.name}" started test run ${run.id} (${run.items.length} test cases)`);
        return;
      }
      const job = createJob(this.store, {
        workspaceId: schedule.workspaceId,
        packageId: schedule.packageId,
        inputs: schedule.inputs,
        targetAgentId: schedule.targetAgentId,
        environment: schedule.environment,
        source: "schedule",
        startedBy: "schedule",
        scheduleId: schedule.id,
      });
      schedule.lastRunAt = nowIso();
      this.store.save();
      this.log(`Schedule "${schedule.name}" queued job ${job.id}`);
    } catch (err) {
      this.log(`Schedule "${schedule.name}" failed to queue a job: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Common abbreviations people type, as the zone names the scheduler needs. */
const ZONES: Record<string, string> = {
  EST: "America/New_York", EDT: "America/New_York", ET: "America/New_York",
  CST: "America/Chicago", CDT: "America/Chicago", CT: "America/Chicago",
  MST: "America/Denver", MDT: "America/Denver", MT: "America/Denver",
  PST: "America/Los_Angeles", PDT: "America/Los_Angeles", PT: "America/Los_Angeles",
  AKST: "America/Anchorage", HST: "Pacific/Honolulu",
  GMT: "UTC", UTC: "UTC", BST: "Europe/London", CET: "Europe/Paris", CEST: "Europe/Paris",
  IST: "Asia/Kolkata", JST: "Asia/Tokyo", WAT: "Africa/Lagos", CAT: "Africa/Harare", EAT: "Africa/Nairobi", SAST: "Africa/Johannesburg",
};

/** A time zone the scheduler knows (unset: the server's), or an error that says what to type. */
export function timeZoneOf(value: string | undefined): string | undefined {
  const typed = value?.trim();
  if (!typed) return undefined;
  const zone = ZONES[typed.toUpperCase()] ?? typed;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    throw new HttpError(400, `Unknown time zone "${typed}": choose one from the list, e.g. America/Chicago`);
  }
}

export function validateCron(expression: string, timezone?: string): string | null {
  try {
    new Cron(expression, { timezone, paused: true }).stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
