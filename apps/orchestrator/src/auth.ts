import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Store } from "./store.js";
import { nowIso } from "./store.js";
import type { Principal, Role, Session, User } from "./types.js";
import { DEFAULT_WORKSPACE, ROLES } from "./types.js";

const scrypt = promisify(scryptCb) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 10;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// Used when the email is unknown, so failed logins take the same time either way.
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(KEY_LENGTH).toString("base64")}`;

export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const [scheme, saltB64, hashB64] = (stored ?? DUMMY_HASH).split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length);
  return timingSafeEqual(actual, expected) && stored !== undefined;
}

/** SHA-256 of a secret, the form in which sessions, agent credentials and install keys are stored. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const tokenId = hashToken;

export const newSecret = () => randomBytes(32).toString("base64url");

/** Session owner for a sign-in with the master access token (ZAMTEST_ADMIN_TOKEN). */
export const MASTER_SESSION = "__master__";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
/** A short code people can read and compare, e.g. "KDTR-7QMX". */
export function newUserCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Signs a user in. One sign-in per user: the user's other sessions (another
 * browser or PC) end, and are remembered for a day so that device can say why.
 */
export function createSession(store: Store, user: User | typeof MASTER_SESSION): string {
  if (user !== MASTER_SESSION) {
    for (const s of Object.values(store.data.sessions)) {
      if (s.userId !== user.id) continue;
      delete store.data.sessions[s.id];
      store.data.endedSessions[s.id] = { at: nowIso(), reason: "signed_in_elsewhere" };
    }
  }
  const token = newSecret();
  const session: Session = {
    id: tokenId(token),
    userId: user === MASTER_SESSION ? MASTER_SESSION : user.id,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  };
  store.data.sessions[session.id] = session;
  store.save();
  return token;
}

export function deleteSession(store: Store, token: string): void {
  delete store.data.sessions[tokenId(token)];
  store.save();
}

export function deleteUserSessions(store: Store, userId: string, exceptToken?: string): void {
  const keep = exceptToken ? tokenId(exceptToken) : undefined;
  for (const s of Object.values(store.data.sessions)) {
    if (s.userId === userId && s.id !== keep) delete store.data.sessions[s.id];
  }
  store.save();
}

/** Why a session token no longer works, if it was ended by a sign-in elsewhere. */
export function endedReason(store: Store, token: string | undefined): "signed_in_elsewhere" | undefined {
  return token ? store.data.endedSessions[tokenId(token)]?.reason : undefined;
}

export function pruneSessions(store: Store, now = Date.now()): void {
  for (const [id, ended] of Object.entries(store.data.endedSessions)) {
    if (now - Date.parse(ended.at) > 24 * 60 * 60 * 1000) delete store.data.endedSessions[id];
  }
  for (const s of Object.values(store.data.sessions)) {
    if (Date.parse(s.expiresAt) < now) delete store.data.sessions[s.id];
  }
}

/** A user as the API shows it: never the password hash or two-step secrets. */
export function publicUser(user: User) {
  const { passwordHash: _hash, mfa, ...rest } = user;
  return { ...rest, mfaEnabled: Boolean(mfa?.enabled) };
}

/** A platform owner: flagged, and still an active admin of the default workspace. */
export const isPlatformOwner = (user: User) => Boolean(user.platformOwner && user.workspaceId === DEFAULT_WORKSPACE && user.role === "admin" && !user.disabled);

/** The master access token administers the platform owner's own (default) workspace. */
const MASTER_PRINCIPAL: Principal = { id: "token", name: "Access token", email: "", role: "admin", kind: "token", workspaceId: DEFAULT_WORKSPACE };

/**
 * Resolves the caller from the Authorization header or, for the Portal and
 * Designer, the sign-in cookie.
 * - the master access token (ZAMTEST_ADMIN_TOKEN) acts as an administrator;
 * - a session token belongs to a user account (or to a master-token sign-in);
 * - with no token configured and no accounts yet (local development), requests are open.
 */
export function resolvePrincipal(
  store: Store,
  adminToken: string | undefined,
  authorization: string | undefined,
  cookieToken?: string,
): Principal | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (bearer && adminToken && safeEqual(bearer, adminToken)) return MASTER_PRINCIPAL;
  const token = bearer || cookieToken;
  if (token) {
    const session = store.data.sessions[tokenId(token)];
    if (session && Date.parse(session.expiresAt) > Date.now()) {
      if (session.userId === MASTER_SESSION) return adminToken ? MASTER_PRINCIPAL : null;
      const user = store.data.users[session.userId];
      if (user && !user.disabled) {
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          kind: "user",
          workspaceId: user.workspaceId,
          platformOwner: isPlatformOwner(user),
          // Platform owners always need two-step sign-in; others when their workspace asks for it.
          restriction:
            user.emailVerified === false
              ? "email_unverified"
              : !user.mfa?.enabled && user.authSource !== "sso" && (isPlatformOwner(user) || store.data.workspaces[user.workspaceId]?.security?.requireMfa)
                ? "mfa_setup_required"
                : undefined,
        };
      }
    }
  }
  if (!adminToken && Object.keys(store.data.users).length === 0) {
    return { id: "open", name: "Local developer", email: "", role: "admin", kind: "open", workspaceId: DEFAULT_WORKSPACE };
  }
  return null;
}

/* ----------------------------- sign-in cookie ----------------------------- */

/** One HttpOnly cookie carries the session for the Portal and the Designer. */
export const SESSION_COOKIE = "zt_session";

export interface CookieOptions {
  /** e.g. ".zamtechai.com": shared by portal.zamtechai.com and designer.zamtechai.com. */
  domain?: string;
  secure: boolean;
}

export function sessionCookie(token: string, options: CookieOptions): string {
  return cookie(token, Math.floor(SESSION_TTL_MS / 1000), options);
}

export function clearedSessionCookie(options: CookieOptions): string {
  return cookie("", 0, options);
}

function cookie(value: string, maxAge: number, { domain, secure }: CookieOptions): string {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", `Max-Age=${maxAge}`, "HttpOnly", "SameSite=Lax"];
  if (domain) parts.push(`Domain=${domain}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
  }
  return undefined;
}

export function hasRole(principal: Principal, needed: Role): boolean {
  return ROLES.indexOf(principal.role) >= ROLES.indexOf(needed);
}

/**
 * Minimum role for each API call. Reading is open to every signed-in user;
 * running things needs Operator; building and configuring needs Developer;
 * users, backups and removing agents need Admin.
 */
export function requiredRole(method: string, path: string): Role {
  if (path.startsWith("/api/users") || path.startsWith("/api/admin/") || path.startsWith("/api/billing/") || path.startsWith("/api/platform/") || path.startsWith("/api/api-tokens")) return "admin";
  if (method === "GET" || method === "HEAD") return "viewer";
  if (method === "POST" && path === "/api/help/chat") return "viewer"; // help is for everyone
  if (path === "/api/auth/me/preferences") return "viewer"; // everyone's own email choices
  if (method === "DELETE" && path.startsWith("/api/agents/")) return "admin";
  if (method === "POST" && path === "/api/jobs") return "operator"; // ad-hoc definitions need developer (checked in the route)
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/(cancel|rerun)$/.test(path)) return "operator"; // rerunning a test run needs developer (checked in the route)
  if (method === "POST" && /^\/api\/schedules\/[^/]+\/run$/.test(path)) return "operator";
  if (method === "POST" && /^\/api\/queues\/[^/]+\/items$/.test(path)) return "operator";
  if (method === "POST" && /^\/api\/queue-items\/[^/]+\/retry$/.test(path)) return "operator";
  return "developer";
}

/** Simple in-memory limiter for sign-in attempts (per IP and per email). */
export class LoginLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 5 * 60 * 1000,
  ) {}

  blocked(...keys: string[]): boolean {
    const now = Date.now();
    return keys.some((k) => {
      const a = this.attempts.get(k);
      return a !== undefined && a.resetAt > now && a.count >= this.max;
    });
  }

  fail(...keys: string[]): void {
    const now = Date.now();
    for (const k of keys) {
      const a = this.attempts.get(k);
      if (!a || a.resetAt <= now) this.attempts.set(k, { count: 1, resetAt: now + this.windowMs });
      else a.count++;
    }
    if (this.attempts.size > 10_000) this.attempts.clear();
  }

  reset(...keys: string[]): void {
    for (const k of keys) this.attempts.delete(k);
  }
}
