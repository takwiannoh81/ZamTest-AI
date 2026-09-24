import { useI18n } from "@zamtest/i18n/react";
import { useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api";
import type { Agent, InstallKey } from "../api";
import { EnvironmentBadge, EnvironmentSelect, useEnvironmentsOn } from "../env";
import { usePoll } from "../hooks";
import { AGENT_DOWNLOAD_URL } from "../links";
import { atLeast, useMe } from "../session";
import { Badge, Empty, ErrorBanner, PageHeader } from "../ui";

/** The address agents connect to (api.<domain> in production; this site otherwise, which proxies /api). */
const AGENT_SERVER_URL = (import.meta.env.VITE_AGENT_SERVER_URL || import.meta.env.VITE_API_URL || window.location.origin).replace(/\/+$/, "");

export function Agents() {
  const { t, timeAgo } = useI18n();
  const me = useMe();
  const { data, error, reload } = usePoll<Agent[]>("/api/agents");
  const envsOn = useEnvironmentsOn();
  const [failure, setFailure] = useState<string>();
  const setEnvironment = async (a: Agent, environment: string) => {
    setFailure(undefined);
    await api(`/api/agents/${a.id}/environment`, { method: "PUT", body: { environment } }).catch((e: Error) => setFailure(e.message));
    reload();
  };

  const remove = async (a: Agent) => {
    if (!confirm(t("agents.confirmRemove", { name: a.name }))) return;
    await api(`/api/agents/${a.id}`, { method: "DELETE" });
    reload();
  };

  return (
    <>
      <PageHeader
        title={t("agents.title")}
        subtitle={t("agents.subtitle")}
        actions={
          <a className="btn" href={AGENT_DOWNLOAD_URL}>
            {t("agents.downloadWindows")}
          </a>
        }
      />
      <ErrorBanner error={error ?? failure} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.status")}</th>
              {envsOn && <th>{t("processes.environment")}</th>}
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
                  {a.approvedBy && <div className="muted small">{t("agents.approvedBy", { who: a.approvedBy })}</div>}
                  {a.currentJobId && (
                    <div>
                      <a href={`#/jobs/${a.currentJobId}`}>{t("agents.currentJob")}</a>
                    </div>
                  )}
                </td>
                <td>
                  <Badge status={a.status} />
                </td>
                {envsOn && (
                  <td>
                    {atLeast(me, "admin") ? (
                      <EnvironmentSelect value={a.environment ?? "prod"} onChange={(env) => void setEnvironment(a, env)} />
                    ) : (
                      <EnvironmentBadge env={a.environment ?? "prod"} />
                    )}
                  </td>
                )}
                <td>{a.machine}</td>
                <td>{a.os}</td>
                <td>{a.version}</td>
                <td>{timeAgo(a.lastHeartbeat)}</td>
                <td className="row-actions">
                  {atLeast(me, "admin") && (
                    <button className="btn-ghost danger" onClick={() => void remove(a)}>
                      {t("common.remove")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>
          <p>{t("agents.empty")}</p>
          <p>{t("agents.installHint")}</p>
          <p>
            <a className="btn" href={AGENT_DOWNLOAD_URL}>
              {t("agents.downloadWindows")}
            </a>
          </p>
          <p className="muted">{t("agents.fromSource")}</p>
          <pre>
            pnpm --filter @zamtest/agent exec tsx src/cli.ts enroll --server {AGENT_SERVER_URL} --config agent.json{"\n"}
            pnpm --filter @zamtest/agent exec tsx src/cli.ts connect --config agent.json
          </pre>
        </Empty>
      )}
      {atLeast(me, "admin") && <InstallKeys />}
    </>
  );
}

/** Admins: keys that approve PCs installed silently by IT, without a browser. */
function InstallKeys() {
  const { t, dateTime } = useI18n();
  const { data, error, reload } = usePoll<InstallKey[]>("/api/admin/install-keys", 0);
  const [name, setName] = useState("");
  const [maxUses, setMaxUses] = useState("10");
  const [days, setDays] = useState("30");
  const [created, setCreated] = useState<InstallKey>();
  const [failure, setFailure] = useState<string>();
  const [copied, setCopied] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setFailure(undefined);
    try {
      const key = await api<InstallKey>("/api/admin/install-keys", {
        method: "POST",
        body: {
          name: name.trim(),
          ...(Number(maxUses) > 0 ? { maxUses: Number(maxUses) } : {}),
          ...(Number(days) > 0 ? { expiresInDays: Number(days) } : {}),
        },
      });
      setCreated(key);
      setCopied(false);
      setName("");
      reload();
    } catch (err) {
      setFailure((err as Error).message);
    }
  };

  const remove = async (key: InstallKey) => {
    if (!confirm(t("agents.confirmDeleteKey", { name: key.name }))) return;
    await api(`/api/admin/install-keys/${key.id}`, { method: "DELETE" });
    reload();
  };

  const command = created?.key ? `ZamTechAI-Agent-Setup.exe /VERYSILENT /SERVER=${AGENT_SERVER_URL} /INSTALLKEY=${created.key}` : "";
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true));
  };

  return (
    <section className="section-title">
      <h2>{t("agents.installKeys")}</h2>
      <p className="muted">{t("agents.installKeysHelp")}</p>
      <ErrorBanner error={error ?? failure} />
      <form className="key-form" onSubmit={(e) => void create(e)}>
        <label className="field">
          <span>{t("common.name")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Finance PCs" maxLength={100} />
        </label>
        <label className="field">
          <span>{t("agents.keyMaxUses")}</span>
          <input type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("agents.keyExpiresDays")}</span>
          <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={!name.trim()}>
          {t("agents.create")}
        </button>
      </form>
      {created?.key && (
        <div className="card">
          <p className="notice">{t("agents.keyCreated")}</p>
          <div className="key-box">
            <code>{created.key}</code>
            <button className="btn-ghost" onClick={() => copy(created.key!)}>
              {copied ? "✓" : t("common.copy")}
            </button>
          </div>
          <span className="muted">{t("agents.keyCommand")}</span>
          <div className="key-box">
            <code>{command}</code>
            <button className="btn-ghost" onClick={() => copy(command)}>
              {t("common.copy")}
            </button>
          </div>
        </div>
      )}
      {data?.length ? (
        <table>
          <tbody>
            {data.map((k) => (
              <tr key={k.id}>
                <td>
                  <strong>{k.name}</strong>
                  <div className="muted small">{k.createdBy}</div>
                </td>
                <td>{k.maxUses ? t("agents.keyUsage", { uses: k.uses, max: k.maxUses }) : t("agents.keyUsageUnlimited", { uses: k.uses })}</td>
                <td>{k.expiresAt ? t("agents.keyExpires", { date: dateTime(k.expiresAt) }) : t("agents.keyNoExpiry")}</td>
                <td className="row-actions">
                  <button className="btn-ghost danger" onClick={() => void remove(k)}>
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        data && <p className="muted">{t("agents.noKeys")}</p>
      )}
    </section>
  );
}
