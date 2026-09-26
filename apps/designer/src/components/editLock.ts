import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { EditLock } from "../api";

/** How often the lock is renewed (the server frees it after 90 seconds without). */
const RENEW_MS = 30_000;

export type LockState =
  /** Not known yet, or not taken (people who cannot edit). */
  | { state: "none" }
  /** This window edits it. */
  | { state: "mine" }
  /** Someone else edits it: read-only here, until they close it. */
  | { state: "other"; lock: EditLock }
  /** Someone took over from this window: read-only here, and it stays so. */
  | { state: "lost"; lock: EditLock };

export const EDIT_SESSION_HEADER = "x-zamtech-edit-session";

/**
 * The edit lock of the workflow or test case at `endpoint`, while it is open.
 * `onRegained` is called when this window gets the lock after someone else had it,
 * so it can load the version they saved before editing.
 */
export function useEditLock(endpoint: string, enabled: boolean, onRegained: () => void) {
  const session = useMemo(() => crypto.randomUUID(), []);
  const [lock, setLock] = useState<LockState>({ state: "none" });
  const current = useRef(lock);
  current.current = lock;
  const regained = useRef(onRegained);
  regained.current = onRegained;

  const take = useCallback(
    async (takeOver = false) => {
      const before = current.current.state;
      try {
        await api(`${endpoint}/lock`, { method: "POST", body: { session, takeOver } });
        if (before === "other") regained.current();
        setLock({ state: "mine" });
      } catch (e) {
        if (!(e instanceof ApiError) || e.data.code !== "locked") return; // offline: try again at the next renewal
        const holder = e.data.lock as EditLock;
        setLock(before === "mine" || before === "lost" ? { state: "lost", lock: holder } : { state: "other", lock: holder });
      }
    },
    [endpoint, session],
  );

  useEffect(() => {
    if (!enabled) return;
    void take();
    const timer = setInterval(() => {
      if (current.current.state !== "lost") void take();
    }, RENEW_MS);
    const release = () => {
      if (current.current.state === "mine") void api(`${endpoint}/unlock`, { method: "POST", body: { session }, keepalive: true }).catch(() => undefined);
    };
    // Closing the tab (not just asking whether to leave).
    window.addEventListener("pagehide", release);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [enabled, endpoint, session, take]);

  return {
    lock,
    /** Sent with saves, so the server knows this window holds the lock. */
    headers: { [EDIT_SESSION_HEADER]: session },
    takeOver: () => take(true),
    /** The server said someone else holds it (e.g. on a save). */
    lost: (holder: EditLock) => setLock({ state: "lost", lock: holder }),
  };
}
