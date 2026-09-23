import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { BackupService, fetchBackup } from "../src/backup.js";
import type { BackupTarget } from "../src/backup.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const admin = { authorization: `Bearer ${TOKEN}` };
const definition = {
  id: "w",
  name: "W",
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "hi" } }] } },
};

async function setup(backup?: BackupService, store = new Store(null)) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_AGENT_KEY: "k" }), dataDir: null };
  ({ app } = await buildApp({ config, store, ai: null, backup }));
  return store;
}

async function createUser(role: string, email = `${role}@example.com`) {
  const res = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: admin,
    payload: { email, name: role, role, password: "correct horse battery" },
  });
  expect(res.statusCode).toBe(201);
  const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "correct horse battery" } });
  expect(login.statusCode).toBe(200);
  return { authorization: `Bearer ${login.json().token}` };
}

describe("accounts and roles", () => {
  it("signs users in and out and never returns password hashes", async () => {
    await setup();
    const viewer = await createUser("viewer");
    const meRes = await app.inject({ method: "GET", url: "/api/auth/me", headers: viewer });
    expect(meRes.json()).toMatchObject({ email: "viewer@example.com", role: "viewer", kind: "user" });
    const users = (await app.inject({ method: "GET", url: "/api/users", headers: admin })).json();
    expect(JSON.stringify(users)).not.toContain("scrypt");
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: viewer });
    expect((await app.inject({ method: "GET", url: "/api/stats", headers: viewer })).statusCode).toBe(401);
  });

  it("rejects wrong passwords and rate-limits guessing", async () => {
    await setup();
    await createUser("viewer");
    const bad = () => app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "viewer@example.com", password: "wrong password" } });
    expect((await bad()).statusCode).toBe(401);
    for (let i = 0; i < 10; i++) await bad();
    expect((await bad()).statusCode).toBe(429);
  });

  it("enforces what each role may do", async () => {
    await setup();
    const viewer = await createUser("viewer");
    const operator = await createUser("operator");
    const developer = await createUser("developer");

    // viewers read but cannot change anything
    expect((await app.inject({ method: "GET", url: "/api/workflows", headers: viewer })).statusCode).toBe(200);
    const denied = await app.inject({ method: "POST", url: "/api/workflows", headers: viewer, payload: { definition } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe("forbidden");

    // developers build and publish
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", headers: developer, payload: { definition } })).json();
    const pkg = (await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, headers: developer, payload: {} })).json();

    // operators run published processes but not unpublished test runs, and cannot edit
    const run = await app.inject({ method: "POST", url: "/api/jobs", headers: operator, payload: { packageId: pkg.id } });
    expect(run.statusCode).toBe(201);
    expect(run.json().startedBy).toBe("operator@example.com");
    expect((await app.inject({ method: "POST", url: "/api/jobs", headers: operator, payload: { definition } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: `/api/workflows/${wf.id}`, headers: operator, payload: { name: "x" } })).statusCode).toBe(403);

    // only admins manage users
    expect((await app.inject({ method: "GET", url: "/api/users", headers: developer })).statusCode).toBe(403);
  });

  it("keeps at least one active administrator", async () => {
    await setup();
    const adminUser = await createUser("admin");
    const users = (await app.inject({ method: "GET", url: "/api/users", headers: admin })).json();
    const id = users[0].id;
    const demote = await app.inject({ method: "PUT", url: `/api/users/${id}`, headers: adminUser, payload: { role: "viewer" } });
    expect(demote.statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/users/${id}`, headers: adminUser })).statusCode).toBe(409);
  });

  it("requires sign-in once accounts exist, even without a master token", async () => {
    const store = new Store(null);
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai: null }));
    expect((await app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(200); // local dev: open
    await app.inject({ method: "POST", url: "/api/users", payload: { email: "a@example.com", name: "A", role: "admin", password: "correct horse battery" } });
    expect((await app.inject({ method: "GET", url: "/api/stats" })).statusCode).toBe(401);
  });
});

function fakeS3() {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  const target: BackupTarget = {
    put: async (key, body) => void objects.set(key, { body, lastModified: new Date() }),
    list: async (prefix) => [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lastModified: o.lastModified })),
    remove: async (keys) => keys.forEach((k) => objects.delete(k)),
    get: async (key) => objects.get(key)!.body,
  };
  return { objects, target };
}

describe("backups", () => {
  const config = { bucket: "b", prefix: "zamtest/", cron: "0 3 * * *", keepDays: 30 };

  it("writes gzipped snapshots, prunes old ones and restores the latest", async () => {
    const s3 = fakeS3();
    const old = { body: Buffer.from(""), lastModified: new Date(Date.now() - 40 * 86400_000) };
    s3.objects.set("zamtest/db-old.json.gz", old);
    const store = new Store(null);
    const backup = new BackupService(store, config, s3.target);
    await setup(backup, store);
    await app.inject({ method: "POST", url: "/api/workflows", headers: admin, payload: { definition } });

    const res = await app.inject({ method: "POST", url: "/api/admin/backup", headers: admin });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastKey).toMatch(/^zamtest\/db-.*\.json\.gz$/);
    expect(s3.objects.has("zamtest/db-old.json.gz")).toBe(false);

    const saved = JSON.parse(gunzipSync(s3.objects.get(res.json().lastKey)!.body).toString());
    expect(Object.keys(saved.workflows)).toHaveLength(1);
    const restored = await fetchBackup(s3.target, config, "latest");
    expect(Object.keys(restored.data.workflows)).toHaveLength(1);
  });

  it("reports failures and is admin-only", async () => {
    const failing: BackupTarget = { ...fakeS3().target, put: async () => { throw new Error("AccessDenied"); } };
    await setup(new BackupService(new Store(null), config, failing));
    const res = await app.inject({ method: "POST", url: "/api/admin/backup", headers: admin });
    expect(res.statusCode).toBe(500);
    const status = (await app.inject({ method: "GET", url: "/api/admin/backup", headers: admin })).json();
    expect(status.lastError).toBe("AccessDenied");
    const viewer = await createUser("viewer");
    expect((await app.inject({ method: "GET", url: "/api/admin/backup", headers: viewer })).statusCode).toBe(403);
  });
});
