import { api } from "../api";
import type { Agent } from "../api";
import { timeAgo, usePoll } from "../hooks";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";

export function Agents() {
  const { data, error, reload } = usePoll<Agent[]>("/api/agents");

  const remove = async (a: Agent) => {
    if (!confirm(`Remove agent ${a.name}? It will re-register the next time it connects.`)) return;
    await api(`/api/agents/${a.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHeader title="Bot Agents" subtitle="Machines that execute your automations" />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Machine</th>
              <th>OS</th>
              <th>Version</th>
              <th>Last heartbeat</th>
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
                      <a href={`#/jobs/${a.currentJobId}`}>current job</a>
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
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>
          <p>No agents connected yet. Start one on any machine:</p>
          <pre>pnpm dev:agent{"\n"}# or: ZAMTEST_SERVER=http://host:4000 ZAMTEST_AGENT_KEY=... pnpm --filter @zamtest/agent start</pre>
        </Empty>
      )}
    </>
  );
}
