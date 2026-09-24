import { useI18n } from "@zamtest/i18n/react";
import type { Job, Stats } from "../api";
import { usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";
import { JobRowActions, RunAllButton } from "./JobActions";

export function Dashboard() {
  const { t, timeAgo } = useI18n();
  const stats = usePoll<Stats>("/api/stats");
  const jobs = usePoll<Job[]>("/api/jobs?limit=8");
  const s = stats.data;

  const tiles = s
    ? [
        { label: t("dashboard.agentsOnline"), value: `${s.agents.online} / ${s.agents.total}`, hint: t("dashboard.busyCount", { count: s.agents.busy }) },
        { label: t("dashboard.jobsRunning"), value: s.jobs.running, hint: t("dashboard.queuedCount", { count: s.jobs.pending }) },
        { label: t("dashboard.succeeded"), value: s.jobs.succeeded, hint: t("dashboard.failedCount", { count: s.jobs.failed }) },
        { label: t("dashboard.processes"), value: s.packages, hint: t("dashboard.workflowsInDesign", { count: s.workflows }) },
        { label: t("dashboard.activeSchedules"), value: s.schedules, hint: t("dashboard.cronTriggers") },
        {
          label: t("dashboard.selectorsHealed"),
          value: s.healedSelectors,
          hint: s.ai.configured ? t("dashboard.aiEnabled") : t("dashboard.aiNotConfigured"),
        },
      ]
    : [];

  return (
    <>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />
      <ErrorBanner error={stats.error} />
      <section className="tiles">
        {tiles.map((tile) => (
          <div className="tile" key={tile.label}>
            <span className="muted">{tile.label}</span>
            <strong>{tile.value}</strong>
            <small className="muted">{tile.hint}</small>
          </div>
        ))}
      </section>
      <div className="section-head">
        <h2 className="section-title">{t("dashboard.recentJobs")}</h2>
        {jobs.data?.length ? <RunAllButton jobs={jobs.data} onDone={jobs.reload} /> : null}
      </div>
      {jobs.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.process")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.source")}</th>
              <th>{t("common.created")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.data.map((j) => (
              <tr key={j.id} className="clickable" onClick={() => (window.location.hash = `/jobs/${j.id}`)}>
                <td>{j.name}</td>
                <td>
                  <Badge status={j.status} />
                </td>
                <td>{t(`source.${j.source}` as "source.manual")}</td>
                <td>{timeAgo(j.createdAt)}</td>
                <td>
                  <JobRowActions job={j} onChanged={jobs.reload} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("dashboard.noJobs")}</Empty>
      )}
    </>
  );
}
