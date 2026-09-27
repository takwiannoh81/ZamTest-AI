import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentConnection } from "../src/connection.js";

/** A minimal orchestrator that hands out one job and records how it ended. */
async function fakeOrchestrator(delayMs: number, control = { pause: false }, after: unknown[] = []) {
  let handedOut = false;
  const completed: Array<{ status: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, data?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(data === undefined ? undefined : JSON.stringify(data));
      };
      if (req.url === "/api/agent/register") return send(200, { agentId: "agt_test" });
      if (req.url === "/api/agent/heartbeat") return send(200, { cancelJobIds: [] });
      if (req.url === "/api/agent/jobs/next") {
        if (handedOut) return send(204);
        handedOut = true;
        return send(200, {
          id: "job_1",
          name: "Wait",
          inputs: {},
          definition: {
            schemaVersion: 1, id: "wf", name: "Wait", variables: [],
            root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "d", type: "core.delay", props: { ms: delayMs } }, ...after] } },
          },
        });
      }
      if (req.url?.endsWith("/events")) return send(200, { cancel: false, pause: control.pause });
      if (req.url?.endsWith("/complete")) {
        completed.push(JSON.parse(body));
        return send(200, {});
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, completed, jobStarted: () => handedOut, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("stopping the agent", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function runningAgent(delayMs: number) {
    const orch = await fakeOrchestrator(delayMs);
    close = orch.close;
    const logs: string[] = [];
    const agent = new AgentConnection({ server: orch.url, key: "k", name: "test", pollMs: 20, heartbeatMs: 50, log: (m) => logs.push(m) });
    void agent.start();
    while (!orch.jobStarted()) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 50));
    return { agent, orch, logs };
  }

  it("lets the running job finish and reports it", async () => {
    const { agent, orch, logs } = await runningAgent(300);
    await agent.drain(5000);
    expect(orch.completed).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect(logs.some((l) => l.startsWith("Finishing job job_1"))).toBe(true);
  });

  it("cancels the job at the time limit and still reports it", async () => {
    const { agent, orch, logs } = await runningAgent(10_000);
    const started = Date.now();
    await agent.drain(100);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(orch.completed).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(logs).toContain("Time limit reached; cancelling job job_1");
  });

  it("stops at once with a zero time limit", async () => {
    const { agent, orch } = await runningAgent(10_000);
    await agent.drain(0);
    expect(orch.completed).toEqual([expect.objectContaining({ status: "cancelled" })]);
  });
});

describe("pausing a job", () => {
  it("waits before the next step while paused, and goes on when resumed", async () => {
    const control = { pause: true };
    const orch = await fakeOrchestrator(1500, control, [{ id: "l", type: "core.log", props: { message: "second step" } }]);
    const logs: string[] = [];
    const agent = new AgentConnection({ server: orch.url, key: "k", name: "test", pollMs: 20, heartbeatMs: 50, log: (m) => logs.push(m) });
    void agent.start();
    try {
      while (!logs.includes("Job job_1 paused")) await new Promise((r) => setTimeout(r, 20));
      // The first step finishes; the second waits.
      await new Promise((r) => setTimeout(r, 1500));
      expect(orch.completed).toEqual([]);
      expect(logs.some((l) => l.includes("second step"))).toBe(false);

      control.pause = false;
      while (!orch.completed.length) await new Promise((r) => setTimeout(r, 20));
      expect(orch.completed).toEqual([expect.objectContaining({ status: "succeeded" })]);
      expect(logs).toContain("Job job_1 resumed");
      expect(logs.some((l) => l.includes("second step"))).toBe(true);
    } finally {
      await agent.drain(0);
      await orch.close();
    }
  }, 15_000);
});
