import { useCallback, useEffect, useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { api, BASE } from "../api";
import { Empty, ErrorBanner, PageHeader } from "../ui";

interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  actorKind: string;
  ip?: string;
  action: string;
  targetId?: string;
  target?: string;
  status: number;
  details?: Record<string, unknown>;
  count?: number;
}

/** "workflow.publish" in words: "Workflow · published", in the person's language. */
function useActionText() {
  const { t } = useI18n();
  return (action: string) => {
    const [noun = "", verb = ""] = action.split(".");
    const nounKey = `audit.noun.${noun}` as MessageKey;
    const verbKey = `audit.verb.${verb}` as MessageKey;
    const nounText = t(nounKey);
    const verbText = t(verbKey);
    // An action this page does not know yet: as it is.
    return nounText === nounKey || verbText === verbKey ? action : `${nounText} · ${verbText}`;
  };
}

/** Who did what, and when (admins). */
export function AuditLog() {
  const { t, dateTime } = useI18n();
  const actionText = useActionText();
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const filters = useCallback(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    // Whole days, in the viewer's time zone.
    if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString());
    return p;
  }, [q, from, to]);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const p = filters();
        p.set("limit", "100");
        if (before) p.set("before", before);
        const page = await api<{ events: AuditEvent[]; more: boolean }>(`/api/audit?${p.toString()}`);
        setEvents((old) => (before ? [...old, ...page.events] : page.events));
        setMore(page.more);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [filters],
  );

  // Search as the person types (a moment after they stop).
  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const result = (status: number) => (status < 400 ? t("audit.done") : status === 401 ? t("audit.failed") : t("audit.refused"));
  const detailText = (d?: Record<string, unknown>) =>
    d
      ? Object.entries(d)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`)
          .join(" · ")
      : "";

  return (
    <>
      <PageHeader
        title={t("audit.title")}
        subtitle={t("audit.subtitle")}
        actions={
          <a className="btn-ghost" href={`${BASE}/api/audit/export.csv?${filters().toString()}`}>
            ⤓ {t("audit.export")}
          </a>
        }
      />
      <div className="report-filters">
        <input className="search" value={q} placeholder={t("audit.search")} onChange={(e) => setQ(e.target.value)} aria-label={t("audit.search")} />
        <label className="muted small">
          {t("audit.from")} <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="muted small">
          {t("audit.to")} <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ErrorBanner error={error} />
      {!events.length && !loading ? (
        <Empty>{t("audit.empty")}</Empty>
      ) : (
        <section className="card wide">
          <table>
            <thead>
              <tr>
                <th>{t("audit.when")}</th>
                <th>{t("audit.who")}</th>
                <th>{t("audit.what")}</th>
                <th>{t("audit.target")}</th>
                <th>{t("audit.result")}</th>
                <th>{t("audit.ip")}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{dateTime(e.at)}</td>
                  <td>{e.actor}</td>
                  <td>
                    {actionText(e.action)}
                    {e.count && e.count > 1 && <span className="muted small"> ×{e.count}</span>}
                    {e.details && <div className="muted small">{detailText(e.details)}</div>}
                  </td>
                  <td>{e.target ?? <span className="muted small">{e.targetId}</span>}</td>
                  <td className={e.status < 400 ? "ok-text" : "error-text"}>{result(e.status)}</td>
                  <td className="muted small">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {more && (
            <button className="btn-ghost" disabled={loading} onClick={() => void load(events.at(-1)?.at)}>
              {t("audit.more")}
            </button>
          )}
        </section>
      )}
      <p className="muted small">{t("audit.kept")}</p>
    </>
  );
}
