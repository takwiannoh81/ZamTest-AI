import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { BASE, FORBIDDEN_EVENT, LIMIT_EVENT, UNAUTHORIZED_EVENT } from "./api";
import { returnTarget } from "./links";

type Mode = "password" | "token" | "signup" | "forgot" | "mfa";

const post = (path: string, body: unknown) =>
  fetch(`${BASE}${path}`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * The one place people sign in (the Designer sends them here): with their
 * password (and a code from their authenticator app when two-step sign-in is
 * on), through their company's identity provider (SSO) when their email
 * domain uses it, or with the master access token in an emergency. Also
 * creates accounts (when the server allows sign-up) and sends password-reset
 * links. Shows the dialog whenever the orchestrator answers 401, a notice when
 * the role does not allow an action (403), and an upgrade prompt when the plan
 * does not (402). After signing in, ?return=<Designer page> goes back there.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const search = new URLSearchParams(window.location.search);
  const wantsSignup = search.has("signup");
  const [needed, setNeeded] = useState(false);
  const [mode, setMode] = useState<Mode>("password");
  const [signupOpen, setSignupOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [token, setLocalToken] = useState("");
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [sso, setSso] = useState<{ startUrl: string; enforced: boolean }>();
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; upgrade: boolean }>();

  // Whether this server lets people create accounts; and a company sign-in that came back with an error.
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
    // Sent here by the Designer after this account signed in somewhere else.
    if (search.get("reason") === "elsewhere") setInfo(t("auth.signedInElsewhere"));
    const ssoError = search.get("sso_error");
    if (ssoError) {
      setError(t("auth.ssoError", { message: ssoError }));
      setNeeded(true);
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }
  }, [wantsSignup]); // eslint-disable-line react-hooks/exhaustive-deps

  // Came from the Designer and already signed in: go straight back.
  useEffect(() => {
    const target = returnTarget();
    if (!target) return;
    void fetch(`${BASE}/api/auth/me`, { credentials: "include" }).then((res) => {
      if (res.ok) window.location.replace(target);
    });
  }, []);

  useEffect(() => {
    const onUnauthorized = (e: Event) => {
      if ((e as CustomEvent<string | undefined>).detail === "signed_in_elsewhere") setInfo(t("auth.signedInElsewhere"));
      setNeeded(true);
    };
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

  // Does this email's company sign people in itself? Asked shortly after the email is typed.
  useEffect(() => {
    setSso(undefined);
    if (mode !== "password" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return;
    const timer = setTimeout(() => {
      void post("/api/auth/sso/discover", { email: email.trim(), return: returnTarget() ?? `${window.location.origin}/` })
        .then((res) => (res.ok ? res.json() : { sso: false }))
        .then((r: { sso: boolean; startUrl?: string; enforced?: boolean }) => setSso(r.sso && r.startUrl ? { startUrl: r.startUrl, enforced: Boolean(r.enforced) } : undefined))
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [email, mode]);

  const goSso = () => {
    if (sso) window.location.assign(`${BASE}${sso.startUrl}`);
  };

  const finish = () => {
    const target = returnTarget();
    if (target) window.location.replace(target);
    else {
      // Drop ?signup=1 so a reload does not show the form again.
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
      window.location.reload();
    }
  };

  const switchTo = (next: Mode) => {
    setMode(next);
    setError(undefined);
    setInfo(undefined);
    setCode("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      if (mode === "password") {
        if (sso?.enforced) return goSso();
        const res = await post("/api/auth/login", { email: email.trim(), password });
        const data = (await res.json().catch(() => ({}))) as { code?: string; mfaRequired?: boolean; mfaToken?: string };
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (data.code === "sso_required") return setError(t("auth.ssoRequired"));
        if (!res.ok) return setError(t("auth.invalidLogin"));
        if (data.mfaRequired && data.mfaToken) {
          setMfaToken(data.mfaToken);
          return switchTo("mfa");
        }
      } else if (mode === "mfa") {
        const res = await post("/api/auth/login/mfa", useRecovery ? { mfaToken, recoveryCode: code.trim() } : { mfaToken, code: code.trim() });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { code?: string };
          if (data.code === "mfa_expired") {
            switchTo("password");
            return setError(t("auth.mfaExpired"));
          }
          return setError(t("auth.invalidCode"));
        }
      } else if (mode === "token") {
        const res = await post("/api/auth/token", { token: token.trim() });
        if (res.status === 429) return setError(t("auth.tooMany"));
        if (!res.ok) return setError(t("auth.invalid"));
      } else if (mode === "forgot") {
        const res = await post("/api/auth/password-reset/request", { email: email.trim() });
        if (res.status === 429) return setError(t("auth.tooMany"));
        return setInfo(t("auth.linkSent"));
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

  const titles: Record<Mode, string> = {
    password: t("auth.title"),
    token: t("auth.title"),
    signup: t("auth.signupTitle"),
    forgot: t("auth.forgotTitle"),
    mfa: t("auth.mfaTitle"),
  };
  const helps: Record<Mode, string> = {
    password: t("auth.loginHelp"),
    token: t("auth.help"),
    signup: t("auth.signupHelp"),
    forgot: t("auth.forgotHelp"),
    mfa: t("auth.mfaHelp"),
  };
  const canSubmit =
    mode === "password"
      ? email.trim() && (password || sso?.enforced)
      : mode === "token"
        ? token.trim()
        : mode === "forgot"
          ? email.trim()
          : mode === "mfa"
            ? code.trim().length >= 6
            : company.trim() && name.trim() && email.trim() && password.length >= 10;
  const submitLabel =
    mode === "signup" ? t("auth.signupSubmit") : mode === "forgot" ? t("auth.sendLink") : mode === "password" && sso?.enforced ? t("auth.ssoContinue") : t("auth.submit");

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
              <h2>{titles[mode]}</h2>
            </div>
            <div className="modal-body">
              <p className="muted">{helps[mode]}</p>
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
              {(mode === "password" || mode === "signup" || mode === "forgot") && (
                <label className="field">
                  <span>{t("auth.email")}</span>
                  <input type="email" autoFocus={mode !== "signup"} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
              )}
              {mode === "password" && sso && (
                <div className="sso-box">
                  <p className="muted">{sso.enforced ? t("auth.ssoRequired") : t("auth.ssoHint")}</p>
                  {!sso.enforced && (
                    <button type="button" className="btn-ghost" onClick={goSso}>
                      {t("auth.ssoContinue")}
                    </button>
                  )}
                </div>
              )}
              {(mode === "signup" || (mode === "password" && !sso?.enforced)) && (
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
              )}
              {mode === "mfa" && (
                <label className="field">
                  <span>{useRecovery ? t("auth.recoveryCode") : t("auth.mfaCode")}</span>
                  <input
                    className="code-input"
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={useRecovery ? "text" : "numeric"}
                    placeholder={useRecovery ? "xxxx-xxxx-xxxx" : "123456"}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
              )}
              {mode === "token" && (
                <label className="field">
                  <span>{t("auth.token")}</span>
                  <input type="password" autoFocus value={token} onChange={(e) => setLocalToken(e.target.value)} />
                </label>
              )}
              {error && <div className="error-banner">{error}</div>}
              {info && <p className="notice">{info}</p>}
              <div className="auth-links">
                {mode === "password" && (
                  <button type="button" className="link-btn" onClick={() => switchTo("forgot")}>
                    {t("auth.forgot")}
                  </button>
                )}
                {mode === "password" && signupOpen && (
                  <button type="button" className="link-btn" onClick={() => switchTo("signup")}>
                    {t("auth.createAccount")}
                  </button>
                )}
                {mode === "mfa" && (
                  <button type="button" className="link-btn" onClick={() => setUseRecovery(!useRecovery)}>
                    {useRecovery ? t("auth.useCode") : t("auth.useRecovery")}
                  </button>
                )}
                {(mode === "signup" || mode === "forgot" || mode === "mfa") && (
                  <button type="button" className="link-btn" onClick={() => switchTo("password")}>
                    {mode === "signup" ? t("auth.haveAccount") : t("auth.backToSignIn")}
                  </button>
                )}
                {(mode === "password" || mode === "token") && (
                  <button type="button" className="link-btn" onClick={() => switchTo(mode === "password" ? "token" : "password")}>
                    {mode === "password" ? t("auth.useToken") : t("auth.usePassword")}
                  </button>
                )}
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn" type="submit" disabled={busy || !canSubmit || (mode === "forgot" && Boolean(info))}>
                {submitLabel}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
