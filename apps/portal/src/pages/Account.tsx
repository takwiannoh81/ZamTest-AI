import { useI18n } from "@zamtest/i18n/react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api } from "../api";
import type { Me } from "../session";
import { signOut } from "../session";
import { ErrorBanner } from "../ui";
import { MfaCard } from "./Security";

/** A centered card for the pages people reach from an email, or before they can use the portal. */
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="account-page">
      <div className="card account-card">
        <div className="brand">
          <span className="logo">Z</span>
          <strong>ZamTech AI</strong>
        </div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

// A URL without the hash loads the page again (the portal, signed in or showing sign-in).
const home = () => window.location.replace(window.location.pathname);

/** #/verify?token=... from the confirmation email. Works signed in or not. */
export function VerifyEmail({ token }: { token: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"working" | "done" | "failed">("working");
  const sent = useRef(false);
  useEffect(() => {
    // StrictMode runs effects twice; the link works once.
    if (sent.current) return;
    sent.current = true;
    api("/api/auth/verify", { method: "POST", body: { token } }).then(
      () => setState("done"),
      () => setState("failed"),
    );
  }, [token]);
  return (
    <Panel title={t("verify.title")}>
      <p className={state === "failed" ? "error-text" : "muted"}>{t(`verify.${state}`)}</p>
      {state !== "working" && (
        <button className="btn" onClick={home}>
          {t("verify.continue")}
        </button>
      )}
    </Panel>
  );
}

/** #/reset-password?token=... from the reset email. */
export function ResetPassword({ token }: { token: string }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/password-reset", { method: "POST", body: { token, password } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title={t("reset.title")}>
      {done ? (
        <>
          <p className="muted">{t("reset.done")}</p>
          <button className="btn" onClick={home}>
            {t("verify.continue")}
          </button>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <ErrorBanner error={error} />
          <label className="field">
            <span>{t("reset.newPassword")}</span>
            <input type="password" autoFocus autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy || password.length < 10}>
            {t("reset.save")}
          </button>
        </form>
      )}
    </Panel>
  );
}

/** Signed in, but the email must be confirmed, or two-step sign-in set up, before anything else. */
export function Restricted({ me }: { me: Me }) {
  const { t } = useI18n();
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string>();
  const signOutButton = (
    <button className="link-btn" onClick={() => void signOut()}>
      {t("auth.signOut")}
    </button>
  );

  if (me.restriction === "mfa_setup_required") {
    return (
      <Panel title={t("auth.mfaTitle")}>
        <p className="muted">{t("security.requireMfaHelp")}</p>
        <MfaCard onEnabled={() => window.location.reload()} />
        {signOutButton}
      </Panel>
    );
  }

  const resend = async () => {
    setError(undefined);
    try {
      await api("/api/auth/verify/resend", { method: "POST" });
      setResent(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Panel title={t("verify.title")}>
      <p className="muted">{t("verify.sent", { email: me.email })}</p>
      <ErrorBanner error={error} />
      <div className="actions">
        {resent ? (
          <span className="muted">{t("verify.resent")}</span>
        ) : (
          <button className="btn-ghost" onClick={() => void resend()}>
            {t("verify.resend")}
          </button>
        )}
        {signOutButton}
      </div>
    </Panel>
  );
}
