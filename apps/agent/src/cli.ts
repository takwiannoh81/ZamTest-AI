import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { parseArgs } from "node:util";
import { parseWorkflow } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { recordDesktop, desktopSelfTest } from "./desktop-cli.js";
import { AgentConnection } from "./connection.js";
import { agentKeyFrom, loadAgentConfig } from "./config.js";
import { aiEnabled, execute } from "./runtime.js";
import { startRecording } from "./recorder.js";
import { createInterface } from "node:readline/promises";
import { writeFile } from "node:fs/promises";

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) {
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => write.call(rl, s.startsWith(question) ? s : "");
  }
  const answer = await rl.question(question);
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

async function saveOrUpload(workflow: Workflow, name: string, server: string) {
  const steps = workflow.root.slots?.body?.length ?? 0;
  const out = values.out ?? (values.upload ? undefined : "recording.json");
  if (out) {
    await writeFile(out, JSON.stringify(workflow, null, 2));
    console.log(`\nSaved ${steps} steps to ${out}`);
  }
  if (values.upload) {
    let token = process.env.ZAMTEST_TOKEN;
    if (!token) {
      const email = await prompt("Email: ");
      const password = await prompt("Password: ", true);
      const login = await fetch(new URL("/api/auth/login", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!login.ok) throw new Error("Sign-in failed. Check your email and password.");
      token = ((await login.json()) as { token: string }).token;
    }
    const res = await fetch(new URL("/api/workflows", server), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, definition: workflow }),
    });
    if (!res.ok) throw new Error(`Upload failed: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.status}`);
    console.log(`Uploaded "${name}" to ${server}. Open it in the Designer to review and publish.`);
  }
}

async function record(url: string) {
  const server = defaultServer();
  const name = values.name ?? `Recording of ${new URL(url).hostname}`;
  const recording = await startRecording(url, {
    name,
    onEvent: (e) => console.log(`  recorded ${e.kind.padEnd(6)} ${e.description}${e.secret ? " (password, not stored)" : ""}`),
  });
  console.log("Recording. Use the browser normally, then close it (or press Enter here) to finish.\n");
  await new Promise<void>((resolve) => {
    recording.page.context().browser()?.on("disconnected", () => resolve());
    recording.page.on("close", () => resolve());
    process.once("SIGINT", () => resolve());
    const rl = createInterface({ input: process.stdin });
    rl.once("line", () => {
      rl.close();
      resolve();
    });
  });
  const workflow = await recording.stop();
  await saveOrUpload(workflow, name, server);
  process.exit(0);
}

const USAGE = `ZamTech AI bot agent

Usage:
  zamtest-agent connect [--server URL] [--key KEY] [--name NAME]
      Unattended mode: connect to the orchestrator and execute queued jobs.
      Defaults: ZAMTEST_SERVER (http://127.0.0.1:4000), ZAMTEST_AGENT_KEY, hostname.

  zamtest-agent run <workflow.json> [--inputs '{"key":"value"}']
      Attended/dev mode: run a workflow file locally and print the log.

  zamtest-agent record <url> [--name NAME] [--out FILE] [--upload] [--server URL]
      Opens a browser; click through your process, then close the window
      (or press Enter here). Writes the recorded workflow to FILE and/or
      uploads it to the Designer. --upload asks for your email and password
      (or uses ZAMTEST_TOKEN).

  zamtest-agent record-desktop [program] [--name NAME] [--out FILE] [--upload] [--server URL] [--all-apps]
      Windows only. Records clicks and typing in desktop applications
      (optionally starting [program] first, e.g. notepad.exe; then only that
      program is recorded unless --all-apps is given). Press Enter here to
      finish.

  zamtest-agent desktop-test
      Windows only. Checks desktop automation with Notepad and Calculator
      and writes desktop-test-report.txt.

Every command accepts --config FILE (or ZAMTEST_AGENT_CONFIG): an agent.json
with {"server", "key" or "keyProtected", "name", "env"}, as written by the
Windows installer. Flags and environment variables override it.

Stopping the agent (Ctrl+C) lets a running job finish first, for up to
ZAMTEST_DRAIN_SECONDS (600); press Ctrl+C again to cancel the job.
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    server: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    inputs: { type: "string" },
    out: { type: "string" },
    upload: { type: "boolean" },
    "all-apps": { type: "boolean" },
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command, file] = positionals;
const fileConfig = loadAgentConfig(values.config ?? process.env.ZAMTEST_AGENT_CONFIG);
const defaultServer = () => values.server ?? process.env.ZAMTEST_SERVER ?? fileConfig.server ?? "http://127.0.0.1:4000";

if (values.help || !command) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

if (command === "connect") {
  const agent = new AgentConnection({
    server: defaultServer(),
    key: values.key ?? process.env.ZAMTEST_AGENT_KEY ?? agentKeyFrom(fileConfig) ?? "dev-agent-key",
    name: values.name ?? process.env.ZAMTEST_AGENT_NAME ?? (fileConfig.name || hostname()),
  });
  console.log(`[agent] AI features ${aiEnabled() ? "enabled" : "disabled (set ANTHROPIC_API_KEY to enable)"}`);
  // Stopping lets a running job finish first (up to ZAMTEST_DRAIN_SECONDS); asking again cancels it.
  const drainMs = Number(process.env.ZAMTEST_DRAIN_SECONDS ?? 600) * 1000;
  let stopping = false;
  const shutdown = async (cancelJob: boolean) => {
    if (!stopping) console.log(cancelJob ? "[agent] Stopping now" : "[agent] Stopping after the current job");
    stopping = true;
    await agent.drain(cancelJob ? 0 : drainMs);
    process.exit(0);
  };
  const onSignal = () => {
    if (!stopping) console.log("[agent] Press Ctrl+C again to cancel the running job");
    void shutdown(stopping);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // The Windows tray app cannot send signals to a hidden process; it writes "drain" or "stop" to stdin.
  if (process.env.ZAMTEST_STDIN_CONTROL === "1") {
    const control = createInterface({ input: process.stdin });
    control.on("line", (line) => {
      if (line.trim() === "stop") void shutdown(true);
      else if (line.trim() === "drain") void shutdown(false);
    });
    control.on("close", () => void shutdown(stopping));
  }
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
} else if (command === "record") {
  if (!file) {
    console.error("Missing URL\n\n" + USAGE);
    process.exit(1);
  }
  await record(file);
} else if (command === "record-desktop") {
  const name = values.name ?? (file ? `Desktop recording of ${file}` : "Desktop recording");
  const workflow = await recordDesktop({ program: file, name, allApps: values["all-apps"] });
  await saveOrUpload(workflow, name, defaultServer());
  process.exit(0);
} else if (command === "desktop-test") {
  process.exit((await desktopSelfTest()) ? 0 : 1);
} else {
  console.error(`Unknown command "${command}"\n\n${USAGE}`);
  process.exit(1);
}
