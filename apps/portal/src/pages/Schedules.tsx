import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useState } from "react";
import { api } from "../api";
import type { Agent, Package, Schedule } from "../api";
import { EnvironmentBadge, EnvironmentSelect, useEnvironmentsOn } from "../env";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";
import { collectInputs, formatInput, InputsEditor } from "./StartJobModal";

const PRESETS: Array<[MessageKey, string]> = [
  ["schedules.presetEvery5", "*/5 * * * *"],
  ["schedules.presetHourly", "0 * * * *"],
  ["schedules.presetWeekdays9", "0 9 * * 1-5"],
  ["schedules.presetDaily6", "0 6 * * *"],
  ["schedules.presetMondays8", "0 8 * * 1"],
];

export function Schedules() {
  const { t, timeAgo, dateTime } = useI18n();
  const { data, error, reload } = usePoll<Schedule[]>("/api/schedules", 10_000);
  const packages = usePoll<Package[]>("/api/packages", 0);
  const envsOn = useEnvironmentsOn();
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
    if (!confirm(t("schedules.confirmDelete", { name: s.name }))) return;
    await api(`/api/schedules/${s.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHeader
        title={t("schedules.title")}
        subtitle={t("schedules.subtitle")}
        actions={
          <button className="btn" onClick={() => setEditing({ cron: "0 9 * * 1-5", enabled: true, inputs: {} })}>
            {t("schedules.new")}
          </button>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.process")}</th>
              <th>{t("schedules.cron")}</th>
              <th>{t("schedules.nextRun")}</th>
              <th>{t("schedules.lastRun")}</th>
              <th>{t("schedules.enabled")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong> {envsOn && <EnvironmentBadge env={s.environment ?? "prod"} />}
                </td>
                <td>{pkgName(s.packageId)}</td>
                <td>
                  <code>{s.cron}</code> {s.timezone && <span className="muted">{s.timezone}</span>}
                </td>
                <td>{s.nextRunAt ? dateTime(s.nextRunAt) : "-"}</td>
                <td>{timeAgo(s.lastRunAt)}</td>
                <td>
                  <input type="checkbox" checked={s.enabled} onChange={() => void toggle(s)} />
                </td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => void runNow(s)}>
                    {t("schedules.runNow")}
                  </button>
                  <button className="btn-ghost" onClick={() => setEditing(s)}>
                    {t("common.edit")}
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(s)}>
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("schedules.empty")}</Empty>
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
  const { t } = useI18n();
  const agents = usePoll<Agent[]>("/api/agents", 0);
  const [form, setForm] = useState<Partial<Schedule>>(initial);
  const envsOn = useEnvironmentsOn();
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
      title={initial.id ? t("schedules.editTitle") : t("schedules.newTitle")}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn" onClick={() => void save()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <ErrorBanner error={error} />
      <Field label={t("common.name")}>
        <input value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t("common.process")}>
        <select value={form.packageId ?? ""} onChange={(e) => setForm({ ...form, packageId: e.target.value })}>
          <option value="">{t("schedules.selectProcess")}</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} v{p.version}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("schedules.cronExpression")} hint={t("schedules.cronHint")}>
        <input value={form.cron ?? ""} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
      </Field>
      <div className="chips">
        {PRESETS.map(([label, cron]) => (
          <button key={cron} type="button" className="chip" onClick={() => setForm({ ...form, cron })}>
            {t(label)}
          </button>
        ))}
      </div>
      <Field label={t("schedules.timezone")} hint={t("schedules.timezoneHint")}>
        <input value={form.timezone ?? ""} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
      </Field>
      {envsOn && (
        <Field label={t("processes.environment")}>
          <EnvironmentSelect value={form.environment ?? "prod"} onChange={(env) => setForm({ ...form, environment: env || undefined, targetAgentId: undefined })} />
        </Field>
      )}
      <Field label={t("common.runOn")}>
        <select value={form.targetAgentId ?? ""} onChange={(e) => setForm({ ...form, targetAgentId: e.target.value })}>
          <option value="">{t("common.anyAgent")}</option>
          {agents.data?.filter((a) => !envsOn || (a.environment ?? "prod") === (form.environment ?? "prod")).map((a) => (
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
