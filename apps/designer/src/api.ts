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
import type { Workflow } from "@zamtest/core";

export interface WorkflowSummary {
  id: string;
  name: string;
  description?: string;
  steps: number;
  updatedAt: string;
}

export interface WorkflowDraft {
  id: string;
  name: string;
  description?: string;
  definition: Workflow;
  updatedAt: string;
}

export interface Job {
  id: string;
  status: "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
  error?: string;
  outputs?: Record<string, unknown>;
  healedSelectors: Array<{ stepId?: string; oldSelector: string; newSelector: string; reason?: string }>;
}

export interface JobLog {
  seq: number;
  time: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  stepId?: string;
}

export interface Agent {
  id: string;
  name: string;
  status: "online" | "busy" | "offline";
}
