import { useI18n } from "@zamtest/i18n/react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import type { Enrollment } from "../api";
import { DESIGNER_URL } from "../links";
import { atLeast, useMe } from "../session";
import { ErrorBanner, PageHeader } from "../ui";

/**
 * "Connect this PC": the page the ZamTech AI Agent opens after it is installed.
 * A signed-in Developer or Admin approves the PC, which then gets its own
 * credential. With next=designer (right after setup) the Designer opens next.
 */
export function Connect({ query }: { query: string }) {
  const { t } = useI18n();
  const me = useMe();
  const params = new URLSearchParams(query);
  const [code, setCode] = useState(params.get("code") ?? "");
  const [typed, setTyped] = useState("");
  const next = params.get("next");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) return;
    setNotFound(false);
    setEnrollment(undefined);
    api<Enrollment>(`/api/enrollments/${encodeURIComponent(code)}`)
      .then(setEnrollment)
      .catch(() => setNotFound(true));
  }, [code]);

  // Right after setup, carry on into the Designer once the PC is approved.
  const approved = enrollment?.status === "approved";
  useEffect(() => {
    if (!approved || next !== "designer") return;
    const timer = setTimeout(() => window.location.assign(DESIGNER_URL), 1500);
    return () => clearTimeout(timer);
  }, [approved, next]);

  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError(undefined);
    try {
      setEnrollment(await api<Enrollment>(`/api/enrollments/${encodeURIComponent(code)}/${decision}`, { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    const value = typed.trim().toUpperCase();
    if (value) setCode(value);
  };

  const canApprove = atLeast(me, "developer");

  return (
    <>
      <PageHeader title={t("connect.title")} subtitle={t("connect.subtitle")} />
      <div className="card connect-card">
        {!code || notFound ? (
          <form onSubmit={submitCode}>
            {notFound && <div className="error-banner">{t("connect.notFound")}</div>}
            <label className="field">
              <span>{t("connect.enterCode")}</span>
              <input className="code-input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="ABCD-EFGH" autoFocus />
            </label>
            <button className="btn" type="submit" disabled={!typed.trim()}>
              {t("connect.continue")}
            </button>
          </form>
        ) : !enrollment ? (
          <p className="muted">{t("common.loading")}</p>
        ) : (
          <>
            <dl className="connect-facts">
              <dt>{t("connect.computer")}</dt>
              <dd>
                <strong>{enrollment.name}</strong>
                {enrollment.machine && enrollment.machine !== enrollment.name && <span className="muted"> ({enrollment.machine})</span>}
              </dd>
              <dt>{t("connect.system")}</dt>
              <dd>{enrollment.os || "-"}</dd>
              <dt>{t("connect.code")}</dt>
              <dd>
                <code className="connect-code">{enrollment.userCode}</code>
              </dd>
            </dl>
            <ErrorBanner error={error} />
            {enrollment.status === "pending" && (
              <>
                <p className="notice">{t("connect.checkCode")}</p>
                {enrollment.reconnects && <p className="notice">{t("connect.reconnects", { name: enrollment.reconnects })}</p>}
                {canApprove ? (
                  <div className="actions">
                    <button className="btn" onClick={() => void decide("approve")} disabled={busy}>
                      {t("connect.approve")}
                    </button>
                    <button className="btn-ghost" onClick={() => void decide("deny")} disabled={busy}>
                      {t("connect.deny")}
                    </button>
                  </div>
                ) : (
                  me && <p className="muted">{t("connect.needsDeveloper")}</p>
                )}
              </>
            )}
            {enrollment.status === "approved" && (
              <div className="connect-done">
                <p>✓ {t("connect.approved")}</p>
                {next === "designer" ? (
                  <p className="muted">{t("connect.openingDesigner")}</p>
                ) : (
                  <a className="btn" href={DESIGNER_URL}>
                    {t("connect.openDesigner")}
                  </a>
                )}
              </div>
            )}
            {enrollment.status === "denied" && <p className="muted">{t("connect.denied")}</p>}
          </>
        )}
      </div>
    </>
  );
}
