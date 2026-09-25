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

/** The warning comes this long before signing out. */
const WARN_SECONDS = 60;

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

  useEffect(() => {
    if (!minutes) return;
    const limit = minutes * 60;
    const tick = async () => {
      const idle = idleSeconds();
      if (idle < limit - WARN_SECONDS) {
        setLeft(undefined);
        return;
      }
      if (asking.current) return;
      asking.current = true;
      try {
        // Used meanwhile in another tab? Then that counts here too.
        const me = await check().catch(() => undefined);
        if (me?.idleSeconds !== undefined && me.idleSeconds < idle) lastInput = Date.now() - me.idleSeconds * 1000;
      } finally {
        asking.current = false;
      }
      const remaining = limit - idleSeconds();
      setLeft(remaining > WARN_SECONDS ? undefined : Math.max(0, remaining));
    };
    const timer = setInterval(() => void tick(), 5000);
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
          void check();
        }}
      >
        {t("idle.stay")}
      </button>
    </div>
  );
}
