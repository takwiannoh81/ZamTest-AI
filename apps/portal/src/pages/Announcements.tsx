import { useEffect, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { Markdown } from "@zamtest/help";
import { api } from "../api";
import { ErrorBanner } from "../ui";

interface Announcement {
  id: string;
  subject: string;
  createdAt: string;
  createdBy: string;
  status: "sending" | "sent";
  recipients: number;
  sent: number;
  failed: number;
  translate: boolean;
}

interface Overview {
  subscribers: number;
  emailReady: boolean;
  companyAddress: string | null;
  announcements: Announcement[];
}

/** The person's own choice: product update emails on or off (every email also has an unsubscribe link). */
export function ProductUpdatesCard() {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<{ productUpdates: boolean; available: boolean }>("/api/auth/me/preferences")
      .then((p) => p.available && setOn(p.productUpdates))
      .catch(() => undefined);
  }, []);
  if (on === undefined) return null;
  const change = (next: boolean) => {
    setOn(next);
    api("/api/auth/me/preferences", { method: "PUT", body: { productUpdates: next } }).catch((e: Error) => {
      setOn(!next);
      setError(e.message);
    });
  };
  return (
    <section className="card">
      <h2>{t("updates.settingsTitle")}</h2>
      <ErrorBanner error={error} />
      <label className="check-row">
        <input type="checkbox" checked={on} onChange={(e) => change(e.target.checked)} />
        <span>{t("updates.settingsLabel")}</span>
      </label>
      <p className="muted small">{t("updates.settingsHelp")}</p>
    </section>
  );
}

/** Platform owner: write a product update and email it to every customer who has not unsubscribed. */
export function Announcements() {
  const { t, dateTime } = useI18n();
  const [data, setData] = useState<Overview>();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [translate, setTranslate] = useState(true);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();

  const load = () => api<Overview>("/api/platform/announcements").then(setData, (e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  // Progress while one is being sent.
  const sending = data?.announcements.some((a) => a.status === "sending");
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [sending]);

  const ready = subject.trim().length >= 3 && body.trim().length >= 10;
  const test = async () => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      const r = await api<{ sentTo: string }>("/api/platform/announcements/test", { method: "POST", body: { subject, body, translate } });
      setInfo(t("updates.testSent", { email: r.sentTo }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!data || !confirm(t("updates.confirmSend", { count: data.subscribers }))) return;
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await api("/api/platform/announcements", { method: "POST", body: { subject, body, translate } });
      setSubject("");
      setBody("");
      setPreview(false);
      setInfo(t("updates.sendingStarted"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <ErrorBanner error={error} /> : null;
  return (
    <section className="card">
      <h2>{t("updates.title")}</h2>
      <p className="muted">{t("updates.subtitle", { count: data.subscribers })}</p>
      {!data.emailReady && <div className="error-banner">{t("updates.noEmail")}</div>}
      {!data.companyAddress && <div className="error-banner">{t("updates.noAddress")}</div>}
      <ErrorBanner error={error} />
      {info && <p className="notice">{info}</p>}
      <label className="field">
        <span>{t("updates.subject")}</span>
        <input value={subject} maxLength={150} onChange={(e) => setSubject(e.target.value)} placeholder={t("updates.subjectExample")} />
      </label>
      <label className="field">
        <span>{t("updates.message")}</span>
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("updates.messageExample")} />
        <small className="muted">{t("updates.messageHelp")}</small>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={translate} onChange={(e) => setTranslate(e.target.checked)} />
        <span>{t("updates.translate")}</span>
      </label>
      {preview && ready && (
        <div className="announcement-preview">
          <strong>{subject}</strong>
          <Markdown text={body} />
        </div>
      )}
      <div className="row-actions">
        <button className="btn-ghost" disabled={!ready} onClick={() => setPreview(!preview)}>
          {preview ? t("updates.hidePreview") : t("updates.preview")}
        </button>
        <button className="btn-ghost" disabled={!ready || busy || !data.emailReady || !data.companyAddress} onClick={() => void test()}>
          {t("updates.sendTest")}
        </button>
        <button className="btn" disabled={!ready || busy || sending || !data.emailReady || !data.companyAddress || !data.subscribers} onClick={() => void send()}>
          {t("updates.send", { count: data.subscribers })}
        </button>
      </div>
      {data.announcements.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("updates.subject")}</th>
              <th>{t("updates.sentAt")}</th>
              <th>{t("updates.progress")}</th>
            </tr>
          </thead>
          <tbody>
            {data.announcements.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.subject}</strong>
                  <div className="muted small">{a.createdBy}</div>
                </td>
                <td>{dateTime(a.createdAt)}</td>
                <td>
                  {a.status === "sending" ? t("updates.sendingProgress", { sent: a.sent, total: a.recipients }) : t("updates.sentProgress", { sent: a.sent, total: a.recipients })}
                  {a.failed > 0 && <div className="error-text small">{t("updates.failedCount", { count: a.failed })}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
