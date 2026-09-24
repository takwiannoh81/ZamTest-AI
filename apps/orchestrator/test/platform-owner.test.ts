import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { base32Decode, currentStep, hotp } from "../src/totp.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });

async function setup(store = new Store(null)) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_ALLOW_SIGNUP: "true" }), dataDir: null };
  ({ app } = await buildApp({ config, store, ai: null }));
}

async function signIn(email: string) {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  return { cookie: cookieOf(res), "x-zamtech-client": "test" };
}

async function turnOnMfa(headers: Record<string, string>) {
  const { secret } = (await call(headers, "POST", "/api/auth/mfa/setup")).json();
  const code = hotp(base32Decode(secret), currentStep());
  expect((await call(headers, "POST", "/api/auth/mfa/enable", { code })).statusCode).toBe(200);
}

describe("the platform owner's account", () => {
  it("is granted by the master token, needs two-step sign-in, and is the only admin who sees every customer", async () => {
    await setup();
    await call(master, "POST", "/api/users", { email: "owner@zamtechai.com", name: "Owner", role: "admin", password: PASSWORD });
    await call(master, "POST", "/api/users", { email: "colleague@zamtechai.com", name: "Colleague", role: "admin", password: PASSWORD });
    const users = (await call(master, "GET", "/api/users")).json() as Array<{ id: string; email: string }>;
    const owner = users.find((u) => u.email === "owner@zamtechai.com")!;
    const colleague = users.find((u) => u.email === "colleague@zamtechai.com")!;

    // An admin of the platform's own workspace is not, by that alone, the platform owner.
    const col = await signIn("colleague@zamtechai.com");
    expect((await call(col, "GET", "/api/auth/me")).json().platformAdmin).toBe(false);
    expect((await call(col, "GET", "/api/platform/workspaces")).statusCode).toBe(403);
    expect((await call(col, "PUT", `/api/users/${colleague.id}`, { platformOwner: true })).statusCode).toBe(403);

    expect((await call(master, "PUT", `/api/users/${owner.id}`, { platformOwner: true })).json().platformOwner).toBe(true);

    // Two-step sign-in first.
    const own = await signIn("owner@zamtechai.com");
    expect((await call(own, "GET", "/api/auth/me")).json()).toMatchObject({ restriction: "mfa_setup_required" });
    expect((await call(own, "GET", "/api/platform/workspaces")).json().code).toBe("mfa_setup_required");
    await turnOnMfa(own);
    expect((await call(own, "GET", "/api/auth/me")).json()).toMatchObject({ platformAdmin: true });
    expect((await call(own, "GET", "/api/platform/workspaces")).statusCode).toBe(200);

    // The owner can hand it on, but not drop their own.
    expect((await call(own, "PUT", `/api/users/${owner.id}`, { platformOwner: false })).statusCode).toBe(409);
    expect((await call(own, "PUT", `/api/users/${colleague.id}`, { platformOwner: true })).statusCode).toBe(200);
    // No longer an admin: no longer the owner.
    const demoted = (await call(own, "PUT", `/api/users/${colleague.id}`, { role: "developer" })).json();
    expect(demoted.platformOwner).toBeUndefined();

    // The owner sees every customer's workspace.
    const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Acme", name: "A", email: "a@acme.example", password: PASSWORD } });
    expect(signup.statusCode).toBe(201);
    const acme = (await call(own, "GET", "/api/platform/workspaces")).json().find((w: { name: string }) => w.name === "Acme");
    expect(acme).toBeDefined();
  });

  it("is kept, once, by admins of the platform's own workspace from before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zt-owner-"));
    try {
      writeFileSync(
        join(dir, "db.json"),
        JSON.stringify({
          users: {
            usr_a: { id: "usr_a", email: "a@zamtechai.com", name: "A", role: "admin", passwordHash: "x", createdAt: "2026-01-01T00:00:00Z" },
            usr_d: { id: "usr_d", email: "d@zamtechai.com", name: "D", role: "developer", passwordHash: "x", createdAt: "2026-01-01T00:00:00Z" },
          },
        }),
      );
      const store = new Store(dir);
      expect(store.data.users.usr_a!.platformOwner).toBe(true);
      expect(store.data.users.usr_d!.platformOwner).toBeUndefined();
      // Admins added later are not owners, even after a restart.
      store.data.users.usr_b = { ...store.data.users.usr_a!, id: "usr_b", email: "b@zamtechai.com", platformOwner: undefined };
      store.flush();
      expect(new Store(dir).data.users.usr_b!.platformOwner).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
