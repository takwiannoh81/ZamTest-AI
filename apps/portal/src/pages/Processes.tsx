import { useI18n } from "@zamtest/i18n/react";
import { useState } from "react";
import { api } from "../api";
import type { EnvironmentId, EnvironmentsView, Package, Promotion } from "../api";
import { EnvironmentBadge, envName } from "../env";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import { Empty, ErrorBanner, PageHeader } from "../ui";
import { StartJobModal } from "./StartJobModal";

const NEXT: Partial<Record<EnvironmentId, EnvironmentId>> = { dev: "test", test: "prod" };

export function Processes() {
  const { t, timeAgo } = useI18n();
  const me = useMe();
  const { data, error, reload } = usePoll<Package[]>("/api/packages", 10_000);
  const envs = usePoll<EnvironmentsView>("/api/environments", 10_000);
  const promotions = usePoll<Promotion[]>("/api/promotions?status=pending", 10_000);
  const [starting, setStarting] = useState<{ pkg: Package; env?: EnvironmentId }>();
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<EnvironmentId>("prod");
  const [failure, setFailure] = useState<string>();
  const [info, setInfo] = useState<string>();
  const enabled = Boolean(envs.data?.enabled);
  const pending = promotions.data ?? [];

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setFailure(undefined);
    setInfo(undefined);
    try {
      await action();
      if (done) setInfo(done);
    } catch (e) {
      setFailure((e as Error).message);
    }
    reload();
    envs.reload();
    promotions.reload();
  };

  const promote = (p: Package, to: EnvironmentId) =>
    act(async () => {
      const note = to === "prod" && envs.data?.requireApproval ? window.prompt(t("processes.promoteNote")) : "";
      if (note === null) return;
      const result = await api<Promotion>(`/api/packages/${p.id}/promote`, { method: "POST", body: { to, note: note || undefined } });
      setInfo(result.status === "pending" ? t("processes.sentForApproval") : t("processes.promoted", { env: envName(t, to) }));
    });

  const decide = (x: Promotion, action: "approve" | "reject" | "cancel") =>
    act(async () => {
      const note = action === "reject" ? window.prompt(t("processes.rejectNote")) : "";
      if (note === null) return;
      await api(`/api/promotions/${x.id}/${action}`, { method: "POST", body: { note: note || undefined } });
    });

  const remove = async (p: Package) => {
    if (!confirm(t("processes.confirmDelete", { name: p.name, version: p.version }))) return;
    await act(() => api(`/api/packages/${p.id}`, { method: "DELETE" }));
  };

  const latest = new Map<string, Package>();
  for (const p of data ?? []) {
    const cur = latest.get(p.workflowId);
    if (!cur || p.version > cur.version) latest.set(p.workflowId, p);
  }
  const current = envs.data?.environments.find((e) => e.id === tab);
  const rows: Array<Package & { deployedAt?: string; deployedBy?: string }> = showAll ? (data ?? []) : enabled ? (current?.processes ?? []) : [...latest.values()];

  const promoteButton = (p: Package, from: EnvironmentId) => {
    const to = NEXT[from];
    if (!to || !atLeast(me, "developer")) return null;
    const waiting = pending.some((x) => x.packageId === p.id && x.to === to);
    const already = p.deployments?.[to] && (envs.data?.environments.find((e) => e.id === to)?.processes.some((c) => c.id === p.id) ?? false);
    if (already) return null;
    return (
      <button className="btn-ghost" disabled={waiting} onClick={() => void promote(p, to)}>
        {waiting ? t("processes.waiting") : to === "prod" && envs.data?.requireApproval ? t("processes.requestProd") : t("processes.promoteTo", { env: envName(t, to) })}
      </button>
    );
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
      <ErrorBanner error={error ?? failure} />
      {info && <p className="notice">{info}</p>}

      {enabled && pending.length > 0 && (
        <div className="card">
          <h2>{t("processes.approvals", { count: pending.length })}</h2>
          <table>
            <tbody>
              {pending.map((x) => (
                <tr key={x.id}>
                  <td>
                    <strong>
                      {x.name} v{x.version}
                    </strong>{" "}
                    → {envName(t, x.to)}
                    <div className="muted small">{t("processes.requested", { who: x.requestedBy, time: timeAgo(x.requestedAt) })}</div>
                    {x.note && <div className="muted small">“{x.note}”</div>}
                  </td>
                  <td className="row-actions">
                    {atLeast(me, "admin") && x.requestedById !== me?.id && (
                      <>
                        <button className="btn" onClick={() => void decide(x, "approve")}>
                          {t("processes.approve")}
                        </button>
                        <button className="btn-ghost danger" onClick={() => void decide(x, "reject")}>
                          {t("processes.reject")}
                        </button>
                      </>
                    )}
                    {(x.requestedById === me?.id || atLeast(me, "admin")) && (
                      <button className="btn-ghost" onClick={() => void decide(x, "cancel")}>
                        {t("processes.withdraw")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {enabled && !showAll && (
        <div className="segmented env-tabs" role="tablist">
          {envs.data!.environments.map((e) => (
            <button key={e.id} role="tab" className={tab === e.id ? "active" : ""} onClick={() => setTab(e.id)}>
              {envName(t, e.id)} <span className="muted small">({e.processes.length})</span>
            </button>
          ))}
        </div>
      )}

      {rows.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.version")}</th>
              {enabled && showAll && <th>{t("processes.environments")}</th>}
              <th>{t("common.inputs")}</th>
              <th>{enabled && !showAll ? t("processes.since") : t("processes.published")}</th>
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
                  {p.source && <div className="muted small">Git {p.source.commit.slice(0, 7)}</div>}
                </td>
                <td>v{p.version}</td>
                {enabled && showAll && (
                  <td>
                    {(Object.keys(p.deployments ?? {}) as EnvironmentId[]).map((e) => (
                      <EnvironmentBadge key={e} env={e} />
                    ))}
                  </td>
                )}
                <td>{p.variables.filter((v) => v.direction === "in" || v.direction === "inout").map((v) => v.name).join(", ") || "-"}</td>
                <td>
                  {p.deployedAt ? timeAgo(p.deployedAt) : timeAgo(p.publishedAt)}
                  {p.deployedBy && <div className="muted small">{p.deployedBy}</div>}
                </td>
                <td className="row-actions">
                  <button className="btn" onClick={() => setStarting({ pkg: p, env: enabled && !showAll ? tab : undefined })}>
                    {t("processes.start")}
                  </button>
                  {enabled && !showAll && promoteButton(p, tab)}
                  {enabled && showAll && (Object.keys(p.deployments ?? {}) as EnvironmentId[]).map((e) => <span key={e}>{promoteButton(p, e)}</span>)}
                  <button className="btn-ghost danger" onClick={() => void remove(p)}>
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{enabled && !showAll ? t("processes.envEmpty", { env: envName(t, tab) }) : t("processes.empty")}</Empty>
      )}
      {starting && <StartJobModal pkg={starting.pkg} environment={starting.env} onClose={() => setStarting(undefined)} />}
    </>
  );
}
