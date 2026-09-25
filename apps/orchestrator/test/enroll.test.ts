import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";

async function setup(env: Record<string, string> = {}) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_AGENT_KEY: "shared-key", ...env }), dataDir: null };
  ({ app } = await buildApp({ config, store: new Store(null), ai: null }));
}

/** The sign-in cookie a response sets, as "name=value" for the next request. */
const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;

async function signIn(role: string) {
  const email = `${role}@example.com`;
  await app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { email, name: role, role, password: PASSWORD } });
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  return { cookie: cookieOf(res), "x-zamtech-client": "test" };
}

const pc = { name: "finance-pc-01", machine: "FIN01", os: "win32 10.0", version: "0.1.0" };

describe("one sign-in for the Portal and the Designer", () => {
  it("sets an HttpOnly cookie that works across the apps and guards changes against forgery", async () => {
    await setup({ NODE_ENV: "production", ZAMTEST_COOKIE_DOMAIN: ".zamtechai.com" });
    await app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { email: "dev@example.com", name: "Dev", role: "developer", password: PASSWORD } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@example.com", password: PASSWORD } });
    const setCookie = String(login.headers["set-cookie"]);
    expect(setCookie).toMatch(/^zt_session=[\w-]{40,}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Domain=\.zamtechai\.com; Secure$/);
    const cookie = cookieOf(login);

    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.json()).toMatchObject({ email: "dev@example.com", role: "developer", kind: "user" });
    // A change sent by the browser with only the cookie (e.g. from another site) is refused.
    const forged = await app.inject({ method: "POST", url: "/api/workflows", headers: { cookie }, payload: { name: "x" } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().code).toBe("csrf");
    const ok = await app.inject({ method: "POST", url: "/api/workflows", headers: { cookie, "x-zamtech-client": "portal" }, payload: { name: "x" } });
    expect(ok.statusCode).toBe(201);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie, "x-zamtech-client": "portal" } });
    expect(String(logout.headers["set-cookie"])).toMatch(/^zt_session=; Path=\/; Max-Age=0;/);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("opens a cookie session with the master access token", async () => {
    await setup();
    expect((await app.inject({ method: "POST", url: "/api/auth/token", payload: { token: "wrong" } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: "/api/auth/token", payload: { token: TOKEN } });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieOf(res) } });
    expect(me.json()).toMatchObject({ role: "admin", kind: "token" });
  });
});

describe("connecting a PC", () => {
  it("brings back the same bot when a reinstalled PC is approved again, even on a plan with one bot", async () => {
    await setup({ ZAMTEST_ALLOW_SIGNUP: "true" });
    // A new customer on the Free plan (1 bot).
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Small Co", name: "Sam", email: "sam@small.example", password: PASSWORD } });
    const owner = { cookie: cookieOf(signup), "x-zamtech-client": "portal" };
    const connect = async () => {
      const { deviceCode, userCode } = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: pc })).json();
      const seen = (await app.inject({ method: "GET", url: `/api/enrollments/${userCode}`, headers: owner })).json();
      const approve = await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/approve`, headers: owner });
      expect(approve.statusCode, approve.body).toBe(200);
      return { seen, done: (await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode } })).json() };
    };

    const first = await connect();
    expect(first.seen.reconnects).toBeUndefined();

    // Uninstalled and installed again: the old credential is gone, the bot is offline, and approving brings it back.
    const again = await connect();
    expect(again.seen.reconnects).toBe("finance-pc-01");
    expect(again.done).toMatchObject({ status: "approved", agentId: first.done.agentId, reconnected: true });
    const agents = (await app.inject({ method: "GET", url: "/api/agents", headers: owner })).json();
    expect(agents).toHaveLength(1);
    // Only the new credential works.
    const old = await app.inject({ method: "POST", url: "/api/agent/heartbeat", headers: { "x-agent-token": first.done.agentToken }, payload: {} });
    expect(old.statusCode).toBe(401);
    const reg = await app.inject({ method: "POST", url: "/api/agent/register", headers: { "x-agent-token": again.done.agentToken }, payload: pc });
    expect(reg.json()).toEqual({ agentId: first.done.agentId });

    // While it is connected, another PC with the same name is a new bot (and needs a free bot seat).
    const { userCode } = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: pc })).json();
    expect((await app.inject({ method: "GET", url: `/api/enrollments/${userCode}`, headers: owner })).json().reconnects).toBeUndefined();
    expect((await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/approve`, headers: owner })).statusCode).toBe(402);
  });

  it("gives a PC its own credential once a Developer approves it in the Portal", async () => {
    await setup();
    const start = await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: pc });
    expect(start.statusCode).toBe(200);
    const { deviceCode, userCode, verificationUrl, approved } = start.json();
    expect(userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // The person signs in again there before approving (signin=1).
    expect(verificationUrl).toBe(`http://localhost:5173/#/connect?code=${userCode}&signin=1`);
    expect(approved).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode } })).json()).toEqual({ status: "pending" });

    // Anyone signed in can see the request; approving needs Developer.
    const viewer = await signIn("viewer");
    const seen = await app.inject({ method: "GET", url: `/api/enrollments/${userCode.toLowerCase()}`, headers: viewer });
    expect(seen.json()).toMatchObject({ name: "finance-pc-01", machine: "FIN01", status: "pending" });
    expect((await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/approve`, headers: viewer })).statusCode).toBe(403);
    const developer = await signIn("developer");
    const approve = await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/approve`, headers: developer });
    expect(approve.json()).toMatchObject({ status: "approved", approvedBy: "developer <developer@example.com>" });
    expect((await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/approve`, headers: developer })).statusCode).toBe(409);

    const done = (await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode } })).json();
    expect(done).toMatchObject({ status: "approved", name: "finance-pc-01", approvedBy: "developer <developer@example.com>" });
    // The credential is handed out once.
    expect((await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode } })).json()).toEqual({ status: "expired" });

    const agentHeaders = { "x-agent-token": done.agentToken };
    const reg = await app.inject({ method: "POST", url: "/api/agent/register", headers: agentHeaders, payload: { ...pc, agentId: "ignored" } });
    expect(reg.json()).toEqual({ agentId: done.agentId });
    expect((await app.inject({ method: "POST", url: "/api/agent/heartbeat", headers: agentHeaders, payload: {} })).statusCode).toBe(200);

    // The Portal lists the PC without its secret.
    const agents = (await app.inject({ method: "GET", url: "/api/agents", headers: admin })).json();
    expect(agents).toEqual([expect.objectContaining({ id: done.agentId, status: "online", approvedBy: "developer <developer@example.com>" })]);
    expect(agents[0]).not.toHaveProperty("tokenHash");

    // A shared-key agent cannot take over the approved PC's record.
    const hijack = await app.inject({ method: "POST", url: "/api/agent/register", headers: { "x-agent-key": "shared-key" }, payload: { ...pc, agentId: done.agentId } });
    expect(hijack.json().agentId).not.toBe(done.agentId);

    // Removing the PC in the Portal revokes its credential.
    expect((await app.inject({ method: "DELETE", url: `/api/agents/${done.agentId}`, headers: admin })).statusCode).toBe(204);
    const revoked = await app.inject({ method: "POST", url: "/api/agent/heartbeat", headers: agentHeaders, payload: {} });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().code).toBe("agent_revoked");
  });

  it("tells a denied PC, and rejects unknown codes", async () => {
    await setup();
    const { deviceCode, userCode } = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: pc })).json();
    const developer = await signIn("developer");
    expect((await app.inject({ method: "POST", url: `/api/enrollments/${userCode}/deny`, headers: developer })).json().status).toBe("denied");
    expect((await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode } })).json()).toEqual({ status: "denied" });
    expect((await app.inject({ method: "GET", url: "/api/enrollments/ZZZZ-ZZZZ", headers: developer })).statusCode).toBe(404);
  });

  it("approves PCs installed silently with an install key", async () => {
    await setup();
    const developer = await signIn("developer");
    expect((await app.inject({ method: "POST", url: "/api/admin/install-keys", headers: developer, payload: { name: "x" } })).statusCode).toBe(403);
    const created = await app.inject({ method: "POST", url: "/api/admin/install-keys", headers: admin, payload: { name: "Finance rollout", maxUses: 1, expiresInDays: 7 } });
    expect(created.statusCode).toBe(201);
    const { key, id } = created.json();
    expect(key).toMatch(/^ztik_/);
    const listed = (await app.inject({ method: "GET", url: "/api/admin/install-keys", headers: admin })).json();
    expect(listed).toEqual([expect.objectContaining({ id, name: "Finance rollout", maxUses: 1, uses: 0 })]);
    expect(listed[0]).not.toHaveProperty("keyHash");
    expect(listed[0]).not.toHaveProperty("key");

    const start = (await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: { ...pc, installKey: key } })).json();
    expect(start.approved).toBe(true);
    const done = (await app.inject({ method: "POST", url: "/api/agent/enroll/poll", payload: { deviceCode: start.deviceCode } })).json();
    expect(done).toMatchObject({ status: "approved", approvedBy: 'Install key "Finance rollout"' });

    const usedUp = await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: { ...pc, installKey: key } });
    expect(usedUp.statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/agent/enroll/start", payload: { ...pc, installKey: "ztik_nope" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/install-keys/${id}`, headers: admin })).statusCode).toBe(204);
  });

  it("accepts no shared key when none is configured", async () => {
    await setup({ NODE_ENV: "production", ZAMTEST_AGENT_KEY: "" });
    const res = await app.inject({ method: "POST", url: "/api/agent/register", headers: { "x-agent-key": "" }, payload: pc });
    expect(res.statusCode).toBe(401);
  });
});
