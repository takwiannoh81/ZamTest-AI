import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { FORBIDDEN_EVENT, UNAUTHORIZED_EVENT } from "./api";
import { returnTarget } from "./links";

const BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * The one place people sign in (the Designer sends them here). Shows the
 * sign-in dialog whenever the orchestrator answers 401, and a short notice
 * when the signed-in user's role does not allow an action (403). People sign
 * in with email and password; the master access token remains available as an
 * emergency option. The server keeps the session in a cookie shared with the
 * Designer; after signing in, ?return=<Designer page> goes back there.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [needed, setNeeded] = useState(false);
  const [mode, setMode] = useState<"password" | "token">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setLocalToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  // Came from the Designer and already signed in: go straight back.
  useEffect(() => {
    const target = returnTarget();
    if (!target) return;
    void fetch(`${BASE}/api/auth/me`, { credentials: "include" }).then((res) => {
      if (res.ok) window.location.replace(target);
    });
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setNeeded(true);
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

  const finish = () => {
    const target = returnTarget();
    if (target) window.location.replace(target);
    else window.location.reload();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "password") {
        const res = await fetch(`${BASE}/api/auth/login`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (!res.ok) return setError(t("auth.invalidLogin"));
        finish();
      } else {
        const res = await fetch(`${BASE}/api/auth/token`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: token.trim() }),
        });
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (!res.ok) return setError(t("auth.invalid"));
        finish();
      }
    } catch {
      setError(t("auth.invalidLogin"));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === "password" ? email.trim() && password : token.trim();

  return (
    <>
      {children}
      {forbidden && (
        <div className="toast" role="alert" onClick={() => setForbidden(false)}>
          {t("auth.forbidden")}
        </div>
      )}
      {needed && (
        <div className="modal-backdrop auth-backdrop">
          <form className="modal auth-modal" onSubmit={(e) => void submit(e)}>
            <div className="modal-head">
              <h2>{t("auth.title")}</h2>
            </div>
            <div className="modal-body">
              <p className="muted">{mode === "password" ? t("auth.loginHelp") : t("auth.help")}</p>
              {mode === "password" ? (
                <>
                  <label className="field">
                    <span>{t("auth.email")}</span>
                    <input type="email" autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("auth.password")}</span>
                    <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>{t("auth.token")}</span>
                  <input type="password" autoFocus value={token} onChange={(e) => setLocalToken(e.target.value)} />
                </label>
              )}
              {error && <div className="error-banner">{error}</div>}
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  setMode(mode === "password" ? "token" : "password");
                  setError(undefined);
                }}
              >
                {mode === "password" ? t("auth.useToken") : t("auth.usePassword")}
              </button>
            </div>
            <div className="modal-foot">
              <button className="btn" type="submit" disabled={busy || !canSubmit}>
                {t("auth.submit")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
