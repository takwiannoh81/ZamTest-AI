import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job, JobLog } from "../api";
import { duration, timeAgo, usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";

const STATUSES = ["", "pending", "running", "succeeded", "failed", "cancelled"];

export function Jobs() {
  const [status, setStatus] = useState("");
  const { data, error } = usePoll<Job[]>(`/api/jobs?limit=200${status ? `&status=${status}` : ""}`);

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="Every execution of a process"
        actions={
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s || "All statuses"}
              </option>
            ))}
          </select>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Process</th>
              <th>Status</th>
              <th>Source</th>
              <th>Created</th>
              <th>Duration</th>
              <th>Healed</th>
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
                <td>{j.source}</td>
                <td>{timeAgo(j.createdAt)}</td>
                <td>{duration(j.startedAt, j.finishedAt)}</td>
                <td>{j.healedSelectors.length || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No jobs match.</Empty>
      )}
    </>
  );
}

export function JobDetail({ id }: { id: string }) {
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
        title={j ? j.name : "Job"}
        subtitle={id}
        actions={
          <>
            <a className="btn-ghost" href="#/jobs">
              ← All jobs
            </a>
            {j && !final && (
              <button className="btn danger" onClick={() => void cancel()}>
                Cancel job
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={job.error} />
      {j && (
        <section className="detail-grid">
          <div>
            <span className="muted">Status</span>
            <Badge status={j.status} />
          </div>
          <div>
            <span className="muted">Source</span>
            {j.source}
          </div>
          <div>
            <span className="muted">Duration</span>
            {duration(j.startedAt, j.finishedAt)}
          </div>
          <div>
            <span className="muted">Created</span>
            {new Date(j.createdAt).toLocaleString()}
          </div>
        </section>
      )}
      {j?.error && <div className="error-banner">{j.error}</div>}
      {j && j.healedSelectors.length > 0 && (
        <>
          <h2 className="section-title">AI self-healed selectors</h2>
          <p className="muted">These selectors broke at run time and were repaired by AI. Update them in the Designer to make the fix permanent.</p>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>Old selector</th>
                <th>New selector</th>
                <th>Reason</th>
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
          <h2 className="section-title">Inputs</h2>
          <pre>{JSON.stringify(j.inputs, null, 2)}</pre>
        </>
      )}
      {j?.outputs && Object.keys(j.outputs).length > 0 && (
        <>
          <h2 className="section-title">Outputs</h2>
          <pre>{JSON.stringify(j.outputs, null, 2)}</pre>
        </>
      )}
      <h2 className="section-title">Log</h2>
      <div className="log">
        {logs.map((l) => (
          <div key={l.seq} className={`log-line log-${l.level}`}>
            <span className="log-time">{new Date(l.time).toLocaleTimeString()}</span>
            <span className="log-level">{l.level}</span>
            <span>{l.message}</span>
          </div>
        ))}
        {!logs.length && <span className="muted">Waiting for log output...</span>}
      </div>
    </>
  );
}
