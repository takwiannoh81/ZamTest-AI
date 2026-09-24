import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const workflow = (name: string) => ({
  name,
  definition: { schemaVersion: 1, id: "w", name, variables: [], root: { id: "root", type: "core.sequence", props: {}, slots: { body: [] } } },
});

async function setup(env: Record<string, string> = { ZAMTEST_ALLOW_SIGNUP: "true" }, store = new Store(null)) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_AGENT_KEY: "shared-key", ...env }), dataDir: null };
  ({ app } = await buildApp({ config, store, ai: null }));
  return store;
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;

/** A new customer signs up; returns headers acting as its admin. */
async function signUp(company: string) {
  const email = `admin@${company.toLowerCase()}.example`;
  const res = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company, name: `${company} Admin`, email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return { cookie: cookieOf(res), "x-zamtech-client": "test" };
}

const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });

describe("sign-up", () => {
  it("is closed unless the server allows it", async () => {
    await setup({});
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({ signup: false });
    const res = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Acme", name: "A", email: "a@acme.example", password: PASSWORD } });
    expect(res.statusCode).toBe(403);
  });

  it("creates a workspace with the new person as its admin", async () => {
    await setup();
    expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({ signup: true });
    const acme = await signUp("Acme");
    const me = (await call(acme, "GET", "/api/auth/me")).json();
    expect(me).toMatchObject({ role: "admin", kind: "user", workspace: { name: "Acme" }, platformAdmin: false });
    expect(me.workspace.id).toMatch(/^ws_/);
    const again = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Other", name: "B", email: "admin@acme.example", password: PASSWORD } });
    expect(again.statusCode).toBe(409);
  });
});

describe("workspaces", () => {
  it("keep each customer's data apart", async () => {
    await setup();
    const acme = await signUp("Acme");
    const globex = await signUp("Globex");
    // Schedules and install keys need a paid plan; the platform owner sets Acme's.
    const acmeId = (await call(acme, "GET", "/api/workspace")).json().id;
    expect((await app.inject({ method: "PUT", url: `/api/platform/workspaces/${acmeId}`, headers: master, payload: { plan: "enterprise" } })).statusCode).toBe(200);

    // Acme builds and publishes a process, and keeps a password and a queue.
    const wf = (await call(acme, "POST", "/api/workflows", workflow("Invoices"))).json();
    const pkg = (await call(acme, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    const asset = (await call(acme, "POST", "/api/assets", { name: "erp", type: "credential", value: { username: "u", password: "acme-secret" } })).json();
    const queue = (await call(acme, "POST", "/api/queues", { name: "invoices" })).json();
    const schedule = (await call(acme, "POST", "/api/schedules", { name: "Nightly", packageId: pkg.id, cron: "0 3 * * *" })).json();
    const job = (await call(acme, "POST", "/api/jobs", { packageId: pkg.id })).json();
    const key = (await call(acme, "POST", "/api/admin/install-keys", { name: "rollout" })).json();
    expect([wf.id, pkg.id, asset.id, queue.id, schedule.id, job.id, key.id].every(Boolean)).toBe(true);

    // Globex sees none of it...
    for (const url of ["/api/workflows", "/api/packages", "/api/assets", "/api/queues", "/api/schedules", "/api/jobs", "/api/agents", "/api/admin/install-keys"]) {
      expect((await call(globex, "GET", url)).json(), url).toEqual([]);
    }
    expect((await call(globex, "GET", "/api/stats")).json()).toMatchObject({ workflows: 0, packages: 0, schedules: 0, jobs: { total: 0 } });
    const users = (await call(globex, "GET", "/api/users")).json();
    expect(users.map((u: { email: string }) => u.email)).toEqual(["admin@globex.example"]);

    // ...and cannot reach it by id, to read, change, delete or run.
    const denied: Array<[Parameters<typeof call>[1], string, unknown?]> = [
      ["GET", `/api/workflows/${wf.id}`],
      ["PUT", `/api/workflows/${wf.id}`, { name: "x" }],
      ["DELETE", `/api/workflows/${wf.id}`],
      ["POST", `/api/workflows/${wf.id}/publish`, {}],
      ["GET", `/api/packages/${pkg.id}`],
      ["DELETE", `/api/packages/${pkg.id}`],
      ["POST", "/api/jobs", { packageId: pkg.id }],
      ["GET", `/api/jobs/${job.id}`],
      ["GET", `/api/jobs/${job.id}/logs`],
      ["POST", `/api/jobs/${job.id}/cancel`],
      ["PUT", `/api/assets/${asset.id}`, { value: { username: "u", password: "stolen" } }],
      ["DELETE", `/api/assets/${asset.id}`],
      ["GET", `/api/queues/${queue.id}/items`],
      ["POST", `/api/queues/${queue.id}/items`, { data: {} }],
      ["DELETE", `/api/queues/${queue.id}`],
      ["POST", "/api/schedules", { name: "x", packageId: pkg.id, cron: "0 3 * * *" }],
      ["PUT", `/api/schedules/${schedule.id}`, { enabled: false }],
      ["POST", `/api/schedules/${schedule.id}/run`],
      ["DELETE", `/api/schedules/${schedule.id}`],
      ["DELETE", `/api/admin/install-keys/${key.id}`],
    ];
    for (const [method, url, payload] of denied) {
      expect((await call(globex, method, url, payload)).statusCode, `${method} ${url}`).toBe(404);
    }
    const acmeAdmin = users.length ? (await call(acme, "GET", "/api/users")).json()[0] : undefined;
    expect((await call(globex, "PUT", `/api/users/${acmeAdmin.id}`, { role: "viewer" })).statusCode).toBe(404);
    expect((await call(globex, "DELETE", `/api/users/${acmeAdmin.id}`)).statusCode).toBe(404);

    // Names only have to be unique inside a workspace.
    expect((await call(globex, "POST", "/api/assets", { name: "erp", type: "text", value: "globex" })).statusCode).toBe(201);
    expect((await call(globex, "POST", "/api/queues", { name: "invoices" })).statusCode).toBe(201);
    // Acme's data is untouched.
    expect((await call(acme, "GET", "/api/workflows")).json()).toHaveLength(1);
  });

  it("give a PC only its own workspace's jobs, passwords and queues", async () => {
    await setup();
    const acme = await signUp("Acme");
    const globex = await signUp("Globex");
    const acmePkg = (await call(acme, "POST", `/api/workflows/${(await call(acme, "POST", "/api/workflows", workflow("A"))).json().id}/publish`, {})).json();
    const globexPkg = (await call(globex, "POST", `/api/workflows/${(await call(globex, "POST", "/api/workflows", workflow("G"))).json().id}/publish`, {})).json();
    await call(acme, "POST", "/api/assets", { name: "erp", type: "text", value: "acme" });
    await call(globex, "POST", "/api/assets", { name: "erp", type: "text", value: "globex" });
    await call(globex, "POST", "/api/queues", { name: "orders" });
    // Globex's job is older, so a PC that ignored workspaces would take it first.
    const globexJob = (await call(globex, "POST", "/api/jobs", { packageId: globexPkg.id })).json();
    const acmeJob = (await call(acme, "POST", "/api/jobs", { packageId: acmePkg.id })).json();

    // Acme's admin approves a PC: it joins Acme.
    const pc = { name: "acme-pc", machine: "A1", os: "win32", version: "0.1.0" };
    const start = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: pc })).json();
    expect((await call(acme, "POST", `/api/enrollments/${start.userCode}/approve`)).statusCode).toBe(200);
    // Once decided, other workspaces cannot even see the request.
    expect((await call(globex, "GET", `/api/enrollments/${start.userCode}`)).statusCode).toBe(404);
    const { agentToken, agentId } = (await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode: start.deviceCode } })).json();
    const bot = { "x-agent-token": agentToken };
    await app.inject({ method: "POST", url: "/api/agent/register", headers: bot, payload: pc });

    expect((await call(acme, "GET", "/api/agents")).json().map((a: { id: string }) => a.id)).toEqual([agentId]);
    expect((await call(globex, "GET", "/api/agents")).json()).toEqual([]);
    expect((await call(globex, "DELETE", `/api/agents/${agentId}`)).statusCode).toBe(404);
    // Globex cannot aim its jobs at Acme's PC.
    expect((await call(globex, "POST", "/api/jobs", { packageId: globexPkg.id, targetAgentId: agentId })).statusCode).toBe(404);

    const next = await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: bot, payload: {} });
    expect(next.json().id).toBe(acmeJob.id);
    expect((await app.inject({ method: "GET", url: "/api/agent/assets/erp", headers: bot })).json().value).toBe("acme");
    expect((await app.inject({ method: "POST", url: "/api/agent/queues/orders/next", headers: bot, payload: { jobId: acmeJob.id } })).statusCode).toBe(404);
    expect((await call(globex, "GET", `/api/jobs/${globexJob.id}`)).json().status).toBe("pending");
  });

  it("keep backups of the whole database for the platform owner", async () => {
    await setup();
    const acme = await signUp("Acme");
    expect((await call(acme, "GET", "/api/admin/backup")).statusCode).toBe(403);
    expect((await call(acme, "POST", "/api/admin/backup")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/backup", headers: master })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: master })).json()).toMatchObject({ platformAdmin: true, workspace: { id: "ws_default" } });
  });

  it("move data from before workspaces into the default workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zt-ws-"));
    writeFileSync(
      join(dir, "db.json"),
      JSON.stringify({
        workflows: { wf_1: { id: "wf_1", name: "Old", definition: workflow("Old").definition, createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
        users: { usr_1: { id: "usr_1", email: "owner@zamtech.example", name: "Owner", role: "admin", passwordHash: "x", createdAt: "2026-01-01" } },
      }),
    );
    const store = new Store(dir);
    expect(store.data.workspaces.ws_default?.name).toBe("Default workspace");
    expect(store.data.workflows.wf_1?.workspaceId).toBe("ws_default");
    expect(store.data.users.usr_1?.workspaceId).toBe("ws_default");
    await setup({}, store);
    expect((await app.inject({ method: "GET", url: "/api/workflows", headers: master })).json()).toHaveLength(1);
  });
});

describe("data export", () => {
  it("gives a workspace admin all of the workspace's data, without secrets or other workspaces", async () => {
    await setup();
    const acme = await signUp("Acme");
    const globex = await signUp("Globex");
    await call(globex, "POST", "/api/assets", { name: "globex-only", type: "text", value: "x" });
    const wf = (await call(acme, "POST", "/api/workflows", workflow("Invoices"))).json();
    const pkg = (await call(acme, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    await call(acme, "POST", "/api/assets", { name: "erp", type: "credential", value: { username: "u", password: "acme-secret" } });
    const job = (await call(acme, "POST", "/api/jobs", { packageId: pkg.id })).json();

    const res = await call(acme, "GET", "/api/workspace/export");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="zamtech-ai-acme-\d{4}-\d{2}-\d{2}\.json"$/);
    const data = res.json();
    expect(data).toMatchObject({ format: "zamtech-ai-workspace-export", version: 1, workspace: { name: "Acme", plan: "free" } });
    expect(data.workflows.map((w: { id: string }) => w.id)).toEqual([wf.id]);
    expect(data.packages.map((p: { id: string }) => p.id)).toEqual([pkg.id]);
    expect(data.jobs[0]).toMatchObject({ id: job.id });
    expect(data.jobs[0].logs.length).toBeGreaterThan(0);
    expect(data.assets).toEqual([expect.objectContaining({ name: "erp", value: { username: "u", password: "********" } })]);
    expect(data.users).toEqual([expect.objectContaining({ email: "admin@acme.example" })]);
    expect(Object.values(data.usage)).toEqual([{ runs: 1, ai: 0 }]);
    expect(res.body).not.toContain("acme-secret");
    expect(res.body).not.toContain("passwordHash");
    expect(res.body).not.toContain("globex");

    // Only admins may take it.
    await call(acme, "POST", "/api/users", { email: "op@acme.example", name: "Op", role: "operator", password: PASSWORD });
    const opLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "op@acme.example", password: PASSWORD } });
    const op = { cookie: cookieOf(opLogin), "x-zamtech-client": "test" };
    expect((await call(op, "GET", "/api/workspace/export")).statusCode).toBe(403);
  });
});
