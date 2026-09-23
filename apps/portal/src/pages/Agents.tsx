import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import type { Agent } from "../api";
import { usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";

export function Agents() {
  const { t, timeAgo } = useI18n();
  const { data, error, reload } = usePoll<Agent[]>("/api/agents");

  const remove = async (a: Agent) => {
    if (!confirm(t("agents.confirmRemove", { name: a.name }))) return;
    await api(`/api/agents/${a.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHeader title={t("agents.title")} subtitle={t("agents.subtitle")} />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.status")}</th>
              <th>{t("agents.machine")}</th>
              <th>{t("agents.os")}</th>
              <th>{t("common.version")}</th>
              <th>{t("agents.lastHeartbeat")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  {a.currentJobId && (
                    <div>
                      <a href={`#/jobs/${a.currentJobId}`}>{t("agents.currentJob")}</a>
                    </div>
                  )}
                </td>
                <td>
                  <Badge status={a.status} />
                </td>
                <td>{a.machine}</td>
                <td>{a.os}</td>
                <td>{a.version}</td>
                <td>{timeAgo(a.lastHeartbeat)}</td>
                <td className="row-actions">
                  <button className="btn-ghost danger" onClick={() => void remove(a)}>
                    {t("common.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>
          <p>{t("agents.empty")}</p>
          <pre>pnpm dev:agent{"\n"}# ZAMTEST_SERVER=http://host:4000 ZAMTEST_AGENT_KEY=... pnpm --filter @zamtest/agent start</pre>
        </Empty>
      )}
    </>
  );
}
