import { useEffect, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ErrorBanner, Field } from "../ui";

interface AlertsView {
  emails: string[];
  /** Masked: the address is a secret. */
  slack?: string;
  teams?: string;
  jobFailed: boolean;
  testRuns: "failures" | "always" | "off";
  agentOffline: boolean;
  /** false: the defaults (the admins, failures). */
  chosen: boolean;
  emailReady: boolean;
}

type ChannelResult = Record<"email" | "slack" | "teams", string | undefined>;

/** Who hears about failed runs, and how: email, Slack, Microsoft Teams. */
export function AlertsCard() {
  const { t } = useI18n();
  const current = usePoll<AlertsView>("/api/workspace/alerts", 0);
  const [emails, setEmails] = useState("");
  const [slack, setSlack] = useState("");
  const [teams, setTeams] = useState("");
  const [removeSlack, setRemoveSlack] = useState(false);
  const [removeTeams, setRemoveTeams] = useState(false);
  const [jobFailed, setJobFailed] = useState(true);
  const [testRuns, setTestRuns] = useState<AlertsView["testRuns"]>("failures");
  const [agentOffline, setAgentOffline] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState<ChannelResult>();
  const [busy, setBusy] = useState(false);

  const s = current.data;
  useEffect(() => {
    if (!s) return;
    setEmails(s.emails.join(", "));
    setJobFailed(s.jobFailed);
    setTestRuns(s.testRuns);
    setAgentOffline(s.agentOffline);
  }, [s]);

  const save = async () => {
    setError(undefined);
    setSaved(false);
    setTested(undefined);
    try {
      await api("/api/workspace/alerts", {
        method: "PUT",
        body: {
          emails: emails.split(/[,;\s]+/).filter(Boolean),
          // Unchanged unless typed in or removed: the saved address is never sent back to the page.
          slackUrl: removeSlack ? null : slack.trim() || undefined,
          teamsUrl: removeTeams ? null : teams.trim() || undefined,
          jobFailed,
          testRuns,
          agentOffline,
        },
      });
      setSlack("");
      setTeams("");
      setRemoveSlack(false);
      setRemoveTeams(false);
      setSaved(true);
      current.reload();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      if (await save()) setTested(await api<ChannelResult>("/api/workspace/alerts/test", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const channelLine = (label: string, result: string | undefined) =>
    result && (
      <li key={label} className={result === "sent" ? "" : "error-text"}>
        {label}: {result === "sent" ? t("alerts.sent") : result}
      </li>
    );

  return (
    <section className="card">
      <h2>{t("alerts.title")}</h2>
      <p className="muted">{t("alerts.help")}</p>
      {s && !s.chosen && <p className="notice">{t("alerts.defaults")}</p>}
      <ErrorBanner error={error} />

      <h3 className="card-sub">{t("alerts.when")}</h3>
      <label className="check-row">
        <input type="checkbox" checked={jobFailed} onChange={(e) => setJobFailed(e.target.checked)} />
        {t("alerts.jobFailed")}
      </label>
      <Field label={t("alerts.testRuns")}>
        <select value={testRuns} onChange={(e) => setTestRuns(e.target.value as AlertsView["testRuns"])}>
          <option value="failures">{t("alerts.testRunsFailures")}</option>
          <option value="always">{t("alerts.testRunsAlways")}</option>
          <option value="off">{t("alerts.testRunsOff")}</option>
        </select>
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={agentOffline} onChange={(e) => setAgentOffline(e.target.checked)} />
        {t("alerts.agentOffline")}
      </label>
      <p className="muted small">{t("alerts.watched")}</p>

      <h3 className="card-sub">{t("alerts.where")}</h3>
      <Field label={t("alerts.emails")} hint={t("alerts.emailsHint")}>
        <input value={emails} placeholder="qa@company.com, ops@company.com" onChange={(e) => setEmails(e.target.value)} />
      </Field>
      {s && !s.emailReady && emails.trim() && <p className="error-text small">{t("alerts.noEmail")}</p>}

      <Field label={t("alerts.slack")} hint={t("alerts.slackHint")}>
        {s?.slack && !removeSlack ? (
          <div className="masked">
            <code>{s.slack}</code>
            <button className="link-btn" onClick={() => setRemoveSlack(true)}>
              {t("alerts.remove")}
            </button>
          </div>
        ) : (
          <input value={slack} placeholder="https://hooks.slack.com/services/..." onChange={(e) => setSlack(e.target.value)} />
        )}
      </Field>
      <Field label={t("alerts.teams")} hint={t("alerts.teamsHint")}>
        {s?.teams && !removeTeams ? (
          <div className="masked">
            <code>{s.teams}</code>
            <button className="link-btn" onClick={() => setRemoveTeams(true)}>
              {t("alerts.remove")}
            </button>
          </div>
        ) : (
          <input value={teams} placeholder="https://....logic.azure.com/workflows/..." onChange={(e) => setTeams(e.target.value)} />
        )}
      </Field>

      <div className="actions">
        <button className="btn" onClick={() => void save()}>
          {t("common.save")}
        </button>
        <button className="btn-ghost" disabled={busy} onClick={() => void sendTest()}>
          {busy ? t("alerts.testing") : t("alerts.test")}
        </button>
        {saved && !tested && <span className="muted">{t("alerts.saved")}</span>}
      </div>
      {tested && (
        <ul className="small">
          {channelLine(t("alerts.emailChannel"), tested.email)}
          {channelLine("Slack", tested.slack)}
          {channelLine("Teams", tested.teams)}
        </ul>
      )}
    </section>
  );
}
