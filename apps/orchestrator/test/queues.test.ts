import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());
const agentHeaders = { "x-agent-key": "k" };

async function setup() {
  const store = new Store(null);
  ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai: null }));
  const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { name: "bot" } })).json();
  return { store, agentId };
}

const agent = (url: string, payload: object) => app.inject({ method: "POST", url, headers: agentHeaders, payload });

describe("work queues", () => {
  it("hands out items in order, retries failures and never retries business exceptions", async () => {
    const { agentId } = await setup();
    const queue = (await app.inject({ method: "POST", url: "/api/queues", payload: { name: "Invoices", maxRetries: 1 } })).json();
    for (const ref of ["INV-1", "INV-2", "INV-3"]) {
      expect((await app.inject({ method: "POST", url: `/api/queues/${queue.id}/items`, payload: { reference: ref, data: { ref } } })).statusCode).toBe(201);
    }
    const dup = await app.inject({ method: "POST", url: `/api/queues/${queue.id}/items`, payload: { reference: "INV-1", data: {} } });
    expect(dup.statusCode).toBe(409);

    // names are case-insensitive for bots
    const first = (await agent("/api/agent/queues/invoices/next", { agentId })).json();
    expect(first.reference).toBe("INV-1");
    await agent(`/api/agent/queue-items/${first.id}/complete`, { agentId, status: "successful", result: { paid: true } });

    const second = (await agent("/api/agent/queues/Invoices/next", { agentId })).json();
    const failed = (await agent(`/api/agent/queue-items/${second.id}/complete`, { agentId, status: "failed", message: "timeout" })).json();
    expect(failed).toEqual({ status: "new", final: false }); // retried once

    const third = (await agent("/api/agent/queues/Invoices/next", { agentId })).json();
    expect(third.reference).toBe("INV-2"); // retried item keeps its place (oldest first)
    expect(third.retries).toBe(1);
    expect((await agent(`/api/agent/queue-items/${third.id}/complete`, { agentId, status: "failed" })).json().status).toBe("failed");

    const fourth = (await agent("/api/agent/queues/Invoices/next", { agentId })).json();
    expect((await agent(`/api/agent/queue-items/${fourth.id}/complete`, { agentId, status: "business-exception", message: "no PO" })).json().status).toBe(
      "business-exception",
    );
    expect((await agent("/api/agent/queues/Invoices/next", { agentId })).statusCode).toBe(204);

    const listed = (await app.inject({ method: "GET", url: "/api/queues" })).json();
    expect(listed[0].counts).toMatchObject({ new: 0, successful: 1, failed: 1, "business-exception": 1 });

    // operators can retry failed items by hand
    const retry = await app.inject({ method: "POST", url: `/api/queue-items/${third.id}/retry` });
    expect(retry.json().status).toBe("new");
  });

  it("returns locked items to the queue when their job fails", async () => {
    const { agentId } = await setup();
    const queue = (await app.inject({ method: "POST", url: "/api/queues", payload: { name: "Orders" } })).json();
    await app.inject({ method: "POST", url: `/api/queues/${queue.id}/items`, payload: { data: { n: 1 } } });
    const definition = { id: "w", name: "W", root: { id: "r", type: "core.sequence", props: {}, slots: { body: [] } } };
    const job = (await app.inject({ method: "POST", url: "/api/jobs", payload: { definition } })).json();
    await agent("/api/agent/jobs/next", { agentId });
    const item = (await agent("/api/agent/queues/Orders/next", { agentId, jobId: job.id })).json();
    await agent(`/api/agent/jobs/${job.id}/complete`, { agentId, status: "failed", error: "browser crashed" });
    const items = (await app.inject({ method: "GET", url: `/api/queues/${queue.id}/items` })).json();
    expect(items[0]).toMatchObject({ id: item.id, status: "new", retries: 1 });
    expect(items[0].message).toMatch(/browser crashed/);
  });

  it("rejects unknown queues with a helpful message", async () => {
    const { agentId } = await setup();
    const res = await agent("/api/agent/queues/nope/next", { agentId });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/Create it in the Portal/);
  });
});
