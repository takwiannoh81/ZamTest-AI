import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { base32Decode, currentStep, hotp } from "../src/totp.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const PASSWORD = "correct horse battery";
const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
const codeFor = (secret: string, stepOffset = 0) => hotp(base32Decode(secret), currentStep() + stepOffset);

async function setup() {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: "master-token-0123456789abcdef", ZAMTEST_ALLOW_SIGNUP: "true" }), dataDir: null };
  ({ app } = await buildApp({ config, store: new Store(null), ai: null }));
  const res = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Acme", name: "Ada", email: "ada@acme.example", password: PASSWORD } });
  return { cookie: cookieOf(res), "x-zamtech-client": "test" };
}
const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });
const login = (email = "ada@acme.example", password = PASSWORD) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
const secondStep = (mfaToken: string, answer: { code?: string; recoveryCode?: string }) =>
  app.inject({ method: "POST", url: "/api/auth/login/mfa", payload: { mfaToken, ...answer } });

async function turnOn(headers: Record<string, string>) {
  const { secret, otpauthUrl } = (await call(headers, "POST", "/api/auth/mfa/setup")).json();
  expect(otpauthUrl).toContain(`secret=${secret}`);
  expect((await call(headers, "POST", "/api/auth/mfa/enable", { code: "000000" })).statusCode).toBe(400);
  const enabled = await call(headers, "POST", "/api/auth/mfa/enable", { code: codeFor(secret) });
  expect(enabled.statusCode).toBe(200);
  return { secret, recoveryCodes: enabled.json().recoveryCodes as string[] };
}

describe("two-step sign-in", () => {
  it("is set up with an authenticator app and never shows its secret again", async () => {
    const admin = await setup();
    const { secret, recoveryCodes } = await turnOn(admin);
    expect(recoveryCodes).toHaveLength(10);
    expect((await call(admin, "GET", "/api/auth/mfa")).json()).toEqual({ enabled: true, required: false, recoveryCodesLeft: 10 });
    const users = await call(admin, "GET", "/api/users");
    expect(users.json()[0]).toMatchObject({ email: "ada@acme.example", mfaEnabled: true });
    expect(users.body).not.toContain(secret);
    expect(users.body).not.toContain("recoveryCodes");
  });

  it("asks for a code after the password, once per code, with recovery codes as a fallback", async () => {
    const admin = await setup();
    const { secret, recoveryCodes } = await turnOn(admin);

    const first = await login();
    expect(first.json()).toMatchObject({ mfaRequired: true });
    expect(first.headers["set-cookie"]).toBeUndefined();
    const { mfaToken } = first.json();
    expect((await secondStep(mfaToken, { code: "123456" })).json().code).toBe("invalid_code");
    // The code used to switch it on cannot be used again; the next one can.
    expect((await secondStep(mfaToken, { code: codeFor(secret) })).statusCode).toBe(401);
    const ok = await secondStep(mfaToken, { code: codeFor(secret, 1) });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toMatch(/^zt_session=/);
    // The challenge is used up.
    expect((await secondStep(mfaToken, { code: codeFor(secret, 1) })).json().code).toBe("mfa_expired");

    const again = (await login()).json().mfaToken;
    expect((await secondStep(again, { recoveryCode: recoveryCodes[0]!.toUpperCase() })).statusCode).toBe(200);
    const third = (await login()).json().mfaToken;
    expect((await secondStep(third, { recoveryCode: recoveryCodes[0] })).statusCode).toBe(401);
  });

  it("stops guessing after five wrong codes", async () => {
    const admin = await setup();
    await turnOn(admin);
    const { mfaToken } = (await login()).json();
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push((await secondStep(mfaToken, { code: "000000" })).json().code);
    expect(answers).toEqual(["invalid_code", "invalid_code", "invalid_code", "invalid_code", "mfa_expired", "mfa_expired"]);
  });

  it("can be required for a whole workspace", async () => {
    const admin = await setup();
    await call(admin, "POST", "/api/users", { email: "op@acme.example", name: "Op", role: "operator", password: PASSWORD });
    // An admin without it would lock themselves out, so they turn it on first.
    expect((await call(admin, "PUT", "/api/workspace/security", { requireMfa: true })).statusCode).toBe(409);
    await turnOn(admin);
    expect((await call(admin, "PUT", "/api/workspace/security", { requireMfa: true })).json()).toEqual({ requireMfa: true });

    // Without two-step sign-in, the operator can only set it up.
    const op = { cookie: cookieOf(await login("op@acme.example")), "x-zamtech-client": "test" };
    expect((await call(op, "GET", "/api/auth/me")).json().restriction).toBe("mfa_setup_required");
    const blocked = await call(op, "GET", "/api/jobs");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("mfa_setup_required");
    await turnOn(op);
    expect((await call(op, "GET", "/api/jobs")).statusCode).toBe(200);
    expect((await call(op, "POST", "/api/auth/mfa/disable", { password: PASSWORD })).statusCode).toBe(409);

    // An admin resets it for a lost phone: signed out, and set up again at next sign-in.
    const operator = (await call(admin, "GET", "/api/users")).json().find((u: { email: string }) => u.email === "op@acme.example");
    expect((await call(admin, "POST", `/api/users/${operator.id}/mfa/reset`)).json().mfaEnabled).toBe(false);
    expect((await call(op, "GET", "/api/auth/me")).statusCode).toBe(401);
    // Operators cannot change the policy.
    const op2 = { cookie: cookieOf(await login("op@acme.example")), "x-zamtech-client": "test" };
    expect((await call(op2, "PUT", "/api/workspace/security", { requireMfa: false })).statusCode).toBe(403);
  });

  it("is switched off with the password when the workspace allows it", async () => {
    const admin = await setup();
    await turnOn(admin);
    expect((await call(admin, "POST", "/api/auth/mfa/disable", { password: "wrong password!" })).statusCode).toBe(400);
    expect((await call(admin, "POST", "/api/auth/mfa/disable", { password: PASSWORD })).statusCode).toBe(200);
    expect((await login()).json().mfaRequired).toBeUndefined();
  });
});
