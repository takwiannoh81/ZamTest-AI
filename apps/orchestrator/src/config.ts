export interface OrchestratorConfig {
  port: number;
  host: string;
  dataDir: string | null;
  adminToken?: string;
  /**
   * Shared key for agents that were not approved in the Portal (the cloud bot
   * container, older installs). Unset in production = only approved PCs connect.
   */
  agentKey?: string;
  /** Where people sign in; approval links for new PCs point here. */
  portalUrl: string;
  designerUrl: string;
  /** Domain for the sign-in cookie, e.g. ".zamtechai.com", so the Portal and Designer share one sign-in. */
  cookieDomain?: string;
  /** Anyone may create an account (and with it a new workspace) in the Portal: the hosted service. */
  allowSignup: boolean;
  /** Allowed browser origins for CORS; `true` allows any (development only). */
  corsOrigins: string[] | true;
  production: boolean;
  /** Agents without a heartbeat for this long are shown offline. */
  agentOfflineMs: number;
  /** Running jobs whose agent has been offline this long are failed. */
  jobLostMs: number;
  /** Step screenshots of jobs are deleted after this many days. */
  screenshotDays: number;
  /** Where people get help beyond the docs (the help assistant points there). */
  supportEmail?: string;
}

export function loadConfig(env = process.env): OrchestratorConfig {
  return {
    port: Number(env.ZAMTEST_PORT ?? 4000),
    host: env.ZAMTEST_HOST ?? "127.0.0.1",
    dataDir: env.ZAMTEST_DATA_DIR ?? ".data",
    adminToken: env.ZAMTEST_ADMIN_TOKEN || undefined,
    agentKey: env.ZAMTEST_AGENT_KEY || (env.NODE_ENV === "production" ? undefined : "dev-agent-key"),
    portalUrl: (env.ZAMTEST_PORTAL_URL || "http://localhost:5173").replace(/\/+$/, ""),
    designerUrl: (env.ZAMTEST_DESIGNER_URL || "http://localhost:5174").replace(/\/+$/, ""),
    cookieDomain: env.ZAMTEST_COOKIE_DOMAIN || undefined,
    supportEmail: env.ZAMTEST_SUPPORT_EMAIL?.trim() || undefined,
    // "true", "True", "yes", "1" (with stray quotes or spaces) all mean on.
    allowSignup: /^(true|yes|1|on)$/i.test((env.ZAMTEST_ALLOW_SIGNUP ?? "").replace(/["'\s]/g, "")),
    corsOrigins: env.ZAMTEST_CORS_ORIGINS
      ? env.ZAMTEST_CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : true,
    production: env.NODE_ENV === "production",
    agentOfflineMs: 30_000,
    jobLostMs: 120_000,
    screenshotDays: Math.max(1, Number(env.ZAMTEST_SCREENSHOT_DAYS) || 30),
  };
}

/** Settings that are fine on a laptop but unsafe on a public server. */
export function productionProblems(config: OrchestratorConfig): string[] {
  if (!config.production) return [];
  const problems: string[] = [];
  if (!config.adminToken || config.adminToken.length < 24) {
    problems.push("ZAMTEST_ADMIN_TOKEN must be set to a random value of at least 24 characters");
  }
  if (config.agentKey !== undefined && (config.agentKey === "dev-agent-key" || config.agentKey.length < 24)) {
    problems.push("ZAMTEST_AGENT_KEY must be a random value of at least 24 characters (or unset, so only PCs approved in the Portal connect)");
  }
  return problems;
}
