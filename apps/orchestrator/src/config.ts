export interface OrchestratorConfig {
  port: number;
  host: string;
  dataDir: string | null;
  adminToken?: string;
  agentKey: string;
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
    agentOfflineMs: 30_000,
    jobLostMs: 120_000,
  };
}
