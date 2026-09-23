import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { setToken, UNAUTHORIZED_EVENT } from "./api";

/**
 * Shows a sign-in dialog whenever the orchestrator answers 401, e.g. on a
 * public deployment that requires ZAMTEST_ADMIN_TOKEN. The token is checked
 * against the API before it is saved.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [needed, setNeeded] = useState(false);
  const [token, setLocal] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onUnauthorized = () => setNeeded(true);
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await fetch(`${import.meta.env.VITE_API_URL ?? ""}/api/stats`, {
      headers: { authorization: `Bearer ${token.trim()}` },
    }).catch(() => undefined);
    setBusy(false);
    if (!res || res.status === 401) {
      setInvalid(true);
      return;
    }
    setToken(token.trim());
    window.location.reload();
  };

  return (
    <>
      {children}
      {needed && (
        <div className="modal-backdrop auth-backdrop">
          <form className="modal auth-modal" onSubmit={(e) => void submit(e)}>
            <div className="modal-head">
              <h2>{t("auth.title")}</h2>
            </div>
            <div className="modal-body">
              <p className="muted">{t("auth.help")}</p>
              <label className="field">
                <span>{t("auth.token")}</span>
                <input
                  type="password"
                  autoFocus
                  autoComplete="current-password"
                  value={token}
                  onChange={(e) => {
                    setLocal(e.target.value);
                    setInvalid(false);
                  }}
                />
              </label>
              {invalid && <div className="error-banner">{t("auth.invalid")}</div>}
            </div>
            <div className="modal-foot">
              <button className="btn" type="submit" disabled={busy || !token.trim()}>
                {t("auth.submit")}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
