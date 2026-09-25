import { hostname, platform, release } from "node:os";
import { parseWorkflow, sleep } from "@zamtest/core";
import { captureStep, closeLingeringBrowsers, keepBrowsersOpen, lingeringBrowsers } from "@zamtest/actions";
import type { QueueItem } from "@zamtest/actions";
import type { AfterStepInfo, EngineEvent } from "@zamtest/core";
import { execute } from "./runtime.js";
import { runRemoteRecording } from "./remote-recording.js";
import type { RecordingProgress, RemoteRecordingRequest } from "./remote-recording.js";

export interface AgentOptions {
  server: string;
  /** This PC's own credential (approved in the Portal); preferred over the shared key. */
  token?: string;
  /** Shared agent key (cloud bot, older installs). */
  key?: string;
  name: string;
  pollMs?: number;
  heartbeatMs?: number;
  log?: (message: string) => void;
}

interface JobPayload {
  id: string;
  name: string;
  definition: unknown;
  inputs: Record<string, unknown>;
  /** designer / test: a try-out from the Designer (its browser stays open at the end). */
  source?: string;
}

const VERSION = "0.3.7";

/** A timer that does not keep the process alive. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Unattended bot agent: registers with the orchestrator, sends heartbeats,
 * pulls one job at a time, streams execution events and reports the result.
 */
export class AgentConnection {
  private agentId?: string;
  private current?: { id: string; controller: AbortController };
  /** A recording asked for in the Designer, running next to the jobs. */
  private recordingId?: string;
  private stopped = false;
  /** Set while shutting down: the running job may finish, but no new jobs are taken. */
  private draining = false;
  private loop?: Promise<void>;
  private readonly log: (message: string) => void;

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((m) => console.log(`[agent] ${m}`));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const res = await fetch(new URL(path, this.options.server), {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.options.token ? { "x-agent-token": this.options.token } : { "x-agent-key": this.options.key ?? "" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  /** Sends a JPEG (step screenshot). */
  private async upload(path: string, data: Buffer): Promise<void> {
    const res = await fetch(new URL(path, this.options.server), {
      method: "POST",
      headers: {
        "content-type": "image/jpeg",
        ...(this.options.token ? { "x-agent-token": this.options.token } : { "x-agent-key": this.options.key ?? "" }),
      },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  async register(): Promise<void> {
    const result = await this.call<{ agentId: string }>("POST", "/api/agent/register", {
      agentId: this.agentId,
      name: this.options.name,
      machine: hostname(),
      os: `${platform()} ${release()}`,
      version: VERSION,
    });
    this.agentId = result!.agentId;
    this.log(`Registered as ${this.options.name} (${this.agentId}) with ${this.options.server}`);
  }

  start(): Promise<void> {
    this.loop ??= this.run();
    return this.loop;
  }

  private async run(): Promise<void> {
    await this.retryForever(() => this.register(), () => this.draining);
    if (this.draining || this.stopped) return;
    void this.heartbeatLoop();
    while (!this.stopped && !this.draining) {
      try {
        const job = await this.call<JobPayload>("POST", "/api/agent/jobs/next", { agentId: this.agentId });
        if (job) {
          await this.runJob(job);
          continue;
        }
        await this.checkRecording();
      } catch (err) {
        await this.handleError(err);
      }
      await sleep(this.options.pollMs ?? 3000).catch(() => undefined);
    }
  }

  /**
   * Starts a recording the Designer asked this PC for, if one waits. Only where a
   * person can use the screen (Windows, or Linux with a display): not in a server container.
   */
  private async checkRecording(): Promise<void> {
    const canShowWindows = process.platform === "win32" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (this.recordingId || !canShowWindows || process.env.ZAMTEST_RECORDING === "off") return;
    // An older server does not know recordings: nothing to do.
    const request = await this.call<RemoteRecordingRequest>("POST", "/api/agent/recordings/next", { agentId: this.agentId }).catch(() => undefined);
    if (!request) return;
    this.recordingId = request.id;
    this.log(`Recording (${request.kind}) asked for in the Designer`);
    const report = async (progress: RecordingProgress) =>
      (await this.call<{ stop: boolean }>("POST", `/api/agent/recordings/${request.id}/progress`, { agentId: this.agentId, ...progress })) ?? { stop: true };
    void runRemoteRecording(request, report, this.log, (definition) => this.runPrefix(definition)).finally(() => {
      this.recordingId = undefined;
    });
  }

  /**
   * Indicate after the steps before a step: runs them here (with the account's assets, not as a job),
   * leaving the browser open where they end for the person to pick in.
   */
  private async runPrefix(definition: unknown): Promise<{ status: string; error?: string }> {
    await closeLingeringBrowsers();
    keepBrowsersOpen(true, true);
    try {
      const result = await execute(parseWorkflow(definition), {
        inputs: {},
        onEvent: (event) => {
          if (event.type === "log") this.log(`  [before indicating] ${event.level.toUpperCase()} ${event.message}`);
        },
        getAsset: async (name) => (await this.call<{ value: unknown }>("GET", `/api/agent/assets/${encodeURIComponent(name)}`))?.value,
      });
      return { status: result.status, error: result.error };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  stop(): void {
    this.stopped = true;
    this.current?.controller.abort();
  }

  /**
   * Graceful shutdown: takes no new jobs and lets the running one finish,
   * cancelling it after timeoutMs (0 cancels at once). Either way the job's
   * result is still reported. Resolves once the agent is idle.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.draining = true;
    const loop = this.loop ?? Promise.resolve();
    if (this.current) {
      this.log(timeoutMs > 0
        ? `Finishing job ${this.current.id} before stopping (at most ${Math.round(timeoutMs / 1000)} s)`
        : `Cancelling job ${this.current.id} to stop`);
    }
    const finished = await Promise.race([loop.then(() => true), delay(timeoutMs).then(() => false)]);
    if (!finished) {
      if (this.current) {
        if (timeoutMs > 0) this.log(`Time limit reached; cancelling job ${this.current.id}`);
        this.current.controller.abort();
      }
      await Promise.race([loop, delay(15_000)]);
    }
    this.stopped = true;
  }

  private async handleError(err: unknown) {
    const status = (err as { status?: number }).status;
    this.log(`Orchestrator error: ${err instanceof Error ? err.message : err}`);
    if (status === 404) await this.retryForever(() => this.register());
  }

  private async retryForever(fn: () => Promise<void>, giveUp: () => boolean = () => false) {
    for (let delay = 1000; !this.stopped && !giveUp(); delay = Math.min(delay * 2, 30_000)) {
      try {
        return await fn();
      } catch (err) {
        this.log(`${err instanceof Error ? err.message : err}; retrying in ${delay / 1000}s`);
        await sleep(delay);
      }
    }
  }

  private async heartbeatLoop() {
    while (!this.stopped) {
      await sleep(this.options.heartbeatMs ?? 10_000).catch(() => undefined);
      try {
        const res = await this.call<{ cancelJobIds: string[] }>("POST", "/api/agent/heartbeat", { agentId: this.agentId });
        if (this.current && res?.cancelJobIds.includes(this.current.id)) {
          this.log(`Cancelling job ${this.current.id}`);
          this.current.controller.abort();
        }
      } catch (err) {
        await this.handleError(err);
      }
    }
  }

  private async runJob(job: JobPayload): Promise<void> {
    const controller = new AbortController();
    this.current = { id: job.id, controller };
    this.log(`Running job ${job.id} (${job.name})`);
    // The browser a previous try-out left open closes now; a try-out's own stays open at its end.
    await closeLingeringBrowsers();
    const tryOut = job.source === "designer" || job.source === "test";
    keepBrowsersOpen(tryOut);

    let buffer: EngineEvent[] = [];
    const flush = async () => {
      if (!buffer.length) return;
      const events = buffer;
      buffer = [];
      try {
        const res = await this.call<{ cancel: boolean }>("POST", `/api/agent/jobs/${job.id}/events`, { agentId: this.agentId, events });
        if (res?.cancel) controller.abort();
      } catch (err) {
        this.log(`Failed to upload events: ${err instanceof Error ? err.message : err}`);
      }
    };
    const flusher = setInterval(() => void flush(), 1000);

    // Step screenshots go up one at a time, in order, without holding up the run.
    let uploads: Promise<void> = Promise.resolve();
    let uploadFailures = 0;
    const screenshotsOn = process.env.ZAMTEST_SCREENSHOTS !== "off";
    const afterStep = async ({ step, status, resources }: AfterStepInfo) => {
      if (!screenshotsOn || uploadFailures >= 5) return;
      const shot = await captureStep(resources, step.type, status === "error");
      if (!shot) return;
      const query = new URLSearchParams({ stepId: step.id, status, source: shot.source, agentId: this.agentId ?? "" });
      uploads = uploads.then(() =>
        this.upload(`/api/agent/jobs/${job.id}/screenshots?${query}`, shot.data).catch((err: Error) => {
          uploadFailures++;
          this.log(`Failed to upload a screenshot: ${err.message}`);
        }),
      );
    };

    let status: "succeeded" | "failed" | "cancelled" = "failed";
    let error: string | undefined;
    let outputs: Record<string, unknown> | undefined;
    try {
      const workflow = parseWorkflow(job.definition);
      const result = await execute(workflow, {
        inputs: job.inputs,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "log") this.log(`  ${event.level.toUpperCase()} ${event.message}`);
          if (event.type !== "stepStart") buffer.push(event);
          if (buffer.length >= 200) void flush();
        },
        afterStep,
        getAsset: async (name) => (await this.call<{ value: unknown }>("GET", `/api/agent/assets/${encodeURIComponent(name)}`))?.value,
        queues: {
          add: async (queue, data, reference) =>
            (await this.call<{ id: string }>("POST", `/api/agent/queues/${encodeURIComponent(queue)}/items`, {
              agentId: this.agentId,
              jobId: job.id,
              data,
              reference,
            }))!,
          next: async (queue) =>
            (await this.call<QueueItem>("POST", `/api/agent/queues/${encodeURIComponent(queue)}/next`, { agentId: this.agentId, jobId: job.id })) ??
            null,
          complete: async (id, status, result, message) => {
            await this.call("POST", `/api/agent/queue-items/${encodeURIComponent(id)}/complete`, { agentId: this.agentId, status, result, message });
          },
        },
      });
      ({ status, error, outputs } = result);
      if (tryOut && lingeringBrowsers() > 0) {
        buffer.push({ type: "log", time: new Date().toISOString(), level: "info", message: "The browser stays open so you can see where the run ended; it closes when you run again (or after 10 minutes)." } as EngineEvent);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(flusher);
      await flush();
      await uploads;
      this.current = undefined;
    }

    this.log(`Job ${job.id} ${status}${error ? `: ${error}` : ""}`);
    await this.retryForever(async () => {
      await this.call("POST", `/api/agent/jobs/${job.id}/complete`, { agentId: this.agentId, status, error, outputs });
    });
  }
}
