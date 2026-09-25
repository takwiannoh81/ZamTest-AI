import { useEffect, useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { ReportProblem } from "@zamtest/help";
import { api, BASE } from "../api";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, PageHeader } from "../ui";

type Status = "new" | "investigating" | "fixed" | "wontfix";
interface BugReport {
  id: string;
  workspaceName: string;
  reporter: string;
  kind: "blocking" | "annoying" | "suggestion";
  what: string;
  doing?: string;
  context: { app: string; page?: string; where?: string; userAgent?: string; language?: string; timeZone?: string; screen?: string; errors: Array<{ time: string; message: string }>; ip?: string };
  images: Array<{ name: string; type: string; bytes: number }>;
  status: Status;
  note?: string;
  createdAt: string;
}

const STATUSES: Status[] = ["new", "investigating", "fixed", "wontfix"];
const KIND_ICON = { blocking: "🔴", annoying: "🟠", suggestion: "💡" } as const;

/** Report a problem: for everyone. */
export function ReportPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader title={t("report.title")} subtitle={t("report.subtitle")} />
      <section className="card wide">
        <ReportProblem api={api} app="portal" />
      </section>
    </>
  );
}

/** Every customer's reports (the platform owner). */
export function BugReports({ query }: { query: string }) {
  const { t, dateTime } = useI18n();
  const [status, setStatus] = useState<Status | "">("new");
  const list = usePoll<BugReport[]>(`/api/platform/bug-reports${status ? `?status=${status}` : ""}`, 30_000);
  const [open, setOpen] = useState<string | undefined>(new URLSearchParams(query).get("id") ?? undefined);
  useEffect(() => {
    // Opened from the email: show it whatever its status now.
    if (new URLSearchParams(query).get("id")) setStatus("");
  }, [query]);

  return (
    <>
      <PageHeader title={t("bugs.title")} subtitle={t("bugs.subtitle")} />
      <div className="report-filters">
        <div className="segmented">
          {(["", ...STATUSES] as Array<Status | "">).map((s) => (
            <button key={s || "all"} className={status === s ? "active" : ""} onClick={() => setStatus(s)}>
              {s ? t(`report.status.${s}` as MessageKey) : t("bugs.all")}
            </button>
          ))}
        </div>
      </div>
      <ErrorBanner error={list.error} />
      {list.data && !list.data.length ? (
        <Empty>{t("bugs.empty")}</Empty>
      ) : (
        <section className="card wide">
          <table>
            <tbody>
              {list.data?.map((r) => (
                <BugRow key={r.id} report={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} onSaved={list.reload} dateTime={dateTime} />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function BugRow({ report: r, open, onToggle, onSaved, dateTime }: { report: BugReport; open: boolean; onToggle: () => void; onSaved: () => void; dateTime: (d: string) => string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>(r.status);
  const [note, setNote] = useState(r.note ?? "");
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const save = async () => {
    setError(undefined);
    try {
      await api(`/api/platform/bug-reports/${r.id}`, { method: "PUT", body: { status, note: note.trim() || null } });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const c = r.context;
  return (
    <>
      <tr className="clickable" onClick={onToggle}>
        <td className="nowrap">{KIND_ICON[r.kind]}</td>
        <td>
          <strong>{r.what.split("\n")[0]!.slice(0, 140)}</strong>
          <div className="muted small">
            {r.reporter} · {r.workspaceName} · {c.app} · {dateTime(r.createdAt)}
            {r.images.length ? ` · 📎 ${r.images.length}` : ""}
          </div>
        </td>
        <td className="nowrap">
          <span className={`report-status status-${r.status}`}>{t(`report.status.${r.status}` as MessageKey)}</span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3}>
            <div className="bug-detail">
              <p className="bug-text">{r.what}</p>
              {r.doing && (
                <>
                  <h4>{t("report.doing")}</h4>
                  <p className="bug-text">{r.doing}</p>
                </>
              )}
              {r.images.length > 0 && (
                <div className="bug-images">
                  {r.images.map((img, n) => (
                    <a key={n} href={`${BASE}/api/platform/bug-reports/${r.id}/images/${n}`} target="_blank" rel="noreferrer">
                      <img src={`${BASE}/api/platform/bug-reports/${r.id}/images/${n}`} alt={img.name} />
                    </a>
                  ))}
                </div>
              )}
              <dl className="bug-context">
                {c.where && (<><dt>{t("bugs.where")}</dt><dd>{c.where}</dd></>)}
                {c.page && (<><dt>{t("bugs.page")}</dt><dd>{c.page}</dd></>)}
                {c.userAgent && (<><dt>{t("bugs.browser")}</dt><dd>{c.userAgent}</dd></>)}
                <dt>{t("bugs.locale")}</dt>
                <dd>{[c.language, c.timeZone, c.screen, c.ip].filter(Boolean).join(" · ")}</dd>
              </dl>
              {c.errors.length > 0 && (
                <>
                  <h4>{t("bugs.errors")}</h4>
                  <pre className="report-errors">{c.errors.map((e) => `${e.time} ${e.message}`).join("\n")}</pre>
                </>
              )}
              <div className="bug-answer">
                <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {t(`report.status.${s}` as MessageKey)}
                    </option>
                  ))}
                </select>
                <textarea rows={2} value={note} placeholder={t("bugs.notePlaceholder")} onChange={(e) => setNote(e.target.value)} />
                <button className="btn" onClick={() => void save()}>
                  {t("common.save")}
                </button>
              </div>
              <p className="muted small">{t("bugs.fixedEmail")}</p>
              {saved && <p className="muted small">{t("bugs.saved")}</p>}
              <ErrorBanner error={error} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
