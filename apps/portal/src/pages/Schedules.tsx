import { useState } from "react";
import { api } from "../api";
import type { Agent, Package, Schedule } from "../api";
import { timeAgo, usePoll } from "../hooks";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";
import { collectInputs, formatInput, InputsEditor } from "./StartJobModal";

const PRESETS: Array<[string, string]> = [
  ["Every 5 minutes", "*/5 * * * *"],
  ["Hourly", "0 * * * *"],
  ["Weekdays 09:00", "0 9 * * 1-5"],
  ["Daily 06:00", "0 6 * * *"],
  ["Mondays 08:00", "0 8 * * 1"],
];

export function Schedules() {
  const { data, error, reload } = usePoll<Schedule[]>("/api/schedules", 10_000);
  const packages = usePoll<Package[]>("/api/packages", 0);
  const [editing, setEditing] = useState<Partial<Schedule> | null>(null);
  const pkgName = (id: string) => {
    const p = packages.data?.find((x) => x.id === id);
    return p ? `${p.name} v${p.version}` : id;
  };

  const toggle = async (s: Schedule) => {
    await api(`/api/schedules/${s.id}`, { method: "PUT", body: { enabled: !s.enabled } });
    reload();
  };
  const runNow = async (s: Schedule) => {
    await api(`/api/schedules/${s.id}/run`, { method: "POST" });
    window.location.hash = "/jobs";
  };
  const remove = async (s: Schedule) => {
    if (!confirm(`Delete schedule ${s.name}?`)) return;
    await api(`/api/schedules/${s.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        subtitle="Time-based triggers for unattended automation"
        actions={
          <button className="btn" onClick={() => setEditing({ cron: "0 9 * * 1-5", enabled: true, inputs: {} })}>
            + New schedule
          </button>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Process</th>
              <th>Cron</th>
              <th>Next run</th>
              <th>Last run</th>
              <th>Enabled</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                </td>
                <td>{pkgName(s.packageId)}</td>
                <td>
                  <code>{s.cron}</code> {s.timezone && <span className="muted">{s.timezone}</span>}
                </td>
                <td>{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "-"}</td>
                <td>{timeAgo(s.lastRunAt)}</td>
                <td>
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                </td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void runNow(s)}>
                    Run now
                  </button>
                  <button className="btn-ghost" onClick={() => setEditing(s)}>
                    Edit
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(s)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No schedules yet.</Empty>
      )}
      {editing && (
        <ScheduleModal
          initial={editing}
          packages={packages.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function ScheduleModal({
  initial,
  packages,
  onClose,
  onSaved,
}: {
  initial: Partial<Schedule>;
  packages: Package[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const agents = usePoll<Agent[]>("/api/agents", 0);
  const [form, setForm] = useState<Partial<Schedule>>(initial);
  const [inputs, setInputs] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(initial.inputs ?? {}).map(([k, v]) => [k, formatInput(v)])),
  );
  const [error, setError] = useState<string>();
  const pkg = packages.find((p) => p.id === form.packageId);

  const save = async () => {
    const body = { ...form, inputs: collectInputs(inputs), targetAgentId: form.targetAgentId || undefined, timezone: form.timezone || undefined };
    try {
      if (initial.id) await api(`/api/schedules/${initial.id}`, { method: "PUT", body });
      else await api("/api/schedules", { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={initial.id ? "Edit schedule" : "New schedule"}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label="Name">
        <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Process">
        <select value={form.packageId ?? ""} onChange={(e) => setForm({ ...form, packageId: e.target.value })}>
          <option value="">Select a process...</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} v{p.version}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Cron expression" hint="minute hour day-of-month month day-of-week">
        <input value={form.cron ?? ""} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
      </Field>
      <div className="chips">
        {PRESETS.map(([label, cron]) => (
          <button key={cron} type="button" className="chip" onClick={() => setForm({ ...form, cron })}>
            {label}
          </button>
        ))}
      </div>
      <Field label="Time zone" hint="IANA name, e.g. Europe/London. Empty = server time.">
        <input value={form.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      </Field>
      <Field label="Run on">
        <select value={form.targetAgentId ?? ""} onChange={(e) => setForm({ ...form, targetAgentId: e.target.value })}>
          <option value="">Any available agent</option>
          {agents.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Field>
      {pkg && <InputsEditor pkg={pkg} values={inputs} onChange={setInputs} />}
    </Modal>
  );
}
