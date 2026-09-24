import { useI18n } from "@zamtest/i18n/react";
import type { MouseEvent } from "react";
import { useState } from "react";
import { api } from "../api";
import type { Job } from "../api";
import { atLeast, useMe } from "../session";

const FINAL = ["succeeded", "failed", "cancelled"];
/** Rerunning a Designer test run (no published version) needs the developer role. */
const canRun = (me: ReturnType<typeof useMe>, job: Job) => atLeast(me, job.packageId ? "operator" : "developer");

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

/** Run again and Delete, for one row of a jobs table (the row itself opens the job). */
export function JobRowActions({ job, onChanged }: { job: Job; onChanged: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const [busy, setBusy] = useState(false);

  const act = async (e: MouseEvent, action: () => Promise<unknown>) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await action();
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const final = FINAL.includes(job.status);

  return (
    <span className="row-actions job-actions">
      {canRun(me, job) && (
        <button className="btn-ghost run-btn" disabled={busy} onClick={(e) => void act(e, () => api(`/api/jobs/${job.id}/rerun`, { method: "POST" }))}>
          ▷ {t("jobs.run")}
        </button>
      )}
      {atLeast(me, "developer") && (
        <button
          className="icon-btn danger"
          disabled={busy || !final}
          title={final ? t("common.delete") : t("jobs.stopFirst")}
          aria-label={t("common.delete")}
          onClick={(e) => void act(e, async () => confirm(t("jobs.confirmDelete", { name: job.name })) && api(`/api/jobs/${job.id}`, { method: "DELETE" }))}
        >
          <TrashIcon />
        </button>
      )}
    </span>
  );
}

/** Runs each workflow in the list once more (its latest run, with the same inputs and PC). */
export function RunAllButton({ jobs, onDone }: { jobs: Job[]; onDone: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const [busy, setBusy] = useState(false);
  // Jobs come newest first: keep the latest run of each process (or tested workflow).
  const latest = new Map<string, Job>();
  for (const j of jobs) {
    const key = j.packageId ? `pkg:${j.packageId}` : `wf:${j.name}`;
    if (!latest.has(key) && canRun(me, j)) latest.set(key, j);
  }
  if (!latest.size) return null;

  const runAll = async () => {
    if (!confirm(t("jobs.confirmRunAll", { count: latest.size }))) return;
    setBusy(true);
    const failures: string[] = [];
    for (const j of latest.values()) {
      await api(`/api/jobs/${j.id}/rerun`, { method: "POST" }).catch((e: Error) => failures.push(`${j.name}: ${e.message}`));
    }
    setBusy(false);
    onDone();
    if (failures.length) alert(failures.join("\n"));
  };

  return (
    <button className="btn" disabled={busy} onClick={() => void runAll()}>
      ▷ {t("jobs.runAll")}
    </button>
  );
}
