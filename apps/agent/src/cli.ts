import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { parseWorkflow } from "@zamtest/core";
import { AgentConnection } from "./connection.js";
import { aiEnabled, execute } from "./runtime.js";

const USAGE = `ZamTest AI bot agent

Usage:
  zamtest-agent connect [--server URL] [--key KEY] [--name NAME]
      Unattended mode: connect to the orchestrator and execute queued jobs.
      Defaults: ZAMTEST_SERVER (http://127.0.0.1:4000), ZAMTEST_AGENT_KEY, hostname.

  zamtest-agent run <workflow.json> [--inputs '{"key":"value"}']
      Attended/dev mode: run a workflow file locally and print the log.
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    inputs: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, file] = positionals;

if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : 1);
}

if (command === "connect") {
  const agent = new AgentConnection({
    server: values.server ?? process.env.ZAMTEST_SERVER ?? "http://127.0.0.1:4000",
    key: values.key ?? process.env.ZAMTEST_AGENT_KEY ?? "dev-agent-key",
    name: values.name ?? process.env.ZAMTEST_AGENT_NAME ?? hostname(),
  });
  console.log(`[agent] AI features ${aiEnabled() ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
  const stop = () => {
    agent.stop();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await agent.start();
} else if (command === "run") {
  if (!file) {
    console.error("Missing workflow file\n\n" + USAGE);
    process.exit(1);
  }
  const workflow = parseWorkflow(JSON.parse(await readFile(file, "utf8")));
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  const result = await execute(workflow, {
    inputs: values.inputs ? JSON.parse(values.inputs) : {},
    signal: controller.signal,
    onEvent: (e) => {
      if (e.type === "log") console.log(`${e.time} ${e.level.toUpperCase().padEnd(5)} ${e.message}`);
      if (e.type === "custom") console.log(`${e.time} EVENT ${e.name} ${JSON.stringify(e.data)}`);
    },
  });
  console.log(`\nResult: ${result.status}${result.error ? ` - ${result.error}` : ""} (${result.durationMs} ms)`);
  if (Object.keys(result.outputs).length) console.log("Outputs:", JSON.stringify(result.outputs, null, 2));
  process.exit(result.status === "succeeded" ? 0 : 1);
} else {
  console.error(`Unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}
