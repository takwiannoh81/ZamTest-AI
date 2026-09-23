import { useI18n } from "@zamtest/i18n/react";
import { useState } from "react";
import { api } from "../api";
import type { Package } from "../api";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, PageHeader } from "../ui";
import { StartJobModal } from "./StartJobModal";

export function Processes() {
  const { t, timeAgo } = useI18n();
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
    if (!confirm(t("processes.confirmDelete", { name: p.name, version: p.version }))) return;
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
        title={t("processes.title")}
        subtitle={t("processes.subtitle")}
        actions={
          <label className="toggle">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t("processes.showAll")}
          </label>
        }
      />
      <ErrorBanner error={error} />
      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.version")}</th>
              <th>{t("common.inputs")}</th>
              <th>{t("processes.published")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                  {p.description && <div className="muted">{p.description}</div>}
                  {p.releaseNotes && <div className="muted">{t("processes.notes", { notes: p.releaseNotes })}</div>}
                </td>
                <td>v{p.version}</td>
                <td>{p.variables.filter((v) => v.direction === "in" || v.direction === "inout").map((v) => v.name).join(", ") || "-"}</td>
                <td>{timeAgo(p.publishedAt)}</td>
                <td className="row-actions">
                  <button className="btn" onClick={() => setStarting(p)}>
                    {t("processes.start")}
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(p)}>
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("processes.empty")}</Empty>
      )}
      {starting && <StartJobModal pkg={starting} onClose={() => setStarting(undefined)} />}
    </>
  );
}
