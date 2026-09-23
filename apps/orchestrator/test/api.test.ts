import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

let app: FastifyInstance;
afterEach(() => app?.close());

async function setup(env: Record<string, string> = {}) {
  const config = { ...loadConfig({ ZAMTEST_AGENT_KEY: "k", ...env }), dataDir: null };
  ({ app } = await buildApp({ config, ai: null }));
  return app;
}

const agentHeaders = { "x-agent-key": "k" };

const definition = {
  id: "hello",
  name: "Hello",
  variables: [{ name: "who", type: "string", direction: "in", default: "world" }],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "hi {{ who }}" } }] } },
};

describe("orchestrator API", () => {
  it("runs the full design -> publish -> job -> agent lifecycle", async () => {
    await setup();
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Hello", definition } })).json();
    const pkg = (await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, payload: {} })).json();
    expect(pkg.version).toBe(1);

    const job = (await app.inject({ method: "POST", url: "/api/jobs", payload: { packageId: pkg.id, inputs: { who: "bots" } } })).json();
    expect(job.status).toBe("pending");

    const unauthorized = await app.inject({ method: "POST", url: "/api/agent/register", payload: { name: "bot" } });
    expect(unauthorized.statusCode).toBe(401);

    const { agentId } = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { name: "bot-1", machine: "vm1" } })).json();
    const next = await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agentHeaders, payload: { agentId } });
    expect(next.statusCode).toBe(200);
    expect(next.json().inputs).toEqual({ who: "bots" });

    await app.inject({
      method: "POST",
      url: `/api/agent/jobs/${job.id}/events`,
      headers: agentHeaders,
      payload: {
        agentId,
        events: [
          { type: "log", time: new Date().toISOString(), level: "info", message: "hi bots" },
          { type: "custom", time: new Date().toISOString(), name: "selectorHealed", stepId: "a", data: { oldSelector: "#x", newSelector: "#y" } },
        ],
      },
    });
    await app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/complete`, headers: agentHeaders, payload: { agentId, status: "succeeded", outputs: {} } });

    const done = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).json();
    expect(done.status).toBe("succeeded");
    expect(done.healedSelectors).toHaveLength(1);
    const logs = (await app.inject({ method: "GET", url: `/api/jobs/${job.id}/logs` })).json();
    expect(logs.map((l: { message: string }) => l.message)).toContain("hi bots");

    const agents = (await app.inject({ method: "GET", url: "/api/agents" })).json();
    expect(agents[0].status).toBe("online");
  });

  it("masks credentials for the portal but not for agents", async () => {
    await setup();
    await app.inject({ method: "POST", url: "/api/assets", payload: { name: "erp", type: "credential", value: { username: "u", password: "p" } } });
    const listed = (await app.inject({ method: "GET", url: "/api/assets" })).json();
    expect(listed[0].value.password).toBe("********");
    const forAgent = (await app.inject({ method: "GET", url: "/api/agent/assets/erp", headers: agentHeaders })).json();
    expect(forAgent.value.password).toBe("p");
  });

  it("requires the admin token when configured and validates schedules", async () => {
    await setup({ ZAMTEST_ADMIN_TOKEN: "secret" });
    expect((await app.inject({ method: "GET", url: "/api/workflows" })).statusCode).toBe(401);
    const auth = { authorization: "Bearer secret" };
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", headers: auth, payload: { definition } })).json();
    const pkg = (await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, headers: auth, payload: {} })).json();
    const bad = await app.inject({ method: "POST", url: "/api/schedules", headers: auth, payload: { name: "s", packageId: pkg.id, cron: "not a cron" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/schedules", headers: auth, payload: { name: "s", packageId: pkg.id, cron: "0 9 * * 1-5" } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().nextRunAt).toBeTruthy();
  });

  it("reports AI as not configured", async () => {
    await setup();
    const res = await app.inject({ method: "POST", url: "/api/ai/generate-workflow", payload: { prompt: "log hello" } });
    expect(res.statusCode).toBe(503);
  });
});

describe("production safety", () => {
  it("refuses weak or default secrets in production", async () => {
    const { productionProblems } = await import("../src/config.js");
    expect(productionProblems(loadConfig({ NODE_ENV: "production" }))).toHaveLength(2);
    const strong = "x".repeat(32);
    expect(productionProblems(loadConfig({ NODE_ENV: "production", ZAMTEST_ADMIN_TOKEN: strong, ZAMTEST_AGENT_KEY: strong }))).toEqual([]);
    expect(productionProblems(loadConfig({}))).toEqual([]);
  });
});
