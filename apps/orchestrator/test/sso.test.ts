import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await app?.close();
  while (cleanups.length) await cleanups.pop()!();
});

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const CLIENT = { id: "zamtech-portal", secret: "idp-client-secret" };

/**
 * A small OpenID Connect provider (like Entra ID or Okta): discovery, keys,
 * and a token endpoint that checks the client secret and PKCE and signs ID tokens.
 */
async function fakeIdp(options: { signWithOtherKey?: boolean } = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "key-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { claims: Record<string, unknown>; nonce: string; challenge: string; redirectUri: string }>();
  let issuer = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const form = new URLSearchParams(raw);
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!entry || form.get("client_id") !== CLIENT.id || form.get("client_secret") !== CLIENT.secret) return json(400, { error: "invalid_grant" });
        if (form.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri" });
        const verifier = form.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE" });
        const idToken = await new SignJWT({ nonce: entry.nonce, ...entry.claims })
          .setProtectedHeader({ alg: "RS256", kid: "key-1" })
          .setIssuer(issuer)
          .setAudience(CLIENT.id)
          .setSubject(String(entry.claims.email))
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(options.signWithOtherKey ? other.privateKey : privateKey);
        json(200, { id_token: idToken, access_token: "not-used", token_type: "Bearer" });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise((r) => server.close(() => r())));
  return {
    issuer,
    /** The person signs in at the provider: it redirects back with a code for these claims. */
    approve(authorizeUrl: string, claims: Record<string, unknown>) {
      const params = new URL(authorizeUrl).searchParams;
      const code = randomBytes(16).toString("hex");
      codes.set(code, { claims, nonce: params.get("nonce")!, challenge: params.get("code_challenge")!, redirectUri: params.get("redirect_uri")! });
      return `/api/auth/sso/callback?code=${code}&state=${encodeURIComponent(params.get("state")!)}`;
    },
  };
}

const cookieOf = (res: LightMyRequestResponse) => String(res.headers["set-cookie"]).split(";")[0]!;
const call = (headers: Record<string, string>, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
  app.inject({ method, url, headers, payload: payload as object });

async function setup() {
  const config = {
    ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_ALLOW_SIGNUP: "true", ZAMTEST_PORTAL_URL: "https://portal.acme-test.example", ZAMTEST_DESIGNER_URL: "https://designer.acme-test.example" }),
    dataDir: null,
  };
  ({ app } = await buildApp({ config, store: new Store(null), ai: null }));
  const signup = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Acme", name: "Ada", email: "ada@acme.example", password: PASSWORD } });
  const admin = { cookie: cookieOf(signup), "x-zamtech-client": "test" };
  const workspaceId: string = (await call(admin, "GET", "/api/workspace")).json().id;
  return { admin, workspaceId };
}

async function enterpriseWithSso(extra: Record<string, unknown> = {}, idpOptions = {}) {
  const { admin, workspaceId } = await setup();
  const idp = await fakeIdp(idpOptions);
  await app.inject({ method: "PUT", url: `/api/platform/workspaces/${workspaceId}`, headers: master, payload: { plan: "enterprise", ssoDomains: ["acme.example"] } });
  const saved = await call(admin, "PUT", "/api/workspace/sso", {
    enabled: true,
    issuer: idp.issuer,
    clientId: CLIENT.id,
    clientSecret: CLIENT.secret,
    defaultRole: "operator",
    autoProvision: true,
    ...extra,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  return { admin, workspaceId, idp };
}

/** Portal: email typed -> company sign-in -> provider -> back. Returns the final redirect. */
async function signInWithCompany(idp: Awaited<ReturnType<typeof fakeIdp>>, email: string, claims: Record<string, unknown> = { email, name: "Bob Builder" }) {
  const discover = (await app.inject({ method: "POST", url: "/api/auth/sso/discover", payload: { email, return: "https://designer.acme-test.example/#/w" } })).json();
  expect(discover).toMatchObject({ sso: true });
  const start = await app.inject({ method: "GET", url: discover.startUrl });
  expect(start.statusCode).toBe(302);
  const authorizeUrl = String(start.headers.location);
  expect(authorizeUrl.startsWith(`${idp.issuer}/authorize?`)).toBe(true);
  const params = new URL(authorizeUrl).searchParams;
  expect(params.get("redirect_uri")).toBe("https://portal.acme-test.example/api/auth/sso/callback");
  expect(params.get("code_challenge_method")).toBe("S256");
  expect(params.get("login_hint")).toBe(email.toLowerCase());
  const callbackUrl = idp.approve(authorizeUrl, claims);
  const back = await app.inject({ method: "GET", url: callbackUrl });
  return { back, callbackUrl };
}

describe("company sign-in (SSO)", () => {
  it("signs people of the company's domain in through their identity provider, creating their account", async () => {
    const { admin, idp } = await enterpriseWithSso();
    const settings = (await call(admin, "GET", "/api/workspace/sso")).json();
    expect(settings).toMatchObject({ available: true, domains: ["acme.example"], redirectUri: "https://portal.acme-test.example/api/auth/sso/callback", settings: { enabled: true, secretSet: true } });
    expect(JSON.stringify(settings)).not.toContain(CLIENT.secret);

    const { back, callbackUrl } = await signInWithCompany(idp, "Bob@Acme.example");
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe("https://designer.acme-test.example/#/w");
    const bob = { cookie: cookieOf(back), "x-zamtech-client": "test" };
    expect((await call(bob, "GET", "/api/auth/me")).json()).toMatchObject({ email: "bob@acme.example", name: "Bob Builder", role: "operator", kind: "user" });
    const users = (await call(admin, "GET", "/api/users")).json();
    expect(users.find((u: { email: string }) => u.email === "bob@acme.example")).toMatchObject({ authSource: "sso", emailVerified: true });

    // A sign-in response is used once.
    const replay = await app.inject({ method: "GET", url: callbackUrl });
    expect(String(replay.headers.location)).toContain("sso_error=");
    expect(replay.headers["set-cookie"]).toBeUndefined();
    // Others do not use SSO.
    expect((await app.inject({ method: "POST", url: "/api/auth/sso/discover", payload: { email: "someone@other.example" } })).json()).toEqual({ sso: false });
  });

  it("refuses tokens it cannot trust and addresses outside the company's domains", async () => {
    const forged = await enterpriseWithSso({}, { signWithOtherKey: true });
    const { back } = await signInWithCompany(forged.idp, "bob@acme.example");
    expect(decodeURIComponent(String(back.headers.location))).toMatch(/sso_error=.*not valid/);
    expect(back.headers["set-cookie"]).toBeUndefined();
    await app.close();

    const { idp } = await enterpriseWithSso();
    const outside = await signInWithCompany(idp, "bob@acme.example", { email: "eve@evil.example" });
    expect(decodeURIComponent(String(outside.back.headers.location))).toContain("not an address of this company's domains");
    const unverified = await signInWithCompany(idp, "bob@acme.example", { email: "bob@acme.example", email_verified: false });
    expect(decodeURIComponent(String(unverified.back.headers.location))).toContain("not verified");
  });

  it("can require company sign-in, and can refuse people who have no account yet", async () => {
    const { idp } = await enterpriseWithSso({ enforce: true, autoProvision: false });
    const password = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "ada@acme.example", password: PASSWORD } });
    expect(password.statusCode).toBe(403);
    expect(password.json().code).toBe("sso_required");
    const newcomer = await signInWithCompany(idp, "carol@acme.example");
    expect(decodeURIComponent(String(newcomer.back.headers.location))).toContain("do not have an account yet");
    // Ada already has an account: company sign-in works for her.
    const ada = await signInWithCompany(idp, "ada@acme.example");
    expect(ada.back.headers["set-cookie"]).toBeDefined();
  });

  it("is for Enterprise, with domains only the platform owner can assign", async () => {
    const { admin, workspaceId } = await setup();
    const payload = { enabled: false, issuer: "", clientId: "", defaultRole: "operator" };
    expect((await call(admin, "PUT", "/api/workspace/sso", payload)).statusCode).toBe(402);
    expect((await call(admin, "PUT", `/api/platform/workspaces/${workspaceId}`, { ssoDomains: ["acme.example"] })).statusCode).toBe(403);

    const platform = (body: unknown) => app.inject({ method: "PUT", url: `/api/platform/workspaces/${workspaceId}`, headers: master, payload: body as object });
    expect((await platform({ plan: "enterprise", ssoDomains: ["gmail.com"] })).statusCode).toBe(400);
    expect((await platform({ plan: "enterprise", ssoDomains: ["acme.example"] })).statusCode).toBe(200);
    // Without the identity provider details, it cannot be switched on.
    expect((await call(admin, "PUT", "/api/workspace/sso", { ...payload, enabled: true })).statusCode).toBe(400);

    const other = await app.inject({ method: "POST", url: "/api/auth/signup", payload: { company: "Other", name: "O", email: "o@other.example", password: PASSWORD } });
    const otherId = (await call({ cookie: cookieOf(other), "x-zamtech-client": "t" }, "GET", "/api/workspace")).json().id;
    const taken = await app.inject({ method: "PUT", url: `/api/platform/workspaces/${otherId}`, headers: master, payload: { ssoDomains: ["acme.example"] } });
    expect(taken.statusCode).toBe(409);
  });
});
