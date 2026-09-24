import { useI18n } from "@zamtest/i18n/react";
import { useEffect, useState } from "react";
import { BASE } from "../api";
import { usePoll } from "../hooks";

export interface Screenshot {
  seq: number;
  stepId: string;
  stepType?: string;
  label?: string;
  status: "ok" | "error";
  source: "browser" | "desktop";
  time: string;
}

const imageUrl = (jobId: string, seq: number) => `${BASE}/api/jobs/${encodeURIComponent(jobId)}/screenshots/${seq}`;
const stepName = (s: Screenshot) => s.label || s.stepType || s.stepId;

/** The screen after each step of a job, updated while it runs; click one to see it large. */
export function JobScreenshots({ jobId, running }: { jobId: string; running: boolean }) {
  const { t, time } = useI18n();
  const { data } = usePoll<Screenshot[]>(`/api/jobs/${jobId}/screenshots`, running ? 2000 : 0);
  const [open, setOpen] = useState<number>();
  const shots = data ?? [];
  const failure = [...shots].reverse().find((s) => s.status === "error");

  useEffect(() => {
    if (open === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(undefined);
      if (e.key === "ArrowRight") setOpen((i) => Math.min((i ?? 0) + 1, shots.length - 1));
      if (e.key === "ArrowLeft") setOpen((i) => Math.max((i ?? 0) - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, shots.length]);

  if (!shots.length) return null;
  const current = open !== undefined ? shots[open] : undefined;

  return (
    <>
      {failure && (
        <figure className="failure-shot">
          <figcaption>{t("jobs.failedScreen", { step: stepName(failure) })}</figcaption>
          <img src={imageUrl(jobId, failure.seq)} alt={stepName(failure)} onClick={() => setOpen(shots.indexOf(failure))} />
        </figure>
      )}
      <h2 className="section-title">{t("jobs.screenshots", { count: shots.length })}</h2>
      <div className="shot-strip">
        {shots.map((s, i) => (
          <button key={s.seq} className={`shot-thumb${s.status === "error" ? " shot-error" : ""}`} onClick={() => setOpen(i)} title={stepName(s)}>
            <img src={imageUrl(jobId, s.seq)} alt={stepName(s)} loading="lazy" />
            <span className="shot-caption">
              <span className="shot-n">{i + 1}</span> {stepName(s)}
            </span>
            <span className="shot-time">{time(s.time)}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className="lightbox" onClick={() => setOpen(undefined)}>
          <div className="lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <div className="lightbox-head">
              <strong>
                {open! + 1} / {shots.length} · {stepName(current)}
              </strong>
              <span className="muted">
                {time(current.time)}
                {current.status === "error" && <span className="error-text"> · {t("status.failed")}</span>}
              </span>
              <span className="spacer" />
              <button className="btn-ghost" disabled={open === 0} onClick={() => setOpen(open! - 1)} aria-label={t("jobs.previous")}>
                ←
              </button>
              <button className="btn-ghost" disabled={open === shots.length - 1} onClick={() => setOpen(open! + 1)} aria-label={t("jobs.next")}>
                →
              </button>
              <button className="btn-ghost" onClick={() => setOpen(undefined)} aria-label={t("common.close")}>
                ✕
              </button>
            </div>
            <img src={imageUrl(jobId, current.seq)} alt={stepName(current)} />
          </div>
        </div>
      )}
    </>
  );
}
