import { IdleGuard, WhatsNew } from "@zamtest/help";
import { useMe } from "./session";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { api, FORBIDDEN_EVENT, LIMIT_EVENT, UNAUTHORIZED_EVENT } from "../api";

/** People sign in only in the Portal; the session cookie is shared with the Designer. */
export const PORTAL_URL = (import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173").replace(/\/+$/, "");

/** The Portal's sign-in, coming back to this page afterwards. */
/** Why the person was signed out, for the sign-in page: elsewhere (signed in on another PC) or idle (inactivity). */
export function portalSignInUrl(reason?: "elsewhere" | "idle"): string {
  return `${PORTAL_URL}/?return=${encodeURIComponent(window.location.href)}${reason ? `&reason=${reason}` : ""}`;
}

/** How long the session has been idle, across tabs (for the inactivity warning). */
const whoAmI = () => api<{ idleSeconds?: number }>("/api/auth/me");

/**
 * Sends people to the Portal to sign in whenever the orchestrator answers 401,
 * and shows a short notice when their role does not allow an action (403).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [notice, setNotice] = useState<{ text: string; upgrade: boolean }>();
  const me = useMe();

  useEffect(() => {
    const onUnauthorized = (e: Event) => {
      const why = (e as CustomEvent<string | undefined>).detail;
      window.location.assign(portalSignInUrl(why === "signed_in_elsewhere" ? "elsewhere" : why === "signed_out_idle" ? "idle" : undefined));
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (text: string, upgrade: boolean) => {
      setNotice({ text, upgrade });
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(undefined), 8000);
    };
    const onForbidden = () => show(t("auth.forbidden"), false);
    // The plan does not allow it (e.g. this month's runs or AI requests are used up).
    const onLimit = (e: Event) => show((e as CustomEvent<string>).detail, true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    window.addEventListener(LIMIT_EVENT, onLimit);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
      window.removeEventListener(LIMIT_EVENT, onLimit);
      clearTimeout(timer);
    };
  }, [t]);

  return (
    <>
      {children}
      {me && me.kind !== "open" && <IdleGuard minutes={me.idleTimeoutMinutes} check={whoAmI} />}
      {me?.whatsNew && <WhatsNew api={api} docsHref={`${PORTAL_URL}/#/docs`} />}
      {notice && (
        <div className="toast" role="alert" onClick={() => setNotice(undefined)}>
          {notice.text}
          {notice.upgrade && (
            <a className="toast-link" href={`${PORTAL_URL}/#/billing`} target="_blank" rel="noreferrer">
              {t("billing.viewPlans")}
            </a>
          )}
        </div>
      )}
    </>
  );
}
