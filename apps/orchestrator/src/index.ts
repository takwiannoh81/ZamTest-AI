import { buildApp } from "./app.js";
import { BackupService, loadBackupConfig, s3Target } from "./backup.js";
import { loadBillingConfig, StripeBilling } from "./billing.js";
import { Store } from "./store.js";
import { loadConfig, productionProblems } from "./config.js";

const config = loadConfig();
const problems = productionProblems(config);
if (problems.length) {
  console.error(`Refusing to start in production:\n- ${problems.join("\n- ")}\nGenerate values with: openssl rand -hex 32`);
  process.exit(1);
}
const store = new Store(config.dataDir);
const backupConfig = loadBackupConfig();
const backup = backupConfig
  ? new BackupService(store, backupConfig, s3Target(backupConfig), (msg) => console.log(`[backup] ${msg}`))
  : null;
const billingConfig = loadBillingConfig();
const billing = billingConfig ? new StripeBilling(billingConfig) : null;
const { app } = await buildApp({ config, store, backup, billing, logger: true });
app.log.info(billing ? `Billing: Stripe (${billingConfig!.secretKey.startsWith("sk_live_") ? "live" : "test"} mode)` : "Billing: not set up (no STRIPE_* settings)");
if (backupConfig) app.log.info(`Backups: s3://${backupConfig.bucket}/${backupConfig.prefix} on "${backupConfig.cron}", keeping ${backupConfig.keepDays} days`);

if (config.agentKey === "dev-agent-key") {
  app.log.warn("Using the default agent key. Set ZAMTEST_AGENT_KEY before exposing the orchestrator to a network.");
}

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.port, host: config.host });
