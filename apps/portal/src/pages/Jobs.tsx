import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job, JobLog } from "../api";
import { duration, usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";
import { JobRowActions, RunAllButton } from "./JobActions";
import { JobScreenshots } from "./JobScreenshots";

const STATUSES = ["", "pending", "running", "succeeded", "failed", "cancelled"];

export function Jobs() {
  const { t, timeAgo } = useI18n();
  const [status, setStatus] = useState("");
  const { data, error, reload } = usePoll<Job[]>(`/api/jobs?limit=200${status ? `&status=${status}` : ""}`);

  return (
    <>
      <PageHeader
        title={t("jobs.title")}
        subtitle={t("jobs.subtitle")}
        actions={
          <>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? t(`status.${s}` as MessageKey) : t("jobs.allStatuses")}
                </option>
              ))}
            </select>
            {data?.length ? <RunAllButton jobs={data} onDone={reload} /> : null}
          </>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.process")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.source")}</th>
              <th>{t("common.created")}</th>
              <th>{t("common.duration")}</th>
              <th>{t("jobs.healed")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((j) => (
              <tr key={j.id} className="clickable" onClick={() => (window.location.hash = `/jobs/${j.id}`)}>
                <td>
                  {j.name}
                  {j.packageVersion ? <span className="muted"> v{j.packageVersion}</span> : null}
                </td>
                <td>
                  <Badge status={j.status} />
                </td>
                <td>{t(`source.${j.source}` as MessageKey)}</td>
                <td>{timeAgo(j.createdAt)}</td>
                <td>{duration(j.startedAt, j.finishedAt)}</td>
                <td>{j.healedSelectors.length || ""}</td>
                <td>
                  <JobRowActions job={j} onChanged={reload} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("jobs.empty")}</Empty>
      )}
    </>
  );
}

export function JobDetail({ id }: { id: string }) {
  const { t, dateTime, time } = useI18n();
  const job = usePoll<Job>(`/api/jobs/${id}`, 2000);
  const [logs, setLogs] = useState<JobLog[]>([]);
  const lastSeq = useRef(0);
  const final = job.data && ["succeeded", "failed", "cancelled"].includes(job.data.status);

  useEffect(() => {
    lastSeq.current = 0;
    setLogs([]);
  }, [id]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const fresh = await api<JobLog[]>(`/api/jobs/${id}/logs?after=${lastSeq.current}`).catch(() => []);
      if (!alive || !fresh.length) return;
      lastSeq.current = fresh.at(-1)!.seq;
      setLogs((l) => [...l, ...fresh]);
    };
    void load();
    const timer = final ? undefined : setInterval(load, 1500);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [id, final]);

  const cancel = async () => {
    try {
      await api(`/api/jobs/${id}/cancel`, { method: "POST" });
      job.reload();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const j = job.data;
  return (
    <>
      <PageHeader
        title={j ? j.name : t("jobs.job")}
        subtitle={id}
        actions={
          <>
            <a className="btn-ghost" href="#/jobs">
              {t("jobs.backToAll")}
            </a>
            {j && !final && (
              <button className="btn danger" onClick={() => void cancel()}>
                {t("jobs.cancel")}
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={job.error} />
      {j && (
        <section className="detail-grid">
          <div>
            <span className="muted">{t("common.status")}</span>
            <Badge status={j.status} />
          </div>
          <div>
            <span className="muted">{t("common.source")}</span>
            {t(`source.${j.source}` as MessageKey)}
          </div>
          {j.startedBy && (
            <div>
              <span className="muted">{t("jobs.startedBy")}</span>
              {j.startedBy}
            </div>
          )}
          <div>
            <span className="muted">{t("common.duration")}</span>
            {duration(j.startedAt, j.finishedAt)}
          </div>
          <div>
            <span className="muted">{t("common.created")}</span>
            {dateTime(j.createdAt)}
          </div>
        </section>
      )}
      {j?.error && <div className="error-banner">{j.error}</div>}
      {j && <JobScreenshots jobId={id} running={!final} />}
      {j && j.healedSelectors.length > 0 && (
        <>
          <h2 className="section-title">{t("jobs.healedTitle")}</h2>
          <p className="muted">{t("jobs.healedHelp")}</p>
          <table>
            <thead>
              <tr>
                <th>{t("jobs.step")}</th>
                <th>{t("jobs.oldSelector")}</th>
                <th>{t("jobs.newSelector")}</th>
                <th>{t("jobs.reason")}</th>
              </tr>
            </thead>
            <tbody>
              {j.healedSelectors.map((h, i) => (
                <tr key={i}>
                  <td>{h.stepId}</td>
                  <td>
                    <code>{h.oldSelector}</code>
                  </td>
                  <td>
                    <code>{h.newSelector}</code>
                  </td>
                  <td>{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {j?.inputs && Object.keys(j.inputs).length > 0 && (
        <>
          <h2 className="section-title">{t("common.inputs")}</h2>
          <pre>{JSON.stringify(j.inputs, null, 2)}</pre>
        </>
      )}
      {j?.outputs && Object.keys(j.outputs).length > 0 && (
        <>
          <h2 className="section-title">{t("common.outputs")}</h2>
          <pre>{JSON.stringify(j.outputs, null, 2)}</pre>
        </>
      )}
      <h2 className="section-title">{t("common.log")}</h2>
      <div className="log">
        {logs.map((l) => (
          <div key={l.seq} className={`log-line log-${l.level}`}>
            <span className="log-time">{time(l.time)}</span>
            <span className="log-level">{l.level}</span>
            <span>{l.message}</span>
          </div>
        ))}
        {!logs.length && <span className="muted">{t("jobs.waitingLog")}</span>}
      </div>
    </>
  );
}
