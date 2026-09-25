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
  /** Company sign-in, set up by the workspace's admin (Enterprise). */
  sso?: WorkspaceSso;
  /**
   * Email domains whose people sign in through this workspace's SSO. Set by the
   * platform owner (after checking the customer owns them), never by the customer.
   */
  ssoDomains?: string[];
  /** Environments, promotion and Git (Pro and Enterprise). */
  cicd?: WorkspaceCicd;
  /** Who hears about failed runs, and how. */
  alerts?: WorkspaceAlerts;
}

/** Messages when something needs attention: by email, in Slack or in Microsoft Teams. */
export interface WorkspaceAlerts {
  /** Email addresses (people of the workspace or a team mailbox). */
  emails: string[];
  /** A Slack incoming webhook (https://hooks.slack.com/services/...). Never returned in full. */
  slackUrl?: string;
  /** A Microsoft Teams Workflows webhook. Never returned in full. */
  teamsUrl?: string;
  /** A process run that failed (started by a schedule, the API or someone in the Portal; not Designer try-outs). */
  jobFailed: boolean;
  /** Test runs started by a schedule or a pipeline: only when a test failed, every time, or never. */
  testRuns: "failures" | "always" | "off";
  /** A PC stopped answering. */
  agentOffline: boolean;
}

/** Something a person (or pipeline) did in the workspace, for its admins. */
export interface AuditEvent {
  id: string;
  workspaceId: string;
  at: string;
  /** "Name <email>", a token's name, or the email someone tried to sign in with. */
  actor: string;
  actorKind: "user" | "token" | "api" | "open" | "anonymous";
  ip?: string;
  /** What was done, e.g. "workflow.publish" (see audit.ts). */
  action: string;
  method: string;
  /** The route, e.g. /api/workflows/:id/publish. */
  route: string;
  targetId?: string;
  /** The record's name when it was done (it may be renamed or deleted later). */
  target?: string;
  /** HTTP status: under 400 done, 401/403 refused. */
  status: number;
  /** A few safe facts (a new role, on/off); never passwords or secret values. */
  details?: Record<string, unknown>;
  /** The same change made again shortly after (e.g. saving a workflow): how many times. */
  count?: number;
}

/** Where automations run: built and tried in Development, checked in Test, used for real in Production. */
export type EnvironmentId = "dev" | "test" | "prod";
export const ENVIRONMENTS: EnvironmentId[] = ["dev", "test", "prod"];

export interface WorkspaceCicd {
  /**
   * On: publishing puts a version in Development, and it is promoted to Test,
   * then Production. Off: everything is Production (as before environments existed).
   */
  environments: boolean;
  /** Promotions to Production wait for an admin's approval (someone other than who asked). */
  requireApproval: boolean;
  git?: GitSettings;
}

/** The workspace's Git repository for its workflows (one JSON file per workflow). */
export interface GitSettings {
  /** https://github.com/acme/automations.git (GitHub, GitLab, Azure DevOps, ...). */
  url: string;
  branch: string;
  /** Folder in the repository that holds the workflow files. */
  folder: string;
  username: string;
  /** Personal access token with read/write access to the repository. Never returned by the API. */
  token: string;
  /** Publish changed workflows to Development when the repository's webhook reports a push. */
  autoPublish: boolean;
  /** Proves webhook calls come from the repository's host. */
  webhookSecret: string;
  lastSync?: { at: string; commit?: string; error?: string; changed?: number };
}

/** A request to put a version into Test or Production, and its outcome. */
export interface Promotion {
  id: string;
  workspaceId: string;
  packageId: string;
  name: string;
  version: number;
  to: EnvironmentId;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedBy: string;
  /** Principal id of who asked (they cannot approve it themselves). */
  requestedById: string;
  requestedAt: string;
  note?: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

/** Lets a CI pipeline (GitHub Actions, Azure Pipelines, ...) call the API without a person signing in. */
export interface ApiToken {
  id: string;
  workspaceId: string;
  name: string;
  /** What the pipeline may do: never admin. */
  role: "viewer" | "operator" | "developer";
  /** SHA-256 of the token; the token itself is shown once, when it is created. */
  tokenHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface WorkspaceSso {
  enabled: boolean;
  /** OpenID Connect issuer, e.g. https://login.microsoftonline.com/<tenant>/v2.0 */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Role for people who sign in for the first time. */
  defaultRole: Role;
  /** Create accounts on first sign-in (otherwise an admin adds people first). */
  autoProvision: boolean;
  /** People of the company's domains cannot sign in with a password. */
  enforce: boolean;
}

/** A company sign-in in progress (between leaving for the identity provider and coming back). */
export interface SsoState {
  /** SHA-256 of the state parameter. */
  id: string;
  workspaceId: string;
  nonce: string;
  codeVerifier: string;
  returnTo?: string;
  expiresAt: string;
}

export interface WorkspaceSecurity {
  /** Everyone signing in with a password must use two-step sign-in. */
  requireMfa?: boolean;
  /** Minutes without activity (mouse, keyboard) before people are signed out; 0 = never. Unset: DEFAULT_IDLE_MINUTES. */
  idleTimeoutMinutes?: number;
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
  /** Its file in the workspace's Git repository, and the last commit of it. */
  git?: { path: string; commit?: string; committedAt?: string; committedBy?: string };
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
  /** The environments this version is in, and when it got there (the newest one there is what runs). */
  deployments?: Partial<Record<EnvironmentId, { at: string; by: string }>>;
  /** Published from Git: the commit and file it came from. */
  source?: { commit: string; path: string };
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
  /** The environment whose jobs this PC runs (Production when unset). */
  environment?: EnvironmentId;
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
  /** Set when approved: this PC's earlier bot (reinstalled), which gets the new credential instead of a new bot being added. */
  replacesAgentId?: string;
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
  source: "manual" | "schedule" | "designer" | "api" | "test";
  scheduleId?: string;
  /** The test run it is part of. */
  testRunId?: string;
  targetAgentId?: string;
  agentId?: string;
  /** Only PCs of this environment take the job (Production when unset). */
  environment?: EnvironmentId;
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
  /** What it runs: a published process ... */
  packageId?: string;
  /** ... or test cases (these, a folder with its sub-folders, or all): a test run, as "Run all". */
  tests?: { caseIds?: string[]; folderId?: string | null };
  cron: string;
  timezone?: string;
  inputs: Record<string, unknown>;
  targetAgentId?: string;
  /** Production when unset. */
  environment?: EnvironmentId;
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
  /** Used only by that environment's PCs; unset = every environment (an environment's own asset of the same name wins). */
  environment?: EnvironmentId;
  updatedAt: string;
}

export type Role = "admin" | "developer" | "operator" | "viewer";
export const ROLES: Role[] = ["viewer", "operator", "developer", "admin"];

/** A product update email to customers. */
export interface Announcement {
  id: string;
  subject: string;
  /** Plain text with simple Markdown (paragraphs, - lists, **bold**, [links](https://...)). */
  body: string;
  /** Sent in each person's language (translated with AI). */
  translate: boolean;
  createdAt: string;
  createdBy: string;
  status: "sending" | "sent";
  recipients: number;
  sent: number;
  failed: number;
  finishedAt?: string;
}

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
  /** false: no product update emails (unsubscribed). Unset means yes. */
  productUpdates?: boolean;
  /** The language last used to sign in (for emails in their language). */
  language?: string;
  /** Two-step sign-in with an authenticator app. */
  mfa?: UserMfa;
  /** "sso": the account signs in through the company's identity provider. */
  authSource?: "password" | "sso";
  /**
   * Controls the whole platform (every customer's workspace, plans, backups).
   * Only for admins of the default workspace, and only with two-step sign-in.
   */
  platformOwner?: boolean;
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
  /** When the person last used the Portal or Designer (mouse, keyboard); for signing out after inactivity. */
  lastActiveAt?: string;
}

/** Who is making a request: a signed-in user, or the master access token. */
export interface Principal {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** "api": a CI pipeline's API token. */
  kind: "user" | "token" | "open" | "api";
  /** The workspace the request acts in (the default workspace for the master token). */
  workspaceId: string;
  /** Signed in, but may only use their own account until this is resolved. */
  restriction?: "email_unverified" | "mfa_setup_required";
  /** A user account that controls the whole platform (see User.platformOwner). */
  platformOwner?: boolean;
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

/** A folder of test cases (folders nest). */
export interface TestFolder {
  id: string;
  workspaceId: string;
  name: string;
  /** Unset: at the top level. */
  parentId?: string;
  createdAt: string;
}

/**
 * A test: its own steps (with "Verify ..." checks, and "Call Workflow" steps),
 * built in the Designer. It passes when its run succeeds. Test cases from before
 * they had steps run a workflow (`workflowId`) and check its outputs instead.
 */
export interface TestCase {
  id: string;
  workspaceId: string;
  name: string;
  /** Unset: at the top level. */
  folderId?: string;
  /** Its steps. */
  definition?: Workflow;
  /** Older test cases: the workflow they run (with `inputs` and `expectedOutputs`). */
  workflowId?: string;
  inputs: Record<string, unknown>;
  expectedOutputs?: Record<string, unknown>;
  /** Run on this PC (else any PC that takes the job). */
  targetAgentId?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  /** The job of its latest run. */
  lastJobId?: string;
  /** Test data: the test runs once per row, each column's value in the variable of that name. */
  data?: TestData;
}

/** A table of values for a data-driven test. Column names are variable names. */
export interface TestData {
  columns: string[];
  rows: string[][];
}

/** Running several test cases at once (a folder, or all of them). */
export interface TestRun {
  id: string;
  workspaceId: string;
  /** "All test cases", or the folder's path. */
  name: string;
  startedBy: string;
  startedAt: string;
  /** Who started it: a person (Designer), a schedule, or a pipeline (API token). */
  source?: "person" | "schedule" | "api";
  items: TestRunItem[];
  /** Set when every test finished (and the alerts went out). */
  finishedAt?: string;
}

export interface TestRunItem {
  testCaseId: string;
  name: string;
  path: string;
  jobId?: string;
  /** Could not start (no runs left this month, the workflow was deleted, ...). */
  error?: string;
  /** Data-driven: the row of the test data (1 = the first), and its first value. */
  row?: number;
  rowLabel?: string;
  /** Kept when the test finished, so results outlive the job. */
  result?: { status: "passed" | "failed" | "cancelled"; message?: string; finishedAt: string; durationMs?: number };
}
