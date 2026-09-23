import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Store } from "./store.js";
import { nowIso } from "./store.js";
import type { Principal, Role, Session, User } from "./types.js";
import { ROLES } from "./types.js";

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

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex");

export function createSession(store: Store, user: User): string {
  const token = randomBytes(32).toString("base64url");
  const session: Session = {
    id: tokenId(token),
    userId: user.id,
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

export function pruneSessions(store: Store, now = Date.now()): void {
  for (const s of Object.values(store.data.sessions)) {
    if (Date.parse(s.expiresAt) < now) delete store.data.sessions[s.id];
  }
}

export function publicUser(user: User) {
  const { passwordHash: _hash, ...rest } = user;
  return rest;
}

/**
 * Resolves the caller from the Authorization header.
 * - the master access token (ZAMTEST_ADMIN_TOKEN) acts as an administrator;
 * - a session token belongs to a user account;
 * - with no token configured and no accounts yet (local development), requests are open.
 */
export function resolvePrincipal(store: Store, adminToken: string | undefined, authorization: string | undefined): Principal | null {
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (bearer && adminToken && safeEqual(bearer, adminToken)) {
    return { id: "token", name: "Access token", email: "", role: "admin", kind: "token" };
  }
  if (bearer) {
    const session = store.data.sessions[tokenId(bearer)];
    if (session && Date.parse(session.expiresAt) > Date.now()) {
      const user = store.data.users[session.userId];
      if (user && !user.disabled) return { id: user.id, name: user.name, email: user.email, role: user.role, kind: "user" };
    }
  }
  if (!adminToken && Object.keys(store.data.users).length === 0) {
    return { id: "open", name: "Local developer", email: "", role: "admin", kind: "open" };
  }
  return null;
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
  if (path.startsWith("/api/users") || path.startsWith("/api/admin/")) return "admin";
  if (method === "GET" || method === "HEAD") return "viewer";
  if (method === "DELETE" && path.startsWith("/api/agents/")) return "admin";
  if (method === "POST" && path === "/api/jobs") return "operator"; // ad-hoc definitions need developer (checked in the route)
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/cancel$/.test(path)) return "operator";
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
