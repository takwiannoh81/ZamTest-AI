import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useState } from "react";
import { api } from "../api";
import type { Limits, PlanId, WorkspaceSummary } from "../api";
import { usePoll } from "../hooks";
import { ErrorBanner, PageHeader } from "../ui";

const isUnlimited = (n: number) => n >= 1e12;
const PLANS: PlanId[] = ["free", "pro", "enterprise"];
type LimitField = "builders" | "bots" | "runsPerMonth" | "aiPerMonth";
const LIMIT_FIELDS: Array<[LimitField, MessageKey]> = [
  ["builders", "billing.builders"],
  ["bots", "billing.bots"],
  ["runsPerMonth", "billing.runs"],
  ["aiPerMonth", "billing.ai"],
];

/**
 * The platform owner's view of every customer workspace: plan, usage and
 * payment status. Plans can be changed here, e.g. for an Enterprise agreement
 * (with its own limits) or to help a customer.
 */
export function Customers() {
  const { t, dateTime } = useI18n();
  const { data, error, reload } = usePoll<WorkspaceSummary[]>("/api/platform/workspaces", 0);
  const [editing, setEditing] = useState<string>();

  return (
    <>
      <PageHeader title={t("nav.customers")} subtitle={t("customers.subtitle")} />
      <ErrorBanner error={error} />
      {data && (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("billing.currentPlan")}</th>
              <th>{t("customers.people")}</th>
              <th>{t("billing.bots")}</th>
              <th>{t("billing.runs")}</th>
              <th>{t("common.status")}</th>
              <th>{t("common.created")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                <td>
                  <strong>{w.name}</strong>
                  <div className="muted small">{w.id}</div>
                </td>
                <td>
                  <span className={`plan-badge plan-${w.plan}`}>{t(`plan.${w.plan}` as MessageKey)}</span>
                </td>
                <td>{w.users}</td>
                <td>
                  {w.usage.bots} / {isUnlimited(w.limits.bots) ? "∞" : w.limits.bots}
                </td>
                <td>
                  {w.usage.runs} / {isUnlimited(w.limits.runsPerMonth) ? "∞" : w.limits.runsPerMonth}
                </td>
                <td>{w.billing?.status ?? "-"}</td>
                <td>{w.createdAt ? dateTime(w.createdAt) : "-"}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => setEditing(editing === w.id ? undefined : w.id)}>
                    {t("common.edit")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && data?.find((w) => w.id === editing) && (
        <PlanEditor
          workspace={data.find((w) => w.id === editing)!}
          onSaved={() => {
            setEditing(undefined);
            reload();
          }}
        />
      )}
    </>
  );
}

function PlanEditor({ workspace, onSaved }: { workspace: WorkspaceSummary; onSaved: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState(workspace.name);
  const [plan, setPlan] = useState<PlanId>(workspace.plan);
  const [limits, setLimits] = useState<Record<LimitField, string>>(() => {
    const value = (n: number) => (workspace.plan === "enterprise" && !isUnlimited(n) ? String(n) : "");
    return { builders: value(workspace.limits.builders), bots: value(workspace.limits.bots), runsPerMonth: value(workspace.limits.runsPerMonth), aiPerMonth: value(workspace.limits.aiPerMonth) };
  });
  const [seats, setSeats] = useState({ builders: workspace.seats?.builders ?? 1, bots: workspace.seats?.bots ?? 1 });
  const [failure, setFailure] = useState<string>();
  const [domains, setDomains] = useState((workspace.ssoDomains ?? []).join(", "));

  const save = async () => {
    setFailure(undefined);
    const customLimits: Partial<Limits> = {};
    for (const [field] of LIMIT_FIELDS) if (limits[field].trim()) customLimits[field] = Number(limits[field]);
    try {
      await api(`/api/platform/workspaces/${workspace.id}`, {
        method: "PUT",
        body: {
          name: name.trim(),
          plan,
          ...(plan === "pro" ? { seats } : {}),
          ...(plan === "enterprise" ? { customLimits: Object.keys(customLimits).length ? customLimits : null } : {}),
          ssoDomains: domains.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean),
        },
      });
      onSaved();
    } catch (e) {
      setFailure((e as Error).message);
    }
  };

  return (
    <div className="card">
      <h2>{workspace.name}</h2>
      <ErrorBanner error={failure} />
      <label className="field">
        <span>{t("common.name")}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      </label>
      <div className="segmented" role="group">
        {PLANS.map((p) => (
          <button key={p} className={plan === p ? "active" : ""} onClick={() => setPlan(p)}>
            {t(`plan.${p}` as MessageKey)}
          </button>
        ))}
      </div>
      {plan === "pro" && (
        <div className="seat-grid">
          <label className="field">
            <span>{t("billing.builders")}</span>
            <input type="number" min={1} value={seats.builders} onChange={(e) => setSeats({ ...seats, builders: Math.max(1, Number(e.target.value)) })} />
          </label>
          <label className="field">
            <span>{t("billing.bots")}</span>
            <input type="number" min={1} value={seats.bots} onChange={(e) => setSeats({ ...seats, bots: Math.max(1, Number(e.target.value)) })} />
          </label>
        </div>
      )}
      {plan === "enterprise" && (
        <>
          <p className="muted">{t("customers.limitsHint")}</p>
          <div className="seat-grid">
            {LIMIT_FIELDS.map(([field, label]) => (
              <label className="field" key={field}>
                <span>{t(label)}</span>
                <input type="number" min={0} value={limits[field]} onChange={(e) => setLimits({ ...limits, [field]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="field">
            <span>{t("customers.ssoDomains")}</span>
            <input value={domains} placeholder="acme.com" onChange={(e) => setDomains(e.target.value)} />
          </label>
        </>
      )}
      <button className="btn" onClick={() => void save()}>
        {t("common.save")}
      </button>
    </div>
  );
}
