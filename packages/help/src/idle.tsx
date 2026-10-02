import { useEffect, useRef, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";

/**
 * Signing out after inactivity, on the browser's side. "Active" means the
 * person used the mouse, keyboard or touch screen, not the app refreshing by
 * itself. Every request tells the server how long the person has been idle
 * (idleSeconds), and the server signs out; this warns a minute before.
 */
let lastInput = Date.now();
const mark = () => {
  lastInput = Date.now();
};
if (typeof window !== "undefined") {
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"]) {
    window.addEventListener(type, mark, { passive: true, capture: true });
  }
}

/** Seconds since the person last used this tab (sent with every request). */
export const idleSeconds = () => Math.max(0, Math.floor((Date.now() - lastInput) / 1000));

/** The warning comes a minute before signing out; with short limits, a quarter of the limit (15 s of 1 minute). */
const warnSeconds = (limit: number) => Math.min(60, Math.max(10, Math.floor(limit / 4)));
/** Unsaved work is saved this long before signing out (the session must still be valid). */
const SAVE_SECONDS = 4;

/** What to do just before signing out for inactivity, e.g. save the workflow being edited. */
const beforeSignOut = new Set<() => unknown>();
/** Registers something to do just before signing out for inactivity; returns how to unregister it. */
export function onIdleSignOut(fn: () => unknown): () => void {
  beforeSignOut.add(fn);
  return () => beforeSignOut.delete(fn);
}

/**
 * Warns before signing out for inactivity and, when the time is up, asks the
 * server (which signs out, and the app shows the sign-in page with the reason).
 * `check` asks the server who is signed in: it answers how long the session has
 * been idle across all tabs (the person may be working in another one).
 */
export function IdleGuard({ minutes, check }: { minutes?: number; check: () => Promise<{ idleSeconds?: number } | undefined> }) {
  const { t } = useI18n();
  const [left, setLeft] = useState<number>();
  const asking = useRef(false);
  const saved = useRef(false);

  useEffect(() => {
    if (!minutes) return;
    const limit = minutes * 60;
    const warn = warnSeconds(limit);
    const tick = async () => {
      const idle = idleSeconds();
      if (idle < limit - warn) {
        setLeft(undefined);
        saved.current = false;
        return;
      }
      if (asking.current) return;
      asking.current = true;
      try {
        // Used meanwhile in another tab? Then that counts here too.
        const me = await check().catch(() => undefined);
        // Seconds are rounded on both sides: only a clear difference is activity elsewhere (else the
        // countdown would creep forward with every check).
        if (me?.idleSeconds !== undefined && me.idleSeconds + 2 < idle) lastInput = Date.now() - me.idleSeconds * 1000;
      } finally {
        asking.current = false;
      }
      const remaining = limit - idleSeconds();
      setLeft(remaining > warn ? undefined : Math.max(0, remaining));
      if (remaining <= SAVE_SECONDS && !saved.current) {
        saved.current = true;
        for (const fn of beforeSignOut) {
          try {
            await fn();
          } catch {
            /* signing out goes ahead */
          }
        }
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    return () => clearInterval(timer);
  }, [minutes, check]);

  if (left === undefined) return null;
  return (
    <div className="idle-warning" role="alertdialog" aria-live="assertive">
      <span>{t("idle.warning", { seconds: left })}</span>
      <button
        className="idle-stay"
        onClick={() => {
          mark();
          setLeft(undefined);
          saved.current = false;
          void check();
        }}
      >
        {t("idle.stay")}
      </button>
    </div>
  );
}
