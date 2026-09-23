export interface OrchestratorConfig {
  port: number;
  host: string;
  dataDir: string | null;
  adminToken?: string;
  agentKey: string;
  /** Allowed browser origins for CORS; `true` allows any (development only). */
  corsOrigins: string[] | true;
  production: boolean;
  /** Agents without a heartbeat for this long are shown offline. */
  agentOfflineMs: number;
  /** Running jobs whose agent has been offline this long are failed. */
  jobLostMs: number;
}

export function loadConfig(env = process.env): OrchestratorConfig {
  return {
    port: Number(env.ZAMTEST_PORT ?? 4000),
    host: env.ZAMTEST_HOST ?? "127.0.0.1",
    dataDir: env.ZAMTEST_DATA_DIR ?? ".data",
    adminToken: env.ZAMTEST_ADMIN_TOKEN || undefined,
    agentKey: env.ZAMTEST_AGENT_KEY || "dev-agent-key",
    corsOrigins: env.ZAMTEST_CORS_ORIGINS
      ? env.ZAMTEST_CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
      : true,
    production: env.NODE_ENV === "production",
    agentOfflineMs: 30_000,
    jobLostMs: 120_000,
  };
}

/** Settings that are fine on a laptop but unsafe on a public server. */
export function productionProblems(config: OrchestratorConfig): string[] {
  if (!config.production) return [];
  const problems: string[] = [];
  if (!config.adminToken || config.adminToken.length < 24) {
    problems.push("ZAMTEST_ADMIN_TOKEN must be set to a random value of at least 24 characters");
  }
  if (config.agentKey === "dev-agent-key" || config.agentKey.length < 24) {
    problems.push("ZAMTEST_AGENT_KEY must be set to a random value of at least 24 characters");
  }
  return problems;
}
