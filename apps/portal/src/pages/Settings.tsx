import { useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { LanguageSelect, ThemeSelect, useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import type { BackupStatus } from "../api";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import { ErrorBanner, Field, PageHeader } from "../ui";

export function Settings() {
  const { t } = useI18n();
  const me = useMe();
  const ai = usePoll<{ configured: boolean; model: string | null }>("/api/ai/status", 0);

  return (
    <>
      <PageHeader title={t("settings.title")} />
      <section className="card">
        <h2>{t("common.language")}</h2>
        <p className="muted">{t("settings.languageHelp")}</p>
        <LanguageSelect />
        <h2 className="card-sub">{t("theme.label")}</h2>
        <p className="muted">{t("theme.help")}</p>
        <ThemeSelect />
      </section>
      {me?.kind === "user" && <AccountCard name={me.name} email={me.email} role={me.role} />}
      {atLeast(me, "admin") && <BackupCard />}
      <section className="card">
        <h2>{t("settings.ai")}</h2>
        {ai.data?.configured ? (
          <p>{t("settings.aiEnabled", { model: ai.data.model ?? "" })}</p>
        ) : (
          <p className="muted">{t("settings.aiDisabled")}</p>
        )}
      </section>
    </>
  );
}

function AccountCard({ name, email, role }: { name: string; email: string; role: string }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const change = async () => {
    setError(undefined);
    setDone(false);
    try {
      await api("/api/auth/password", { method: "POST", body: { current, next } });
      setCurrent("");
      setNext("");
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card">
      <h2>{t("settings.account")}</h2>
      <p>
        <strong>{name}</strong> · {email} · <span className="role-badge">{t(`role.${role}` as MessageKey)}</span>
      </p>
      <h3 className="card-sub">{t("settings.changePassword")}</h3>
      <ErrorBanner error={error} />
      <Field label={t("settings.currentPassword")}>
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label={t("settings.newPassword")} hint={t("users.passwordHint")}>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <button className="btn" disabled={!current || next.length < 10} onClick={() => void change()}>
        {t("settings.changePassword")}
      </button>
      {done && <span className="muted"> {t("settings.passwordChanged")}</span>}
    </section>
  );
}

function BackupCard() {
  const { t, dateTime } = useI18n();
  const status = usePoll<BackupStatus>("/api/admin/backup", 10_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const s = status.data;

  const runNow = async () => {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await api("/api/admin/backup", { method: "POST" });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      status.reload();
    }
  };

  return (
    <section className="card">
      <h2>{t("backup.title")}</h2>
      {!s ? null : !s.configured ? (
        <p className="muted">{t("backup.notConfigured")}</p>
      ) : (
        <>
          <p className="muted">{t("backup.help", { schedule: s.schedule ?? "", days: s.keepDays ?? 0 })}</p>
          <p className="muted">{t("backup.location", { location: s.location ?? "" })}</p>
          <p>{s.lastSuccessAt ? t("backup.last", { time: dateTime(s.lastSuccessAt) }) : t("backup.none")}</p>
          {s.lastError && <div className="error-banner">{t("backup.failed", { error: s.lastError })}</div>}
          {s.nextRunAt && <p className="muted">{t("backup.next", { time: dateTime(s.nextRunAt) })}</p>}
          <ErrorBanner error={error} />
          <button className="btn" disabled={busy || s.running} onClick={() => void runNow()}>
            {busy || s.running ? t("backup.running") : t("backup.now")}
          </button>
          {done && <span className="muted"> {t("backup.done")}</span>}
        </>
      )}
    </section>
  );
}
