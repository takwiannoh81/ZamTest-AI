import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agentHeaders = { "x-agent-key": "k" };
const definition = {
  id: "hello",
  name: "Hello",
  variables: [{ name: "who", type: "string", direction: "in", default: "world" }],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "hi {{ who }}" } }] } },
};

describe("running a job again, and deleting jobs", () => {
  it("reruns with the same process, inputs and PC, and deletes only finished jobs", async () => {
    const config = { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null };
    ({ app } = await buildApp({ config, ai: null }));
    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { name: "bot-1" } })).json();
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Hello", definition } })).json();
    const pkg = (await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, payload: {} })).json();
    const first = (await app.inject({ method: "POST", url: "/api/jobs", payload: { packageId: pkg.id, inputs: { who: "bots" }, targetAgentId: agentId } })).json();

    // Still running: cannot be deleted.
    expect((await app.inject({ method: "DELETE", url: `/api/jobs/${first.id}` })).statusCode).toBe(409);

    const again = await app.inject({ method: "POST", url: `/api/jobs/${first.id}/rerun` });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ packageId: pkg.id, inputs: { who: "bots" }, targetAgentId: agentId, status: "pending", source: "manual" });
    expect(again.json().id).not.toBe(first.id);

    // A Designer test run is run again from the same definition.
    const test = (await app.inject({ method: "POST", url: "/api/jobs", payload: { definition, source: "designer" } })).json();
    const testAgain = (await app.inject({ method: "POST", url: `/api/jobs/${test.id}/rerun` })).json();
    expect(testAgain).toMatchObject({ name: "Hello", source: "designer" });

    await app.inject({ method: "POST", url: `/api/jobs/${first.id}/cancel` });
    expect((await app.inject({ method: "DELETE", url: `/api/jobs/${first.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${first.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${first.id}/logs` })).statusCode).toBe(404);
  });
});
