import type { Workflow } from "@zamtest/core";
import type { OrchestratorConfig } from "./config.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import { releaseJobItems } from "./queues.js";
import { HttpError } from "./errors.js";
import { useRun } from "./plans.js";
import { effectiveEnv, ENV_NAMES, environmentsOn, isIn } from "./cicd.js";
import type { EnvironmentId, Job } from "./types.js";
import { FINAL_JOB_STATUSES } from "./types.js";

export { HttpError };

export interface CreateJobInput {
  /** The workspace the job runs in; its process and target agent must belong to it. */
  workspaceId: string;
  packageId?: string;
  definition?: Workflow;
  inputs?: Record<string, unknown>;
  targetAgentId?: string;
  /** Where it runs (with environments on): the target PC's by default, else Production; test runs of unpublished workflows run in Development. */
  environment?: EnvironmentId;
  source: Job["source"];
  scheduleId?: string;
  startedBy?: string;
}

export function createJob(store: Store, input: CreateJobInput): Job {
  let definition = input.definition;
  let name = definition?.name ?? "Ad-hoc job";
  let version: number | undefined;
  const pkg = input.packageId ? store.data.packages[input.packageId] : undefined;
  if (input.packageId) {
    if (!pkg || pkg.workspaceId !== input.workspaceId) throw new HttpError(404, `Package ${input.packageId} not found`);
    definition = pkg.definition;
    name = pkg.name;
    version = pkg.version;
  }
  if (!definition) throw new HttpError(400, "Either packageId or definition is required");
  const target = input.targetAgentId ? store.data.agents[input.targetAgentId] : undefined;
  if (input.targetAgentId && target?.workspaceId !== input.workspaceId) {
    throw new HttpError(404, `Agent ${input.targetAgentId} not found`);
  }
  let environment: EnvironmentId = "prod";
  if (environmentsOn(store, input.workspaceId)) {
    const targetEnv = target ? effectiveEnv(store, input.workspaceId, target.environment) : undefined;
    environment = input.environment ?? targetEnv ?? (pkg ? "prod" : "dev");
    if (targetEnv && targetEnv !== environment) {
      throw new HttpError(409, `${target!.name} runs ${ENV_NAMES[targetEnv]} jobs, not ${ENV_NAMES[environment]}`);
    }
    if (pkg && !isIn(pkg, environment)) throw new HttpError(409, `Version ${pkg.version} of ${pkg.name} is not in ${ENV_NAMES[environment]}`);
    if (!pkg && environment !== "dev") throw new HttpError(409, "Test runs of unpublished workflows run in Development");
  }
  // Counts against the plan's monthly runs (402 when they are used up).
  useRun(store, input.workspaceId);
  const job: Job = {
    id: newId("job"),
    workspaceId: input.workspaceId,
    name,
    packageId: input.packageId,
    packageVersion: version,
    definition,
    inputs: input.inputs ?? {},
    status: "pending",
    source: input.source,
    startedBy: input.startedBy,
    scheduleId: input.scheduleId,
    targetAgentId: input.targetAgentId,
    environment,
    healedSelectors: [],
    createdAt: nowIso(),
  };
  store.data.jobs[job.id] = job;
  store.appendLogs(job.id, [{ time: job.createdAt, level: "info", message: `Job queued (${input.source})` }]);
  store.save();
  return job;
}

export function isFinal(job: Job): boolean {
  return FINAL_JOB_STATUSES.includes(job.status);
}

export function finishJob(store: Store, job: Job, status: Job["status"], error?: string, outputs?: Record<string, unknown>) {
  job.status = status;
  job.error = error;
  job.outputs = outputs;
  job.finishedAt = nowIso();
  const agent = job.agentId ? store.data.agents[job.agentId] : undefined;
  if (agent && agent.currentJobId === job.id) {
    agent.currentJobId = undefined;
    if (agent.status === "busy") agent.status = "online";
  }
  store.appendLogs(job.id, [
    { time: job.finishedAt, level: status === "succeeded" ? "info" : "error", message: `Job ${status}${error ? `: ${error}` : ""}` },
  ]);
  releaseJobItems(store, job.id, `Job ${status} before the item was completed${error ? `: ${error}` : ""}`);
  store.save();
}

/** Marks silent agents offline and fails jobs whose agent disappeared. */
export function sweep(store: Store, config: OrchestratorConfig, now = Date.now()) {
  for (const agent of Object.values(store.data.agents)) {
    const silentFor = now - Date.parse(agent.lastHeartbeat);
    if (silentFor > config.agentOfflineMs && agent.status !== "offline") {
      agent.status = "offline";
      store.save();
    }
  }
  for (const job of Object.values(store.data.jobs)) {
    if (job.status !== "running" && job.status !== "cancelling") continue;
    const agent = job.agentId ? store.data.agents[job.agentId] : undefined;
    const silentFor = agent ? now - Date.parse(agent.lastHeartbeat) : Infinity;
    if (silentFor > config.jobLostMs) {
      finishJob(store, job, job.status === "cancelling" ? "cancelled" : "failed", "Lost contact with the agent");
    }
  }
}
