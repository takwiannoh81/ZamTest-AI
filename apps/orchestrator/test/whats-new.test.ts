import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };

describe("What's new", () => {
  it("shows once to people who had an account before the release, remembered for every app", async () => {
    const store = new Store(null);
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN }), dataDir: null }, store, ai: null }));
    const create = (email: string) => app.inject({ method: "POST", url: "/api/users", headers: master, payload: { email, name: email, role: "developer", password: "correct horse battery" } });
    const login = async (email: string) => ({ authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "correct horse battery" } })).json().token}` });
    const whatsNew = async (headers: Record<string, string>) => (await app.inject({ method: "GET", url: "/api/auth/me", headers })).json().whatsNew;

    const old = (await create("old@example.com")).json();
    await create("new@example.com");
    // One account from before the release.
    store.data.users[old.id]!.createdAt = "2026-01-10T00:00:00.000Z";

    const oldUser = await login("old@example.com");
    expect(await whatsNew(oldUser)).toBe(true);
    // Accounts made after it get everything as new anyway.
    expect(await whatsNew(await login("new@example.com"))).toBe(false);
    // The master token is not a person.
    expect(await whatsNew(master)).toBe(false);

    expect((await app.inject({ method: "POST", url: "/api/auth/me/whats-new", headers: oldUser })).statusCode).toBe(200);
    expect(await whatsNew(oldUser)).toBe(false);
    // Signing in again (the Designer, another PC) does not bring it back.
    expect(await whatsNew(await login("old@example.com"))).toBe(false);
  });
});
