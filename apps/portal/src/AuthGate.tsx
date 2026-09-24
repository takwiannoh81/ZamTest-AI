import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { FORBIDDEN_EVENT, LIMIT_EVENT, UNAUTHORIZED_EVENT } from "./api";
import { returnTarget } from "./links";

const BASE = import.meta.env.VITE_API_URL ?? "";

type Mode = "password" | "token" | "signup";

/**
 * The one place people sign in (the Designer sends them here) and, when the
 * server allows it, create an account and with it their company's workspace.
 * Shows the sign-in dialog whenever the orchestrator answers 401, a notice when
 * the user's role does not allow an action (403), and an upgrade prompt when
 * the workspace's plan does not (402). The master access token remains
 * available as an emergency option. The server keeps the session in a cookie
 * shared with the Designer; after signing in, ?return=<Designer page> goes
 * back there. ?signup=1 (the website's "Get started") opens account creation.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const wantsSignup = new URLSearchParams(window.location.search).has("signup");
  const [needed, setNeeded] = useState(false);
  const [mode, setMode] = useState<Mode>("password");
  const [signupOpen, setSignupOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [token, setLocalToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; upgrade: boolean }>();

  // Whether this server lets people create accounts (the hosted service does).
  useEffect(() => {
    void fetch(`${BASE}/api/auth/config`)
      .then((res) => (res.ok ? (res.json() as Promise<{ signup: boolean }>) : { signup: false }))
      .then((cfg) => {
        setSignupOpen(cfg.signup);
        if (cfg.signup && wantsSignup) {
          setMode("signup");
          setNeeded(true);
        }
      })
      .catch(() => undefined);
  }, [wantsSignup]);

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
    const show = (text: string, upgrade: boolean) => {
      setNotice({ text, upgrade });
      clearTimeout(timer);
      timer = setTimeout(() => setNotice(undefined), 8000);
    };
    const onForbidden = () => show(t("auth.forbidden"), false);
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

  const finish = () => {
    const target = returnTarget();
    if (target) window.location.replace(target);
    else {
      // Drop ?signup=1 so a reload does not show the form again.
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      window.location.reload();
    }
  };

  const post = (path: string, body: unknown) =>
    fetch(`${BASE}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "password") {
        const res = await post("/api/auth/login", { email: email.trim(), password });
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (!res.ok) return setError(t("auth.invalidLogin"));
      } else if (mode === "token") {
        const res = await post("/api/auth/token", { token: token.trim() });
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (!res.ok) return setError(t("auth.invalid"));
      } else {
        const res = await post("/api/auth/signup", { company: company.trim(), name: name.trim(), email: email.trim(), password });
        if (!res.ok) return setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? t("auth.invalidLogin"));
      }
      finish();
    } catch {
      setError(t("auth.invalidLogin"));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(undefined);
  };

  const canSubmit =
    mode === "password" ? email.trim() && password : mode === "token" ? token.trim() : company.trim() && name.trim() && email.trim() && password.length >= 10;

  return (
    <>
      {children}
      {notice && (
        <div className="toast" role="alert" onClick={() => setNotice(undefined)}>
          {notice.text}
          {notice.upgrade && (
            <a className="toast-link" href="#/billing">
              {t("billing.viewPlans")}
            </a>
          )}
        </div>
      )}
      {needed && (
        <div className="modal-backdrop auth-backdrop">
          <form className="modal auth-modal" onSubmit={(e) => void submit(e)}>
            <div className="modal-head">
              <h2>{mode === "signup" ? t("auth.signupTitle") : t("auth.title")}</h2>
            </div>
            <div className="modal-body">
              <p className="muted">{mode === "password" ? t("auth.loginHelp") : mode === "token" ? t("auth.help") : t("auth.signupHelp")}</p>
              {mode === "signup" && (
                <>
                  <label className="field">
                    <span>{t("auth.company")}</span>
                    <input autoFocus autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("auth.yourName")}</span>
                    <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
                  </label>
                </>
              )}
              {mode !== "token" ? (
                <>
                  <label className="field">
                    <span>{t("auth.email")}</span>
                    <input type="email" autoFocus={mode === "password"} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>{t("auth.password")}</span>
                    <input
                      type="password"
                      autoComplete={mode === "signup" ? "new-password" : "current-password"}
                      minLength={mode === "signup" ? 10 : undefined}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>{t("auth.token")}</span>
                  <input type="password" autoFocus value={token} onChange={(e) => setLocalToken(e.target.value)} />
                </label>
              )}
              {error && <div className="error-banner">{error}</div>}
              <div className="auth-links">
                {mode === "password" && signupOpen && (
                  <button type="button" className="link-btn" onClick={() => switchTo("signup")}>
                    {t("auth.createAccount")}
                  </button>
                )}
                {mode === "signup" && (
                  <button type="button" className="link-btn" onClick={() => switchTo("password")}>
                    {t("auth.haveAccount")}
                  </button>
                )}
                {mode !== "signup" && (
                  <button type="button" className="link-btn" onClick={() => switchTo(mode === "password" ? "token" : "password")}>
                    {mode === "password" ? t("auth.useToken") : t("auth.usePassword")}
                  </button>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" type="submit" disabled={busy || !canSubmit}>
                {mode === "signup" ? t("auth.signupSubmit") : t("auth.submit")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
