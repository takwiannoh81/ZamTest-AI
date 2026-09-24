import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FREE_LIMITS, monthKey } from "../src/plans.js";
import { Scheduler } from "../src/scheduler.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
let store: Store;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const fakeAi = {
  model: "test-model",
  generateWorkflow: async () => ({ workflow: {}, notes: "" }),
  suggestSelectors: async () => ({ suggestions: [] }),
} as unknown as ZamAI;

async function setup() {
  store = new Store(null);
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_ALLOW_SIGNUP: "true" }), dataDir: null };
  ({ app } = await buildApp({ config, store, ai: fakeAi }));
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
async function signUp(company = "Acme") {
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { company, name: "Owner", email: `owner@${company.toLowerCase()}.example`, password: PASSWORD },
  });
  const headers = { cookie: cookieOf(res), "x-zamtech-client": "test" };
  const workspaceId: string = (await app.inject({ method: "GET", url: "/api/workspace", headers })).json().id;
  return { headers, workspaceId };
}
const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });
const expectLimit = (res: LightMyRequestResponse, limit: string) => {
  expect(res.statusCode, res.body).toBe(402);
  expect(res.json()).toMatchObject({ code: "plan_limit", limit });
};

async function publish(headers: Record<string, string>) {
  const wf = (
    await call(headers, "POST", "/api/workflows", {
      name: "W",
      definition: { schemaVersion: 1, id: "w", name: "W", variables: [], root: { id: "root", type: "core.sequence", props: {}, slots: { body: [] } } },
    })
  ).json();
  return (await call(headers, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
}

async function connectPc(headers: Record<string, string>, name: string) {
  const start = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: { name, machine: name } })).json();
  return call(headers, "POST", `/api/enrollments/${start.userCode}/approve`);
}

describe("the Free plan", () => {
  it("reports its limits and usage", async () => {
    await setup();
    const { headers } = await signUp();
    const summary = (await call(headers, "GET", "/api/workspace")).json();
    expect(summary).toMatchObject({ name: "Acme", plan: "free", limits: FREE_LIMITS, usage: { builders: 1, bots: 0, runs: 0, ai: 0 } });
  });

  it("caps runs and AI requests per month", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    const pkg = await publish(headers);
    expect((await call(headers, "POST", "/api/jobs", { packageId: pkg.id })).statusCode).toBe(201);
    store.data.usage[`${workspaceId}:${monthKey()}`]!.runs = FREE_LIMITS.runsPerMonth;
    expectLimit(await call(headers, "POST", "/api/jobs", { packageId: pkg.id }), "runsPerMonth");

    expect((await call(headers, "POST", "/api/ai/generate-workflow", { prompt: "log hello" })).statusCode).toBe(200);
    store.data.usage[`${workspaceId}:${monthKey()}`]!.ai = FREE_LIMITS.aiPerMonth;
    expectLimit(await call(headers, "POST", "/api/ai/generate-workflow", { prompt: "log hello" }), "aiPerMonth");
    expect((await call(headers, "GET", "/api/workspace")).json().usage).toMatchObject({ runs: FREE_LIMITS.runsPerMonth, ai: FREE_LIMITS.aiPerMonth });
  });

  it("includes one builder and one bot PC", async () => {
    await setup();
    const { headers } = await signUp();
    const person = (role: string, email: string) => ({ email, name: email, role, password: PASSWORD });
    // Operators and Viewers are free; Developers and Admins take a builder seat (the owner has the only one).
    expect((await call(headers, "POST", "/api/users", person("operator", "op@acme.example"))).statusCode).toBe(201);
    expectLimit(await call(headers, "POST", "/api/users", person("developer", "dev@acme.example")), "builders");
    const operator = (await call(headers, "GET", "/api/users")).json().find((u: { role: string }) => u.role === "operator");
    expectLimit(await call(headers, "PUT", `/api/users/${operator.id}`, { role: "developer" }), "builders");

    expect((await connectPc(headers, "pc-1")).statusCode).toBe(200);
    // Approved PCs only exist once they collect their credential; approving counts from then on.
    const start = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: { name: "pc-1" } })).json();
    await call(headers, "POST", `/api/enrollments/${start.userCode}/approve`);
    await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode: start.deviceCode } });
    expectLimit(await connectPc(headers, "pc-2"), "bots");
  });

  it("keeps schedules paused and has no install keys", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    const pkg = await publish(headers);
    expectLimit(await call(headers, "POST", "/api/schedules", { name: "Nightly", packageId: pkg.id, cron: "0 3 * * *" }), "schedules");
    const paused = await call(headers, "POST", "/api/schedules", { name: "Nightly", packageId: pkg.id, cron: "0 3 * * *", enabled: false });
    expect(paused.statusCode).toBe(201);
    expectLimit(await call(headers, "PUT", `/api/schedules/${paused.json().id}`, { enabled: true }), "schedules");
    expectLimit(await call(headers, "POST", "/api/admin/install-keys", { name: "rollout" }), "installKeys");

    // A schedule left enabled from a paid plan does not run after a downgrade.
    store.data.schedules[paused.json().id]!.enabled = true;
    const before = Object.keys(store.data.jobs).length;
    new Scheduler(store).fire(paused.json().id);
    expect(Object.keys(store.data.jobs).length).toBe(before);
    expect(workspaceId).toMatch(/^ws_/);
  });
});

describe("paid plans", () => {
  it("follow the seats bought (Pro) or the limits agreed (Enterprise)", async () => {
    await setup();
    const { headers, workspaceId } = await signUp();
    // Customers cannot change their own plan; the platform owner (or Stripe) does.
    expect((await call(headers, "PUT", `/api/platform/workspaces/${workspaceId}`, { plan: "enterprise" })).statusCode).toBe(403);
    expect((await call(headers, "GET", "/api/platform/workspaces")).statusCode).toBe(403);

    const pro = await app.inject({ method: "PUT", url: `/api/platform/workspaces/${workspaceId}`, headers: master, payload: { plan: "pro", seats: { builders: 3, bots: 2 } } });
    expect(pro.json()).toMatchObject({ plan: "pro", limits: { builders: 3, bots: 2, runsPerMonth: 10_000, aiPerMonth: 1_500, schedules: true, installKeys: false } });
    expect((await call(headers, "POST", "/api/users", { email: "dev@acme.example", name: "Dev", role: "developer", password: PASSWORD })).statusCode).toBe(201);
    const pkg = await publish(headers);
    expect((await call(headers, "POST", "/api/schedules", { name: "Nightly", packageId: pkg.id, cron: "0 3 * * *" })).statusCode).toBe(201);

    const enterprise = await app.inject({
      method: "PUT",
      url: `/api/platform/workspaces/${workspaceId}`,
      headers: master,
      payload: { plan: "enterprise", customLimits: { bots: 50 } },
    });
    expect(enterprise.json().limits).toMatchObject({ bots: 50, installKeys: true, schedules: true });
    expect((await call(headers, "POST", "/api/admin/install-keys", { name: "rollout" })).statusCode).toBe(201);

    const all = (await app.inject({ method: "GET", url: "/api/platform/workspaces", headers: master })).json();
    expect(all.map((w: { name: string; plan: string }) => [w.name, w.plan])).toEqual(
      expect.arrayContaining([
        ["Acme", "enterprise"],
        ["Default workspace", "enterprise"],
      ]),
    );
  });
});
