export const BASE = import.meta.env.VITE_API_URL ?? "";

// Signing in sets an HttpOnly cookie shared with the Designer; nothing is kept in the page.
// Earlier versions stored a token in localStorage: remove it.
try {
  localStorage.removeItem("zamtest.token");
} catch {
  /* storage unavailable */
}

/** Fired when the server needs the user to sign in. */
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
      "x-zamtech-client": "portal",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 401) {
    // "signed_in_elsewhere": this account signed in on another browser or PC (one sign-in per user).
    const why = ((await res.clone().json().catch(() => ({}))) as { code?: string }).code;
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: why }));
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  // An account that still has to confirm its email or set up two-step sign-in sees a page about it instead.
  const restricted = ["email_unverified", "mfa_setup_required"].includes((data as { code?: string }).code ?? "");
  if (res.status === 403 && !restricted) window.dispatchEvent(new Event(FORBIDDEN_EVENT));
  if (res.status === 402) window.dispatchEvent(new CustomEvent(LIMIT_EVENT, { detail: (data as { error?: string }).error ?? "" }));
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
  approvedBy?: string;
  environment?: EnvironmentId;
}

/** Development, Test, Production (Source control). */
export type EnvironmentId = "dev" | "test" | "prod";
export const ENVIRONMENT_IDS: EnvironmentId[] = ["dev", "test", "prod"];

/** GET /api/environments: what runs where. */
export interface EnvironmentsView {
  enabled: boolean;
  requireApproval: boolean;
  environments: Array<{ id: EnvironmentId; agents: number; processes: Array<Package & { deployedAt: string; deployedBy: string }> }>;
}

export interface Promotion {
  id: string;
  packageId: string;
  name: string;
  version: number;
  to: EnvironmentId;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedBy: string;
  requestedById: string;
  requestedAt: string;
  note?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface ApiToken {
  id: string;
  name: string;
  role: "viewer" | "operator" | "developer";
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  /** Only in the answer to creating the token. */
  token?: string;
}

/** GET /api/git/settings. */
export interface GitSettingsView {
  available: boolean;
  connected: boolean;
  url?: string;
  branch?: string;
  folder?: string;
  username?: string;
  tokenSet?: boolean;
  autoPublish?: boolean;
  webhookUrl?: string;
  /** Admins only. */
  webhookSecret?: string;
  lastSync?: { at: string; commit?: string; error?: string; changed?: number };
}

export interface Limits {
  builders: number;
  bots: number;
  runsPerMonth: number;
  aiPerMonth: number;
  schedules: boolean;
  installKeys: boolean;
  sso?: boolean;
  sourceControl?: boolean;
}

export type PlanId = "free" | "pro" | "enterprise";

/** GET /api/workspace (and each row of /api/platform/workspaces). */
export interface WorkspaceSummary {
  ssoDomains: string[];
  billingAvailable: boolean;
  id: string;
  name: string;
  plan: PlanId;
  seats?: { builders: number; bots: number };
  limits: Limits;
  usage: { builders: number; bots: number; runs: number; ai: number };
  billing?: { status?: string; interval?: "month" | "year"; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean };
  createdAt?: string;
  users?: number;
}

/** GET /api/billing/plans: prices come from Stripe, in the currency's smallest unit. */
export interface BillingPlans {
  configured: boolean;
  prices?: { currency: string; builder: { month?: number; year?: number }; bot: { month?: number; year?: number } };
  included: { free: Limits; pro: { runsPerBot: number; aiPerBuilder: number } };
}

/** A PC waiting to be approved (Connect this PC). */
export interface Enrollment {
  userCode: string;
  name: string;
  machine: string;
  os: string;
  version: string;
  status: "pending" | "approved" | "denied";
  approvedBy?: string;
  expiresAt: string;
  /** Connected before (reinstalled): approving brings back this bot instead of adding one. */
  reconnects?: string;
}

export interface InstallKey {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
  /** Only in the answer to creating the key. */
  key?: string;
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
  deployments?: Partial<Record<EnvironmentId, { at: string; by: string }>>;
  source?: { commit: string; path: string };
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
  environment?: EnvironmentId;
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
  environment?: EnvironmentId;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "developer" | "operator" | "viewer";
  disabled?: boolean;
  mfaEnabled?: boolean;
  authSource?: "password" | "sso";
  emailVerified?: boolean;
  /** Controls the whole platform (admins of the platform's own workspace only). */
  platformOwner?: boolean;
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
