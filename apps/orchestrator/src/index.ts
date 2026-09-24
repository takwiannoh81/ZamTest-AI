import { buildApp } from "./app.js";
import { BackupService, loadBackupConfig, s3Target } from "./backup.js";
import { loadBillingConfig, StripeBilling } from "./billing.js";
import { loadMailer, mailerProblem, readSmtpUrl } from "./mailer.js";
import type { Mailer } from "./mailer.js";
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
// Without SMTP, a development server prints the emails (with their links) to its log instead.
let logMail: ((line: string) => void) | undefined;
const smtp = loadMailer();
const mailer: Mailer | null =
  smtp ?? (config.production ? null : { send: async (m) => logMail?.(`Email to ${m.to}: ${m.subject}\n${m.text}`) });
const { app } = await buildApp({ config, store, backup, billing, mailer, logger: true });
logMail = (line) => app.log.info(line);
if (mailerProblem()) app.log.error(`Email: ${mailerProblem()}. Email is off until it is fixed.`);
else if (!smtp) app.log.warn(config.production ? "Email: not set up (SMTP_URL); sign-up and password reset are unavailable" : "Email: not set up; emails are written to this log");
else {
  // Says in the log whether the SMTP server accepts the user name and password.
  const host = readSmtpUrl(process.env.SMTP_URL).host;
  smtp.check().then(
    () => app.log.info(`Email: signed in to ${host}`),
    (err: Error) => app.log.error(`Email: ${host} refused the sign-in or could not be reached: ${err.message}`),
  );
}
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
