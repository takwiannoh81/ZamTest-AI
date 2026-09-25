import { currentLocale } from "@zamtest/i18n/react";
export const BASE = import.meta.env.VITE_API_URL ?? "";

// The Portal's sign-in sets an HttpOnly cookie shared with the Designer; nothing is kept in the page.
// Earlier versions stored a token in localStorage: remove it.
try {
  localStorage.removeItem("zamtest.token");
} catch {
  /* storage unavailable */
}

/** Fired when the server needs the user to sign in (in the Portal). */
export const UNAUTHORIZED_EVENT = "zamtest:unauthorized";
/** Fired when the signed-in user's role does not allow the request. */
export const FORBIDDEN_EVENT = "zamtest:forbidden";
/** Fired (detail: the server's message) when the workspace's plan does not allow the request (402). */
export const LIMIT_EVENT = "zamtest:limit";

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      // Proves the request comes from this app, not another site using the cookie.
      "x-zamtech-client": "designer",
      // For emails in the person's language.
      "x-zamtech-language": currentLocale(),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) {
    // "signed_in_elsewhere": this account signed in on another browser or PC (one sign-in per user).
    const why = ((await res.clone().json().catch(() => ({}))) as { code?: string }).code;
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: why }));
  }
  if (res.status === 403) window.dispatchEvent(new Event(FORBIDDEN_EVENT));
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (res.status === 402) window.dispatchEvent(new CustomEvent(LIMIT_EVENT, { detail: (data as { error?: string }).error ?? "" }));
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
  /** While pending: why no PC has taken it yet. */
  waiting?: { reason: "noAgents" | "offline" | "environment" | "busy" | "starting"; agent?: string; environment?: "dev" | "test" | "prod" };
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
