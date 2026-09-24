/**
 * Plans and their limits: the one place to change what each plan includes.
 * Prices are not here: they live in Stripe (see billing.ts), and the Portal
 * shows whatever the configured Stripe prices say.
 *
 * - Free: to try ZamTech AI. The Designer is fully usable; unattended work is capped.
 * - Pro: paid per builder seat (people with the Developer or Admin role) and
 *   per bot (connected PC), monthly or yearly.
 * - Enterprise: agreed per customer; the platform owner sets its limits.
 */
import { HttpError } from "./errors.js";
import type { Store } from "./store.js";
import type { Workspace } from "./types.js";

export type PlanId = "free" | "pro" | "enterprise";

export interface Limits {
  /** People with the Developer or Admin role (they build automations). */
  builders: number;
  /** Connected bot PCs. */
  bots: number;
  /** Jobs started per calendar month (manual, scheduled, API and Designer test runs). */
  runsPerMonth: number;
  /** AI requests per calendar month (workflow generation, selector suggestions). */
  aiPerMonth: number;
  /** Schedules run (on the Free plan they are kept but paused). */
  schedules: boolean;
  /** Install keys for silent rollouts. */
  installKeys: boolean;
  /** Company sign-in (SSO) with the customer's identity provider. */
  sso: boolean;
}

export const FREE_LIMITS: Limits = { builders: 1, bots: 1, runsPerMonth: 100, aiPerMonth: 20, schedules: false, installKeys: false, sso: false };

/** Pro: what each paid seat adds. */
export const PRO = {
  runsPerBot: 5_000,
  aiPerBuilder: 500,
};

/** Enterprise without agreed limits, and the platform owner's own workspace. */
export const UNLIMITED: Limits = {
  builders: Number.MAX_SAFE_INTEGER,
  bots: Number.MAX_SAFE_INTEGER,
  runsPerMonth: Number.MAX_SAFE_INTEGER,
  aiPerMonth: Number.MAX_SAFE_INTEGER,
  schedules: true,
  installKeys: true,
  sso: true,
};

export function limitsOf(workspace: Workspace): Limits {
  if (workspace.plan === "enterprise") return { ...UNLIMITED, ...workspace.customLimits };
  if (workspace.plan === "pro") {
    const builders = Math.max(1, workspace.seats?.builders ?? 1);
    const bots = Math.max(1, workspace.seats?.bots ?? 1);
    return { builders, bots, runsPerMonth: bots * PRO.runsPerBot, aiPerMonth: builders * PRO.aiPerBuilder, schedules: true, installKeys: false, sso: false };
  }
  return FREE_LIMITS;
}

/* ------------------------------- usage -------------------------------- */

export const monthKey = (date = new Date()) => date.toISOString().slice(0, 7); // "2026-09"

export interface MonthUsage {
  runs: number;
  ai: number;
}

export function usageOf(store: Store, workspaceId: string, month = monthKey()): MonthUsage {
  return store.data.usage[`${workspaceId}:${month}`] ?? { runs: 0, ai: 0 };
}

function count(store: Store, workspaceId: string, what: keyof MonthUsage) {
  const key = `${workspaceId}:${monthKey()}`;
  const usage = (store.data.usage[key] ??= { runs: 0, ai: 0 });
  usage[what]++;
  store.save();
}

/** What the workspace uses now: builder seats, bots, and this month's runs and AI requests. */
export function currentUsage(store: Store, workspaceId: string) {
  const month = usageOf(store, workspaceId);
  return {
    builders: Object.values(store.data.users).filter((u) => u.workspaceId === workspaceId && !u.disabled && isBuilder(u.role)).length,
    bots: Object.values(store.data.agents).filter((a) => a.workspaceId === workspaceId).length,
    runs: month.runs,
    ai: month.ai,
  };
}

export const isBuilder = (role: string) => role === "developer" || role === "admin";

/* ----------------------------- enforcement ----------------------------- */

export type LimitName = keyof Limits;

/** 402 Payment Required: the plan does not include this; the Portal offers an upgrade. */
export class PlanLimitError extends HttpError {
  constructor(
    public readonly limit: LimitName,
    message: string,
  ) {
    super(402, message);
  }
}

const workspaceOf = (store: Store, workspaceId: string): Workspace => {
  const workspace = store.data.workspaces[workspaceId];
  if (!workspace) throw new HttpError(404, `Workspace ${workspaceId} not found`);
  return workspace;
};

const UPGRADE = "Upgrade your plan under Billing in the Portal.";

/** Before starting a job; counts it when allowed. */
export function useRun(store: Store, workspaceId: string) {
  const limits = limitsOf(workspaceOf(store, workspaceId));
  if (usageOf(store, workspaceId).runs >= limits.runsPerMonth) {
    throw new PlanLimitError("runsPerMonth", `This month's ${limits.runsPerMonth} runs are used up. ${UPGRADE}`);
  }
  count(store, workspaceId, "runs");
}

/** Before an AI request; counts it when allowed. */
export function useAi(store: Store, workspaceId: string) {
  const limits = limitsOf(workspaceOf(store, workspaceId));
  if (usageOf(store, workspaceId).ai >= limits.aiPerMonth) {
    throw new PlanLimitError("aiPerMonth", `This month's ${limits.aiPerMonth} AI requests are used up. ${UPGRADE}`);
  }
  count(store, workspaceId, "ai");
}

/** Before approving another PC. */
export function checkBots(store: Store, workspaceId: string) {
  const limits = limitsOf(workspaceOf(store, workspaceId));
  if (currentUsage(store, workspaceId).bots >= limits.bots) {
    throw new PlanLimitError("bots", `Your plan includes ${limits.bots} bot PC${limits.bots === 1 ? "" : "s"}, and they are all connected. Remove one under Bot Agents, or ${UPGRADE.toLowerCase()}`);
  }
}

/** Before a person becomes (or is added as) a Developer or Admin. */
export function checkBuilders(store: Store, workspaceId: string) {
  const limits = limitsOf(workspaceOf(store, workspaceId));
  if (currentUsage(store, workspaceId).builders >= limits.builders) {
    throw new PlanLimitError("builders", `Your plan includes ${limits.builders} builder seat${limits.builders === 1 ? "" : "s"} (Developers and Admins), and they are all used. ${UPGRADE}`);
  }
}

export function checkFeature(store: Store, workspaceId: string, feature: "schedules" | "installKeys" | "sso") {
  if (limitsOf(workspaceOf(store, workspaceId))[feature]) return;
  const what = { schedules: "Schedules are", installKeys: "Install keys are", sso: "Company sign-in (SSO) is" }[feature];
  throw new PlanLimitError(feature, `${what} not included in your plan. ${UPGRADE}`);
}

export function scheduleAllowed(store: Store, workspaceId: string): boolean {
  const workspace = store.data.workspaces[workspaceId];
  return workspace ? limitsOf(workspace).schedules : false;
}
