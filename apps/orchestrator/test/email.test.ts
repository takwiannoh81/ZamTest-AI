import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail, Mailer } from "../src/mailer.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const PASSWORD = "correct horse battery";

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
  /** The token in the last email's link. */
  lastToken() {
    return /token=([\w-]+)/.exec(this.sent.at(-1)?.text ?? "")?.[1] ?? "";
  }
}

async function setup(env: Record<string, string> = {}, mailer: Mailer | null = new FakeMailer()) {
  const config = {
    ...loadConfig({ ZAMTEST_ADMIN_TOKEN: "master-token-0123456789abcdef", ZAMTEST_ALLOW_SIGNUP: "true", ZAMTEST_PORTAL_URL: "https://portal.example", ...env }),
    dataDir: null,
  };
  ({ app } = await buildApp({ config, store: new Store(null), ai: null, mailer }));
  return mailer as FakeMailer;
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload: payload as object, headers });

describe("email confirmation", () => {
  it("lets a new account use the workspace only after the link in the email is opened", async () => {
    const mailer = await setup();
    const res = await post("/api/auth/signup", { company: "Acme", name: "Ada", email: "ada@acme.example", password: PASSWORD });
    expect(res.json()).toMatchObject({ verifyEmail: true });
    const headers = { cookie: cookieOf(res), "x-zamtech-client": "test" };
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "ada@acme.example", subject: "Confirm your email for ZamTech AI" });
    expect(mailer.sent[0]!.text).toContain("https://portal.example/#/verify?token=");

    // Until then: who am I, sign out and resend work; nothing else.
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).json()).toMatchObject({ restriction: "email_unverified" });
    const blocked = await app.inject({ method: "GET", url: "/api/workflows", headers });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("email_unverified");
    expect((await post("/api/auth/verify/resend", {}, headers)).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(2);

    // The first link was replaced by the resent one.
    expect((await post("/api/auth/verify", { token: "not-the-token-at-all" })).statusCode).toBe(400);
    const verified = await post("/api/auth/verify", { token: mailer.lastToken() });
    expect(verified.json()).toEqual({ ok: true, email: "ada@acme.example" });
    expect((await post("/api/auth/verify", { token: mailer.lastToken() })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/workflows", headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers })).json().restriction).toBeUndefined();
  });

  it("refuses sign-up on a public server without email", async () => {
    await setup({ NODE_ENV: "production" }, null);
    const res = await post("/api/auth/signup", { company: "Acme", name: "Ada", email: "ada@acme.example", password: PASSWORD });
    expect(res.statusCode).toBe(503);
  });
});

describe("password reset", () => {
  it("sets a new password from the emailed link and signs out everywhere", async () => {
    const mailer = await setup();
    const signup = await post("/api/auth/signup", { company: "Acme", name: "Ada", email: "ada@acme.example", password: PASSWORD });
    const oldSession = { cookie: cookieOf(signup), "x-zamtech-client": "test" };
    await post("/api/auth/verify", { token: mailer.lastToken() });

    // Unknown addresses get the same answer and no email.
    expect((await post("/api/auth/password-reset/request", { email: "nobody@acme.example" })).json()).toEqual({ ok: true, email: true });
    expect(mailer.sent).toHaveLength(1);
    expect((await post("/api/auth/password-reset/request", { email: "ADA@acme.example" })).json()).toEqual({ ok: true, email: true });
    expect(mailer.sent.at(-1)).toMatchObject({ to: "ada@acme.example", subject: "Reset your ZamTech AI password" });
    const token = mailer.lastToken();

    expect((await post("/api/auth/password-reset", { token, password: "short" })).statusCode).toBe(400);
    expect((await post("/api/auth/password-reset", { token, password: "a brand new passphrase" })).json()).toEqual({ ok: true, email: "ada@acme.example" });
    expect((await post("/api/auth/password-reset", { token, password: "another passphrase!" })).statusCode).toBe(400);

    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: oldSession })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email: "ada@acme.example", password: PASSWORD })).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email: "ada@acme.example", password: "a brand new passphrase" })).statusCode).toBe(200);
  });

  it("limits how many emails can be requested", async () => {
    await setup();
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await post("/api/auth/password-reset/request", { email: "someone@acme.example" })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.at(-1)).toBe(429);
  });
});
