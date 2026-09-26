import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { EditLocks, LOCK_TTL_MS } from "../src/editing.js";
import type { Principal } from "../src/types.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const definition = {
  id: "x",
  name: "Invoices",
  variables: [],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [] } },
};

async function setup(env: Record<string, string> = {}) {
  const config = { ...loadConfig({ ZAMTEST_AGENT_KEY: "k", ...env }), dataDir: null };
  ({ app } = await buildApp({ config, ai: null }));
}

/** A Designer window: its lock session, and the version it opened. */
const designer = (session: string, headers: Record<string, string> = {}) => ({
  session,
  lock: (path: string, takeOver?: boolean) => app.inject({ method: "POST", url: `${path}/lock`, headers, payload: { session, takeOver } }),
  unlock: (path: string) => app.inject({ method: "POST", url: `${path}/unlock`, headers, payload: { session } }),
  save: (path: string, basedOn: string, payload: object) =>
    app.inject({ method: "PUT", url: path, headers: { ...headers, "x-zamtech-edit-session": session, "x-zamtech-based-on": basedOn }, payload }),
});

describe("editing together", () => {
  it("lets one Designer window edit a workflow; the others wait or take over", async () => {
    await setup();
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Invoices", definition } })).json();
    const path = `/api/workflows/${wf.id}`;
    const anna = designer("session-anna");
    const ben = designer("session-ben");

    const opened = await anna.lock(path);
    expect(opened.statusCode).toBe(200);
    expect(opened.json().updatedAt).toBe(wf.updatedAt);
    expect((await anna.lock(path)).statusCode).toBe(200); // renewing

    const busy = await ben.lock(path);
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ code: "locked", lock: { sameUser: true } });
    const list = (await app.inject({ method: "GET", url: "/api/workflows" })).json();
    expect(list[0].editing).toMatchObject({ since: expect.any(String) });

    // Saving or deleting what someone else has open is refused, from the Designer and elsewhere.
    expect((await ben.save(path, wf.updatedAt, { name: "Mine" })).json()).toMatchObject({ code: "locked" });
    expect((await app.inject({ method: "PUT", url: path, payload: { name: "API" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: path })).statusCode).toBe(409);

    const saved = await anna.save(path, wf.updatedAt, { name: "Invoices v2" });
    expect(saved.statusCode).toBe(200);

    // Ben takes over; Anna's next renewal says so, and her saves are refused.
    expect((await ben.lock(path, true)).statusCode).toBe(200);
    expect((await anna.lock(path)).statusCode).toBe(409);
    expect((await anna.save(path, saved.json().updatedAt, { name: "Late" })).statusCode).toBe(409);

    await ben.unlock(path);
    expect((await anna.unlock(path)).statusCode).toBe(204); // not hers any more: nothing happens
    expect((await app.inject({ method: "GET", url: "/api/workflows" })).json()[0].editing).toBeUndefined();
    expect((await app.inject({ method: "DELETE", url: path })).statusCode).toBe(204);
  });

  it("refuses a save based on a version someone else has replaced", async () => {
    await setup();
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Invoices", definition } })).json();
    const path = `/api/workflows/${wf.id}`;
    // Saved elsewhere (the Portal, the API, a Git pull) while the Designer had it open.
    await new Promise((r) => setTimeout(r, 5));
    const other = (await app.inject({ method: "PUT", url: path, payload: { name: "Changed elsewhere" } })).json();

    const stale = await designer("session-anna").save(path, wf.updatedAt, { name: "Mine" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "changed", updatedAt: other.updatedAt, updatedBy: expect.any(String) });
    // Choosing to overwrite: the save is based on the version now on the server.
    const overwritten = await designer("session-anna").save(path, other.updatedAt, { name: "Mine" });
    expect(overwritten.json().name).toBe("Mine");
  });

  it("does the same for test cases", async () => {
    await setup();
    const tc = (await app.inject({ method: "POST", url: "/api/test-cases", payload: { name: "Login works" } })).json();
    const path = `/api/test-cases/${tc.id}`;
    expect((await designer("session-anna").lock(path)).statusCode).toBe(200);
    expect((await designer("session-ben").lock(path)).json()).toMatchObject({ code: "locked" });
    expect((await app.inject({ method: "PUT", url: path, payload: { name: "Renamed" } })).json()).toMatchObject({ code: "locked" });
    expect((await app.inject({ method: "DELETE", url: path })).statusCode).toBe(409);
    expect((await designer("session-anna").save(path, tc.updatedAt, { name: "Login still works" })).statusCode).toBe(200);
  });

  it("shows other people by name", async () => {
    const TOKEN = "master-token-0123456789abcdef";
    const PASSWORD = "correct horse battery";
    await setup({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_ALLOW_SIGNUP: "true" });
    const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Acme", name: "Anna", email: "anna@acme.example", password: PASSWORD } });
    const annaHeaders = { cookie: cookieOf(signup), "x-zamtech-client": "test" };
    const workspaceId = (await app.inject({ method: "GET", url: "/api/workspace", headers: annaHeaders })).json().id;
    await app.inject({ method: "PUT", url: `/api/platform/workspaces/${workspaceId}`, headers: { authorization: `Bearer ${TOKEN}` }, payload: { plan: "enterprise" } });
    const created = await app.inject({ method: "POST", url: "/api/users", headers: annaHeaders, payload: { email: "ben@acme.example", name: "Ben", role: "developer", password: PASSWORD } });
    expect(created.statusCode, created.body).toBe(201);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ben@acme.example", password: PASSWORD } });
    const benHeaders = { cookie: cookieOf(login), "x-zamtech-client": "test" };

    const wf = (await app.inject({ method: "POST", url: "/api/workflows", headers: annaHeaders, payload: { name: "Invoices", definition } })).json();
    const path = `/api/workflows/${wf.id}`;
    expect((await designer("session-anna", annaHeaders).lock(path)).statusCode).toBe(200);
    const busy = (await designer("session-ben", benHeaders).lock(path)).json();
    expect(busy).toMatchObject({ code: "locked", error: "Anna is editing this in the Designer", lock: { name: "Anna", sameUser: false } });

    await designer("session-anna", annaHeaders).unlock(path);
    const saved = (await designer("session-ben", benHeaders).save(path, wf.updatedAt, { name: "Invoices v2" })).json();
    expect(saved.updatedBy).toBe("Ben");
  });
});

describe("EditLocks", () => {
  it("frees a lock that is not renewed", () => {
    let now = 1_000_000;
    const locks = new EditLocks(() => now);
    const anna = { id: "u1", name: "Anna" } as Principal;
    const ben = { id: "u2", name: "Ben" } as Principal;
    expect(locks.take("wf_1", "a-session", anna)).toEqual({ ok: true });
    now += LOCK_TTL_MS - 1;
    expect(locks.take("wf_1", "b-session", ben).ok).toBe(false);
    now += 1;
    expect(locks.take("wf_1", "b-session", ben)).toEqual({ ok: true });
    expect(locks.get("wf_1")?.name).toBe("Ben");
  });
});
