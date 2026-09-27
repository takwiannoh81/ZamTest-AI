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

describe("pausing a job", () => {
  it("pauses and resumes a running job, tells the bot, and needs agent 0.4.0", async () => {
    const config = { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null };
    ({ app } = await buildApp({ config, ai: null }));
    const post = (url: string, payload: unknown = {}, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers, payload: payload as object });
    const { agentId } = (await post("/api/agent/register", { name: "bot-1", version: "0.4.0" }, agentHeaders)).json();

    const job = (await post("/api/jobs", { definition, source: "designer" })).json();
    // Not started yet: nothing to pause.
    expect((await post(`/api/jobs/${job.id}/pause`)).statusCode).toBe(409);
    expect((await post("/api/agent/jobs/next", { agentId }, agentHeaders)).json().id).toBe(job.id);

    const paused = await post(`/api/jobs/${job.id}/pause`);
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json()).toMatchObject({ status: "running", paused: true });
    // The bot hears it, also when it has no events to send.
    expect((await post(`/api/agent/jobs/${job.id}/events`, { agentId, events: [] }, agentHeaders)).json()).toEqual({ cancel: false, pause: true });
    const logs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/logs` })).json() as Array<{ message: string }>;
    expect(logs.at(-1)!.message).toMatch(/^Paused by .*: the run waits before its next step$/);

    expect((await post(`/api/jobs/${job.id}/resume`)).json()).not.toHaveProperty("paused");
    expect((await post(`/api/agent/jobs/${job.id}/events`, { agentId, events: [] }, agentHeaders)).json()).toEqual({ cancel: false, pause: false });
    expect((await post(`/api/jobs/${job.id}/resume`)).statusCode).toBe(409);

    // Stopping a paused job cancels it.
    await post(`/api/jobs/${job.id}/pause`);
    expect((await post(`/api/jobs/${job.id}/cancel`)).json()).toMatchObject({ status: "cancelling" });
    expect((await post(`/api/agent/jobs/${job.id}/events`, { agentId, events: [] }, agentHeaders)).json()).toEqual({ cancel: true, pause: false });
    await post(`/api/agent/jobs/${job.id}/complete`, { agentId, status: "cancelled" }, agentHeaders);

    // An older bot cannot pause; it can still be stopped.
    const old = (await post("/api/agent/register", { name: "bot-2", version: "0.3.9" }, agentHeaders)).json();
    const other = (await post("/api/jobs", { definition, source: "designer", targetAgentId: old.agentId })).json();
    expect((await post("/api/agent/jobs/next", { agentId: old.agentId }, agentHeaders)).json().id).toBe(other.id);
    const refused = await post(`/api/jobs/${other.id}/pause`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain("0.4.0");
  });
});
