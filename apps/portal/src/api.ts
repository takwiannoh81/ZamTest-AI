const BASE = import.meta.env.VITE_API_URL ?? "";

export function getToken(): string {
  try {
    return localStorage.getItem("zamtest.token") ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem("zamtest.token", token);
  } catch {
    /* storage unavailable */
  }
}

/** Fired when the server rejects the stored access token (or none is stored). */
export const UNAUTHORIZED_EVENT = "zamtest:unauthorized";
/** Fired when the signed-in user's role does not allow the request. */
export const FORBIDDEN_EVENT = "zamtest:forbidden";

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  if (res.status === 403) window.dispatchEvent(new Event(FORBIDDEN_EVENT));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/* --------------------------- API shapes --------------------------- */
export interface Stats {
  agents: { total: number; online: number; busy: number };
  jobs: { total: number; pending: number; running: number; succeeded: number; failed: number; cancelled: number };
  workflows: number;
  packages: number;
  schedules: number;
  healedSelectors: number;
  ai: { configured: boolean };
}

export interface Agent {
  id: string;
  name: string;
  machine: string;
  os: string;
  version: string;
  status: "online" | "busy" | "offline";
  currentJobId?: string;
  lastHeartbeat: string;
}

export interface VariableDef {
  name: string;
  type: string;
  direction: string;
  default?: unknown;
  description?: string;
}

export interface Package {
  id: string;
  workflowId: string;
  name: string;
  version: number;
  description?: string;
  releaseNotes?: string;
  publishedAt: string;
  variables: VariableDef[];
}

export type JobStatus = "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  name: string;
  packageId?: string;
  packageVersion?: number;
  status: JobStatus;
  source: string;
  agentId?: string;
  targetAgentId?: string;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  error?: string;
  healedSelectors: Array<{ stepId?: string; oldSelector: string; newSelector: string; reason?: string }>;
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
  nextRunAt?: string;
}

export interface Asset {
  id: string;
  name: string;
  type: "text" | "number" | "boolean" | "credential";
  value: unknown;
  description?: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "developer" | "operator" | "viewer";
  disabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface BackupStatus {
  configured: boolean;
  location?: string;
  schedule?: string;
  keepDays?: number;
  running: boolean;
  lastSuccessAt?: string;
  lastError?: string;
  nextRunAt?: string;
}

export type QueueItemStatus = "new" | "in-progress" | "successful" | "failed" | "business-exception";

export interface Queue {
  id: string;
  name: string;
  description?: string;
  maxRetries: number;
  createdAt: string;
  counts: Record<QueueItemStatus, number>;
}

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
  createdAt: string;
  finishedAt?: string;
}
