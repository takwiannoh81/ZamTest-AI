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
