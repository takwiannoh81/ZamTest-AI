import { useState } from "react";
import { api } from "../api";
import type { Package } from "../api";
import { timeAgo, usePoll } from "../hooks";
import { Empty, ErrorBanner, PageHeader } from "../ui";
import { StartJobModal } from "./StartJobModal";

export function Processes() {
  const { data, error, reload } = usePoll<Package[]>("/api/packages", 10_000);
  const [starting, setStarting] = useState<Package>();
  const [showAll, setShowAll] = useState(false);

  const latest = new Map<string, Package>();
  for (const p of data ?? []) {
    const cur = latest.get(p.workflowId);
    if (!cur || p.version > cur.version) latest.set(p.workflowId, p);
  }
  const rows = showAll ? (data ?? []) : [...latest.values()];

  const remove = async (p: Package) => {
    if (!confirm(`Delete ${p.name} v${p.version}?`)) return;
    try {
      await api(`/api/packages/${p.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Processes"
        subtitle="Published, versioned automations ready to run"
        actions={
          <label className="toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all versions
          </label>
        }
      />
      <ErrorBanner error={error} />
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Version</th>
              <th>Inputs</th>
              <th>Published</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                  {p.description && <div className="muted">{p.description}</div>}
                  {p.releaseNotes && <div className="muted">Notes: {p.releaseNotes}</div>}
                </td>
                <td>v{p.version}</td>
                <td>{p.variables.filter((v) => v.direction === "in" || v.direction === "inout").map((v) => v.name).join(", ") || "-"}</td>
                <td>{timeAgo(p.publishedAt)}</td>
                <td className="row-actions">
                  <button className="btn" onClick={() => setStarting(p)}>
                    ▶ Start
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(p)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No processes yet. Build a workflow in the Designer and click Publish.</Empty>
      )}
      {starting && <StartJobModal pkg={starting} onClose={() => setStarting(undefined)} />}
    </>
  );
}
