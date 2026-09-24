import type { Workflow } from "@zamtest/core";

/** The workspace everything lived in before workspaces existed: the platform owner's own. */
export const DEFAULT_WORKSPACE = "ws_default";

/**
 * One customer (company): its users, workflows, bots, assets, jobs and
 * schedules are only visible inside it.
 */
export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
  /** See plans.ts. */
  plan: "free" | "pro" | "enterprise";
  /** Pro: seats bought (kept in step with the Stripe subscription). */
  seats?: { builders: number; bots: number };
  /** Enterprise: limits agreed with the customer (unset = unlimited). */
  customLimits?: Partial<import("./plans.js").Limits>;
  billing?: WorkspaceBilling;
  security?: WorkspaceSecurity;
}

export interface WorkspaceSecurity {
  /** Everyone signing in with a password must use two-step sign-in. */
  requireMfa?: boolean;
}

/** The workspace's Stripe customer and subscription, as last reported by Stripe. */
export interface WorkspaceBilling {
  customerId?: string;
  subscriptionId?: string;
  /** Stripe subscription status: active, trialing, past_due, canceled, unpaid, incomplete, ... */
  status?: string;
  interval?: "month" | "year";
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
}

export interface WorkflowDraft {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
  name: string;
  description?: string;
  definition: Workflow;
  createdAt: string;
  updatedAt: string;
}

/** An immutable, versioned snapshot of a workflow that can be run by agents ("process"). */
export interface Package {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
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
  /** The customer workspace this belongs to. */
  workspaceId: string;
  name: string;
  machine: string;
  os: string;
  version: string;
  status: AgentStatus;
  currentJobId?: string;
  lastHeartbeat: string;
  registeredAt: string;
  /** SHA-256 of the agent's own credential, issued when the PC was approved in the Portal. */
  tokenHash?: string;
  /** Who approved this PC: a user ("Name <email>") or an install key. */
  approvedBy?: string;
}

/** A PC asking to become a bot agent, waiting for a signed-in user to approve it in the Portal. */
export interface Enrollment {
  /** SHA-256 of the secret device code the agent polls with. */
  id: string;
  /** Short code in the Portal link, e.g. "KDTR-7QMX". */
  userCode: string;
  name: string;
  machine: string;
  os: string;
  version: string;
  status: "pending" | "approved" | "denied";
  approvedBy?: string;
  /** Set when approved: the approver's workspace. */
  workspaceId?: string;
  createdAt: string;
  expiresAt: string;
}

/** Lets IT install agents silently: a PC that presents this key is approved without a browser. */
export interface InstallKey {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
  name: string;
  /** SHA-256 of the key; the key itself is shown once, when it is created. */
  keyHash: string;
  createdAt: string;
  createdBy: string;
  expiresAt?: string;
  maxUses?: number;
  uses: number;
}

export type JobStatus = "pending" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";
export const FINAL_JOB_STATUSES: JobStatus[] = ["succeeded", "failed", "cancelled"];

export interface Job {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
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
  /** The customer workspace this belongs to. */
  workspaceId: string;
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
  /** The customer workspace this belongs to. */
  workspaceId: string;
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
  /** The customer workspace this belongs to. */
  workspaceId: string;
  email: string;
  name: string;
  role: Role;
  /** scrypt$<salt>$<hash> */
  passwordHash: string;
  disabled?: boolean;
  /** false until the person clicks the link in the confirmation email (accounts from sign-up). */
  emailVerified?: boolean;
  /** Two-step sign-in with an authenticator app. */
  mfa?: UserMfa;
  /** "sso": the account signs in through the company's identity provider. */
  authSource?: "password" | "sso";
  createdAt: string;
  lastLoginAt?: string;
}

export interface UserMfa {
  enabled: boolean;
  /** Base32 TOTP secret (never sent to clients after setup). */
  secret?: string;
  /** A secret being set up, until the first code confirms it. */
  pendingSecret?: string;
  /** SHA-256 of each unused recovery code. */
  recoveryCodes: string[];
  /** The last TOTP step used, so a code cannot be used twice. */
  lastStep?: number;
}

/** A password that was right, waiting for the second step (code or recovery code). */
export interface MfaChallenge {
  /** SHA-256 of the token given to the client. */
  id: string;
  userId: string;
  attempts: number;
  expiresAt: string;
}

/** A single-use link sent by email: confirm the address, or reset the password. */
export interface EmailToken {
  /** SHA-256 of the token in the link. */
  id: string;
  userId: string;
  purpose: "verify" | "reset";
  expiresAt: string;
}

export interface Session {
  /** SHA-256 of the bearer token; the token itself is never stored. */
  id: string;
  /** A user's id, or MASTER_SESSION for a session opened with the master access token. */
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
  /** The workspace the request acts in (the default workspace for the master token). */
  workspaceId: string;
  /** Signed in, but may only use their own account until this is resolved. */
  restriction?: "email_unverified" | "mfa_setup_required";
}

export interface Queue {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
  name: string;
  description?: string;
  /** How many times a failed item is retried before it stays failed. */
  maxRetries: number;
  createdAt: string;
}

export type QueueItemStatus = "new" | "in-progress" | "successful" | "failed" | "business-exception";

export interface QueueItem {
  id: string;
  /** The customer workspace this belongs to. */
  workspaceId: string;
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
