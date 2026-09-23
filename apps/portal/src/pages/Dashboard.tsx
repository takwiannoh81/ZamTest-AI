import type { Job, Stats } from "../api";
import { timeAgo, usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";

export function Dashboard() {
  const stats = usePoll<Stats>("/api/stats");
  const jobs = usePoll<Job[]>("/api/jobs?limit=8");
  const s = stats.data;

  const tiles = s
    ? [
        { label: "Agents online", value: `${s.agents.online} / ${s.agents.total}`, hint: `${s.agents.busy} busy` },
        { label: "Jobs running", value: s.jobs.running, hint: `${s.jobs.pending} queued` },
        { label: "Succeeded", value: s.jobs.succeeded, hint: `${s.jobs.failed} failed` },
        { label: "Processes", value: s.packages, hint: `${s.workflows} workflows in design` },
        { label: "Active schedules", value: s.schedules, hint: "cron triggers" },
        { label: "Selectors self-healed", value: s.healedSelectors, hint: s.ai.configured ? "AI enabled" : "AI not configured" },
      ]
    : [];

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Health of your digital workforce" />
      <ErrorBanner error={stats.error} />
      <section className="tiles">
        {tiles.map((t) => (
          <div className="tile" key={t.label}>
            <span className="muted">{t.label}</span>
            <strong>{t.value}</strong>
            <small className="muted">{t.hint}</small>
          </div>
        ))}
      </section>
      <h2 className="section-title">Recent jobs</h2>
      {jobs.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Process</th>
              <th>Status</th>
              <th>Source</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data.map((j) => (
              <tr key={j.id} className="clickable" onClick={() => (window.location.hash = `/jobs/${j.id}`)}>
                <td>{j.name}</td>
                <td>
                  <Badge status={j.status} />
                </td>
                <td>{j.source}</td>
                <td>{timeAgo(j.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No jobs yet. Publish a workflow from the Designer and start it from Processes.</Empty>
      )}
    </>
  );
}
