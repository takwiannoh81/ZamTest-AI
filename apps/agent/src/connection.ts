import { hostname, platform, release } from "node:os";
import { parseWorkflow, sleep } from "@zamtest/core";
import type { QueueItem } from "@zamtest/actions";
import type { EngineEvent } from "@zamtest/core";
import { execute } from "./runtime.js";

export interface AgentOptions {
  server: string;
  key: string;
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
}

const VERSION = "0.1.0";

/**
 * Unattended bot agent: registers with the orchestrator, sends heartbeats,
 * pulls one job at a time, streams execution events and reports the result.
 */
export class AgentConnection {
  private agentId?: string;
  private current?: { id: string; controller: AbortController };
  private stopped = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((m) => console.log(`[agent] ${m}`));
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const res = await fetch(new URL(path, this.options.server), {
      method,
      headers: { "content-type": "application/json", "x-agent-key": this.options.key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined;
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
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

  async start(): Promise<void> {
    await this.retryForever(() => this.register());
    void this.heartbeatLoop();
    while (!this.stopped) {
      try {
        const job = await this.call<JobPayload>("POST", "/api/agent/jobs/next", { agentId: this.agentId });
        if (job) {
          await this.runJob(job);
          continue;
        }
      } catch (err) {
        await this.handleError(err);
      }
      await sleep(this.options.pollMs ?? 3000).catch(() => undefined);
    }
  }

  stop(): void {
    this.stopped = true;
    this.current?.controller.abort();
  }

  private async handleError(err: unknown) {
    const status = (err as { status?: number }).status;
    this.log(`Orchestrator error: ${err instanceof Error ? err.message : err}`);
    if (status === 404) await this.retryForever(() => this.register());
  }

  private async retryForever(fn: () => Promise<void>) {
    for (let delay = 1000; !this.stopped; delay = Math.min(delay * 2, 30_000)) {
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
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(flusher);
      await flush();
      this.current = undefined;
    }

    this.log(`Job ${job.id} ${status}${error ? `: ${error}` : ""}`);
    await this.retryForever(async () => {
      await this.call("POST", `/api/agent/jobs/${job.id}/complete`, { agentId: this.agentId, status, error, outputs });
    });
  }
}
