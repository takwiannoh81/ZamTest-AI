import { Cron } from "croner";
import { createJob } from "./jobs.js";
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

export function validateCron(expression: string, timezone?: string): string | null {
  try {
    new Cron(expression, { timezone, paused: true }).stop();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
