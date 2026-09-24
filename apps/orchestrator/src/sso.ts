/**
 * Company sign-in (single sign-on) with OpenID Connect: Microsoft Entra ID,
 * Okta, Google Workspace and other OIDC providers.
 *
 * Authorization-code flow with PKCE (S256), state and nonce. The ID token's
 * signature is checked against the provider's published keys (JWKS), and its
 * issuer, audience, expiry and nonce are verified.
 *
 * Issuer examples:
 *   Microsoft Entra ID  https://login.microsoftonline.com/<tenant id>/v2.0
 *   Okta                https://<your org>.okta.com   (or .../oauth2/default)
 *   Google Workspace    https://accounts.google.com
 */
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface SsoIdentity {
  email: string;
  name: string;
  subject: string;
}

export class SsoError extends Error {}

const CACHE_MS = 60 * 60 * 1000;

/** PKCE: the challenge sent with the sign-in request for a verifier kept on the server. */
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export class OidcClient {
  private discoveries = new Map<string, { at: number; doc: Discovery }>();
  private keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async discover(issuer: string): Promise<Discovery> {
    const key = issuer.replace(/\/+$/, "");
    const cached = this.discoveries.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.doc;
    let res: Response;
    try {
      res = await this.fetchImpl(`${key}/.well-known/openid-configuration`);
    } catch (err) {
      throw new SsoError(`Cannot reach the identity provider at ${key}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new SsoError(`The identity provider at ${key} did not answer its OpenID configuration (HTTP ${res.status}). Check the issuer.`);
    const doc = (await res.json()) as Partial<Discovery>;
    if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new SsoError(`${key} is not an OpenID Connect provider (its configuration is incomplete)`);
    }
    this.discoveries.set(key, { at: Date.now(), doc: doc as Discovery });
    return doc as Discovery;
  }

  async authorizationUrl(settings: OidcSettings, input: { redirectUri: string; state: string; nonce: string; codeVerifier: string; loginHint?: string }) {
    const doc = await this.discover(settings.issuer);
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: settings.clientId,
      redirect_uri: input.redirectUri,
      scope: "openid email profile",
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: "S256",
      ...(input.loginHint ? { login_hint: input.loginHint } : {}),
    }).toString();
    return url.toString();
  }

  /** Exchanges the code for tokens and returns the verified identity. */
  async signIn(settings: OidcSettings, input: { code: string; redirectUri: string; codeVerifier: string; nonce: string }): Promise<SsoIdentity> {
    const doc = await this.discover(settings.issuer);
    const res = await this.fetchImpl(doc.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
        code_verifier: input.codeVerifier,
      }).toString(),
    });
    const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !tokens.id_token) {
      throw new SsoError(`The identity provider refused the sign-in: ${tokens.error_description ?? tokens.error ?? `HTTP ${res.status}`}`);
    }
    let keys = this.keySets.get(doc.jwks_uri);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(doc.jwks_uri));
      this.keySets.set(doc.jwks_uri, keys);
    }
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(tokens.id_token, keys, { issuer: doc.issuer, audience: settings.clientId, clockTolerance: 60 }));
    } catch (err) {
      throw new SsoError(`The identity provider's token is not valid: ${(err as Error).message}`);
    }
    if (claims.nonce !== input.nonce) throw new SsoError("The sign-in response does not belong to this sign-in (nonce)");
    // Entra ID often sends the address as preferred_username (the UPN) rather than email.
    const email = String(claims.email ?? claims.preferred_username ?? claims.upn ?? "")
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new SsoError("The identity provider did not send an email address");
    if (claims.email_verified === false) throw new SsoError("The identity provider says this email address is not verified");
    return { email, name: String(claims.name ?? email.split("@")[0]), subject: String(claims.sub ?? "") };
  }
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
