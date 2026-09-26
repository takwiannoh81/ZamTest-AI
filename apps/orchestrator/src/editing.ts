/**
 * Several people editing in one workspace: who has a workflow or test case open
 * in the Designer, and saves that would overwrite someone else's work.
 *
 * - Edit locks: the Designer takes the lock when it opens a workflow or test case,
 *   renews it while it stays open, and gives it back when it closes. Everyone else
 *   gets a read-only copy that says who is editing, and can take over (for example
 *   when someone left it open and went home). A lock that is not renewed expires.
 *   Locks are kept in memory: after a restart, the open Designers take them again.
 * - Conflicts: a save says which version it was based on (its `updatedAt`). When the
 *   workflow changed since (another person, a Git pull, a CI import), the save is
 *   refused so nothing is overwritten without the person choosing to.
 *
 * Headers: x-zamtech-edit-session (the Designer window's lock) and
 * x-zamtech-based-on (the version it was based on). A request without them (the
 * Portal, the API) is not checked for conflicts, but cannot change what is locked.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { HttpError, parse } from "./errors.js";
import type { Store } from "./store.js";
import type { Principal } from "./types.js";

/** A lock not renewed for this long is free again (the Designer renews it every 30 seconds). */
export const LOCK_TTL_MS = 90_000;

export const EDIT_SESSION_HEADER = "x-zamtech-edit-session";
export const BASED_ON_HEADER = "x-zamtech-based-on";

interface EditLock {
  /** The Designer window that holds it. */
  session: string;
  userId: string;
  name: string;
  since: string;
  expiresAt: number;
}

/** What others see of a lock. */
export interface LockView {
  name: string;
  since: string;
  /** The same person, in another window. */
  sameUser: boolean;
}

const Session = z.string().min(8).max(100);

export class EditLocks {
  private locks = new Map<string, EditLock>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The live lock on a workflow or test case (ids are unique across both). */
  get(id: string): EditLock | undefined {
    const lock = this.locks.get(id);
    if (lock && lock.expiresAt <= this.now()) {
      this.locks.delete(id);
      return undefined;
    }
    return lock;
  }

  /** Takes or renews the lock; taken over from someone else only when asked. */
  take(id: string, session: string, who: Principal, takeOver = false): { ok: true } | { ok: false; lock: EditLock } {
    const current = this.get(id);
    if (current && current.session !== session && !takeOver) return { ok: false, lock: current };
    const since = current?.session === session ? current.since : new Date(this.now()).toISOString();
    this.locks.set(id, { session, userId: who.id, name: who.name, since, expiresAt: this.now() + LOCK_TTL_MS });
    return { ok: true };
  }

  release(id: string, session: string): void {
    if (this.locks.get(id)?.session === session) this.locks.delete(id);
  }

  view(lock: EditLock, who: Principal): LockView {
    return { name: lock.name, since: lock.since, sameUser: lock.userId === who.id };
  }
}

export interface EditingContext {
  store: Store;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
}

export interface Editing {
  locks: EditLocks;
  /**
   * Before a workflow or test case is saved or deleted: refused when someone else
   * has it open, or (for a save from the Designer) when it changed since it was opened.
   */
  check(req: FastifyRequest, item: { id: string; updatedAt: string; updatedBy?: string }): void;
  /** Who is editing it now, for lists. */
  editing(req: FastifyRequest, id: string): LockView | undefined;
}

export function registerEditing(app: FastifyInstance, ctx: EditingContext, locks = new EditLocks()): Editing {
  const { store } = ctx;
  const header = (req: FastifyRequest, name: string) => {
    const value = req.headers[name];
    return typeof value === "string" && value ? value : undefined;
  };

  const check: Editing["check"] = (req, item) => {
    const who = ctx.me(req);
    const lock = locks.get(item.id);
    if (lock && lock.session !== header(req, EDIT_SESSION_HEADER)) {
      throw new HttpError(409, `${lock.name} is editing this in the Designer`, { code: "locked", lock: locks.view(lock, who) });
    }
    const basedOn = header(req, BASED_ON_HEADER);
    if (basedOn && basedOn !== item.updatedAt) {
      throw new HttpError(409, `${item.updatedBy ?? "Someone"} saved this after you opened it`, {
        code: "changed",
        updatedAt: item.updatedAt,
        updatedBy: item.updatedBy,
      });
    }
  };

  // Lock and unlock, for workflows and test cases alike.
  type Editable = { workspaceId: string; id: string; updatedAt: string };
  const kinds: Array<{ path: string; collection: () => Record<string, Editable>; what: string }> = [
    { path: "/api/workflows", collection: () => store.data.workflows, what: "Workflow" },
    { path: "/api/test-cases", collection: () => store.data.testCases, what: "Test case" },
  ];
  for (const kind of kinds) {
    app.post<{ Params: { id: string } }>(`${kind.path}/:id/lock`, async (req, reply) => {
      const item = ctx.own(kind.collection(), req.params.id, kind.what, req);
      const body = parse(z.object({ session: Session, takeOver: z.boolean().optional() }), req.body ?? {});
      const who = ctx.me(req);
      const result = locks.take(item.id, body.session, who, body.takeOver);
      if (!result.ok) {
        return reply.status(409).send({ error: `${result.lock.name} is editing this in the Designer`, code: "locked", lock: locks.view(result.lock, who) });
      }
      return { updatedAt: item.updatedAt };
    });
    app.post<{ Params: { id: string } }>(`${kind.path}/:id/unlock`, async (req, reply) => {
      ctx.own(kind.collection(), req.params.id, kind.what, req);
      const body = parse(z.object({ session: Session }), req.body ?? {});
      locks.release(req.params.id, body.session);
      return reply.status(204).send();
    });
  }

  return {
    locks,
    check,
    editing: (req, id) => {
      const lock = locks.get(id);
      return lock ? locks.view(lock, ctx.me(req)) : undefined;
    },
  };
}
