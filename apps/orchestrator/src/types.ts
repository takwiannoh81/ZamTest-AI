import type { Workflow } from "@zamtest/core";

export interface WorkflowDraft {
  id: string;
  name: string;
  description?: string;
  definition: Workflow;
  createdAt: string;
  updatedAt: string;
}

/** An immutable, versioned snapshot of a workflow that can be run by agents ("process"). */
export interface Package {
  id: string;
  workflowId: string;
  name: string;
  version: number;
  description?: string;
  releaseNotes?: string;
  definition: Workflow;
  publishedAt: string;
}

export type AgentStatus = "online" | "busy" | "offline";

export interface Agent {
  id: string;
  name: string;
  machine: string;
  os: string;
  version: string;
  status: AgentStatus;
  currentJobId?: string;
  lastHeartbeat: string;
  registeredAt: string;
}

export type JobStatus = "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export const FINAL_JOB_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface Job {
  id: string;
  name: string;
  packageId?: string;
  packageVersion?: number;
  definition: Workflow;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  status: JobStatus;
  source: "manual" | "schedule" | "designer" | "api";
  scheduleId?: string;
  targetAgentId?: string;
  agentId?: string;
  error?: string;
  healedSelectors: Array<{ stepId?: string; oldSelector: string; newSelector: string; reason?: string }>;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface JobLog {
  seq: number;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  stepId?: string;
  data?: unknown;
}

export interface Schedule {
  id: string;
  name: string;
  packageId: string;
  cron: string;
  timezone?: string;
  inputs: Record<string, unknown>;
  targetAgentId?: string;
  enabled: boolean;
  lastRunAt?: string;
  createdAt: string;
}

export type AssetType = "text" | "number" | "boolean" | "credential";

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  /** For credentials: { username, password }. */
  value: unknown;
  description?: string;
  updatedAt: string;
}
