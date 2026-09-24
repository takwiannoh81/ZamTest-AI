import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { FORBIDDEN_EVENT, UNAUTHORIZED_EVENT } from "../api";

/** People sign in only in the Portal; the session cookie is shared with the Designer. */
export const PORTAL_URL = (import.meta.env.VITE_PORTAL_URL ?? "http://localhost:5173").replace(/\/+$/, "");

/** The Portal's sign-in, coming back to this page afterwards. */
export function portalSignInUrl(): string {
  return `${PORTAL_URL}/?return=${encodeURIComponent(window.location.href)}`;
}

/**
 * Sends people to the Portal to sign in whenever the orchestrator answers 401,
 * and shows a short notice when their role does not allow an action (403).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => window.location.assign(portalSignInUrl());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onForbidden = () => {
      setForbidden(true);
      clearTimeout(timer);
      timer = setTimeout(() => setForbidden(false), 6000);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener(FORBIDDEN_EVENT, onForbidden);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener(FORBIDDEN_EVENT, onForbidden);
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {children}
      {forbidden && (
        <div className="toast" role="alert" onClick={() => setForbidden(false)}>
          {t("auth.forbidden")}
        </div>
      )}
    </>
  );
}
