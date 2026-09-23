import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Job, JobLog } from "../api";

export interface RunState {
  jobId: string;
}

/** Streams the log of a designer test run and surfaces AI-healed selectors. */
export function RunPanel({
  run,
  onClose,
  onStepStatus,
  onApplyHealed,
  onSelectStep,
}: {
  run: RunState;
  onClose: () => void;
  onStepStatus: (s: Record<string, "running" | "ok" | "error">) => void;
  onApplyHealed: (stepId: string, selector: string) => void;
  onSelectStep: (id: string) => void;
}) {
  const { t, time } = useI18n();
  const [job, setJob] = useState<Job>();
  const [logs, setLogs] = useState<JobLog[]>([]);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const final = job && ["succeeded", "failed", "cancelled"].includes(job.status);

  useEffect(() => {
    last.current = 0;
    setLogs([]);
    setJob(undefined);
    onStepStatus({});
  }, [run.jobId]);

  useEffect(() => {
    if (final) return;
    let alive = true;
    const poll = async () => {
      const [j, fresh] = await Promise.all([
        api<Job>(`/api/jobs/${run.jobId}`).catch(() => undefined),
        api<JobLog[]>(`/api/jobs/${run.jobId}/logs?after=${last.current}`).catch(() => [] as JobLog[]),
      ]);
      if (!alive) return;
      if (j) setJob(j);
      if (fresh.length) {
        last.current = fresh.at(-1)!.seq;
        setLogs((l) => [...l, ...fresh]);
      }
    };
    void poll();
    const timer = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [run.jobId, final]);

  useEffect(() => {
    const status: Record<string, "running" | "ok" | "error"> = {};
    for (const l of logs) if (l.stepId && l.level === "error") status[l.stepId] = "error";
    onStepStatus(status);
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [logs]);

  const cancel = () => void api(`/api/jobs/${run.jobId}/cancel`, { method: "POST" }).catch(() => undefined);

  return (
    <section className="run-panel">
      <div className="run-head">
        <strong>{t("run.title")}</strong>
        <span className={`badge badge-${job?.status ?? "pending"}`}>{t(job ? (`status.${job.status}` as MessageKey) : "status.queued")}</span>
        {job?.status === "pending" && <span className="muted tiny">{t("run.waiting", { command: "pnpm dev:agent" })}</span>}
        <span className="spacer" />
        {!final && (
          <button className="btn-ghost small danger" onClick={cancel}>
            {t("run.stop")}
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>
      </div>
      {job && job.healedSelectors.length > 0 && (
        <div className="healed">
          {job.healedSelectors.map((h, i) => (
            <div key={i} className="healed-row">
              <span>{t("run.healed")}</span>
              <code>{h.oldSelector}</code>→<code>{h.newSelector}</code>
              {h.stepId && (
                <button className="btn small" onClick={() => onApplyHealed(h.stepId!, h.newSelector)}>
                  {t("run.applyFix")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="log" ref={box}>
        {logs.map((l) => (
          <div key={l.seq} className={`log-line log-${l.level}`} onClick={() => l.stepId && onSelectStep(l.stepId)}>
            <span className="log-time">{time(l.time)}</span>
            <span className="log-level">{l.level}</span>
            <span>{l.message}</span>
          </div>
        ))}
      </div>
      {job?.outputs && Object.keys(job.outputs).length > 0 && <pre className="outputs">{t("run.outputs")} {JSON.stringify(job.outputs, null, 2)}</pre>}
    </section>
  );
}
