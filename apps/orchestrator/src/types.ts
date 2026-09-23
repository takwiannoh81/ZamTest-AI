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
  /** Who started the job (user email, "access token", or "schedule"). */
  startedBy?: string;
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

export type Role = "admin" | "developer" | "operator" | "viewer";
export const ROLES: Role[] = ["viewer", "operator", "developer", "admin"];

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** scrypt$<salt>$<hash> */
  passwordHash: string;
  disabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface Session {
  /** SHA-256 of the bearer token; the token itself is never stored. */
  id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

/** Who is making a request: a signed-in user, or the master access token. */
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
  kind: "user" | "token" | "open";
}

export interface Queue {
  id: string;
  name: string;
  description?: string;
  /** How many times a failed item is retried before it stays failed. */
  maxRetries: number;
  createdAt: string;
}

export type QueueItemStatus = "new" | "in-progress" | "successful" | "failed" | "business-exception";

export interface QueueItem {
  id: string;
  queueId: string;
  reference?: string;
  data: unknown;
  status: QueueItemStatus;
  retries: number;
  result?: unknown;
  message?: string;
  jobId?: string;
  agentId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
