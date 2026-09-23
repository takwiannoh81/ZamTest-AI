import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp({ config, logger: true });

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
