import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { ApiToken, GitSettingsView } from "../api";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import { ErrorBanner, PageHeader } from "../ui";

interface CicdSettings {
  available: boolean;
  environments: boolean;
  requireApproval: boolean;
}

/** Environments, the Git repository for workflows, and API tokens for CI pipelines. */
export function SourceControl() {
  const { t } = useI18n();
  const me = useMe();
  const settings = usePoll<CicdSettings>("/api/cicd/settings", 0);
  const isAdmin = atLeast(me, "admin");
  return (
    <>
      <PageHeader title={t("nav.sourceControl")} subtitle={t("cicd.subtitle")} />
      {settings.data && !settings.data.available && (
        <p className="notice">
          {t("cicd.upgrade")}{" "}
          <a href="#/billing">{t("billing.viewPlans")}</a>
        </p>
      )}
      {settings.data && <EnvironmentsCard settings={settings.data} isAdmin={isAdmin} onSaved={settings.reload} />}
      <GitCard isAdmin={isAdmin} canPull={atLeast(me, "developer")} />
      {isAdmin && <ApiTokensCard available={Boolean(settings.data?.available)} />}
    </>
  );
}

function EnvironmentsCard({ settings, isAdmin, onSaved }: { settings: CicdSettings; isAdmin: boolean; onSaved: () => void }) {
  const { t } = useI18n();
  const [error, setError] = useState<string>();
  const save = async (change: Partial<CicdSettings>) => {
    setError(undefined);
    try {
      await api("/api/cicd/settings", { method: "PUT", body: { environments: settings.environments, requireApproval: settings.requireApproval, ...change } });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <h2>{t("cicd.envTitle")}</h2>
      <p className="muted">{t("cicd.envHelp")}</p>
      <ErrorBanner error={error} />
      <label className="toggle">
        <input type="checkbox" disabled={!isAdmin || !settings.available} checked={settings.environments} onChange={(e) => void save({ environments: e.target.checked })} />
        <strong>{t("cicd.envOn")}</strong>
      </label>
      <label className="toggle">
        <input type="checkbox" disabled={!isAdmin || !settings.environments} checked={settings.requireApproval} onChange={(e) => void save({ requireApproval: e.target.checked })} />
        {t("cicd.requireApproval")}
      </label>
      <p className="muted small">{t("cicd.envPcs")}</p>
    </div>
  );
}

function GitCard({ isAdmin, canPull }: { isAdmin: boolean; canPull: boolean }) {
  const { t, timeAgo } = useI18n();
  const { data, reload } = usePoll<GitSettingsView>("/api/git/settings", 0);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ url: "", branch: "main", folder: "workflows", username: "", token: "", autoPublish: true });
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data?.connected) {
      setForm({ url: data.url ?? "", branch: data.branch ?? "main", folder: data.folder ?? "", username: data.username ?? "", token: "", autoPublish: data.autoPublish ?? true });
    }
  }, [data]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setInfo(undefined);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const save = () =>
    run(async () => {
      await api("/api/git/settings", { method: "PUT", body: { ...form, token: form.token || undefined } });
      setEditing(false);
      setInfo(t("cicd.gitConnected"));
    });
  const disconnect = () =>
    run(async () => {
      if (!confirm(t("cicd.gitDisconnectConfirm"))) return;
      await api("/api/git/settings", { method: "DELETE" });
    });
  const pull = (publish: boolean) =>
    run(async () => {
      const r = await api<{ created: string[]; updated: string[]; unchanged: number; published: string[]; errors: Array<{ path: string; error: string }> }>("/api/git/pull", {
        method: "POST",
        body: { publish },
      });
      setInfo(t("cicd.pulled", { created: r.created.length, updated: r.updated.length, unchanged: r.unchanged }));
      if (r.errors.length) setError(r.errors.map((e) => `${e.path}: ${e.error}`).join("\n"));
    });

  if (!data) return null;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm({ ...form, [key]: value });

  return (
    <div className="card">
      <h2>{t("cicd.gitTitle")}</h2>
      <p className="muted">{t("cicd.gitHelp")}</p>
      <ErrorBanner error={error} />
      {info && <p className="notice">{info}</p>}
      {data.connected && !editing ? (
        <>
          <div className="field">
            <span>{t("cicd.gitRepo")}</span>
            <code className="copyable">{data.url}</code>
            <span className="muted small">
              {t("cicd.gitBranchFolder", { branch: data.branch ?? "", folder: data.folder || "/" })}
              {data.lastSync && ` · ${t("cicd.gitLastSync", { time: timeAgo(data.lastSync.at) })}`}
            </span>
            {data.lastSync?.error && <span className="error-text small">{data.lastSync.error}</span>}
          </div>
          {isAdmin && data.webhookUrl && (
            <div className="sso-box">
              <strong>{t("cicd.webhookTitle")}</strong>
              <span className="muted small">{t("cicd.webhookHelp")}</span>
              <span className="small">{t("cicd.webhookUrl")}</span>
              <code className="copyable">{data.webhookUrl}</code>
              <span className="small">{t("cicd.webhookSecret")}</span>
              <code className="copyable">{data.webhookSecret}</code>
            </div>
          )}
          <div className="actions">
            {canPull && (
              <>
                <button className="btn-ghost" disabled={busy} onClick={() => void pull(false)}>
                  {t("cicd.pull")}
                </button>
                <button className="btn-ghost" disabled={busy} onClick={() => void pull(true)}>
                  {t("cicd.pullPublish")}
                </button>
              </>
            )}
            {isAdmin && (
              <>
                <button className="btn-ghost" onClick={() => setEditing(true)}>
                  {t("common.edit")}
                </button>
                <button className="btn-ghost danger" onClick={() => void disconnect()}>
                  {t("cicd.gitDisconnect")}
                </button>
              </>
            )}
          </div>
        </>
      ) : isAdmin && data.available ? (
        editing || !data.connected ? (
          <>
            <label className="field">
              <span>{t("cicd.gitRepo")}</span>
              <input value={form.url} placeholder="https://github.com/acme/automations.git" onChange={(e) => set("url", e.target.value)} />
            </label>
            <div className="seat-grid">
              <label className="field">
                <span>{t("cicd.gitBranch")}</span>
                <input value={form.branch} onChange={(e) => set("branch", e.target.value)} />
              </label>
              <label className="field">
                <span>{t("cicd.gitFolder")}</span>
                <input value={form.folder} onChange={(e) => set("folder", e.target.value)} />
              </label>
            </div>
            <label className="field">
              <span>{t("cicd.gitUsername")}</span>
              <input value={form.username} autoComplete="off" onChange={(e) => set("username", e.target.value)} />
            </label>
            <label className="field">
              <span>{t("cicd.gitToken")}</span>
              <input type="password" autoComplete="off" value={form.token} placeholder={data.tokenSet ? t("security.ssoSecretSaved") : ""} onChange={(e) => set("token", e.target.value)} />
            </label>
            <p className="muted small">{t("cicd.gitTokenHelp")}</p>
            <label className="toggle">
              <input type="checkbox" checked={form.autoPublish} onChange={(e) => set("autoPublish", e.target.checked)} />
              {t("cicd.gitAutoPublish")}
            </label>
            <div className="actions">
              <button className="btn" disabled={busy || !form.url.trim()} onClick={() => void save()}>
                {data.connected ? t("common.save") : t("cicd.gitConnect")}
              </button>
              {editing && (
                <button className="btn-ghost" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
                </button>
              )}
            </div>
          </>
        ) : null
      ) : (
        <p className="muted">{t("cicd.gitNotConnected")}</p>
      )}
    </div>
  );
}

const TOKEN_ROLES: ApiToken["role"][] = ["developer", "operator", "viewer"];

function ApiTokensCard({ available }: { available: boolean }) {
  const { t, timeAgo } = useI18n();
  const { data, reload } = usePoll<ApiToken[]>("/api/api-tokens", 0);
  const [name, setName] = useState("");
  const [role, setRole] = useState<ApiToken["role"]>("developer");
  const [days, setDays] = useState("365");
  const [created, setCreated] = useState<ApiToken>();
  const [error, setError] = useState<string>();

  const create = async () => {
    setError(undefined);
    try {
      const token = await api<ApiToken>("/api/api-tokens", { method: "POST", body: { name: name.trim(), role, expiresInDays: days ? Number(days) : undefined } });
      setCreated(token);
      setName("");
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revoke = async (token: ApiToken) => {
    if (!confirm(t("cicd.tokenRevokeConfirm", { name: token.name }))) return;
    await api(`/api/api-tokens/${token.id}`, { method: "DELETE" }).catch((e: Error) => setError(e.message));
    reload();
  };

  return (
    <div className="card">
      <h2>{t("cicd.tokensTitle")}</h2>
      <p className="muted">{t("cicd.tokensHelp")}</p>
      <ErrorBanner error={error} />
      {created?.token && (
        <div className="sso-box">
          <strong>{t("cicd.tokenCreated", { name: created.name })}</strong>
          <code className="copyable">{created.token}</code>
          <span className="muted small">{t("cicd.tokenOnce")}</span>
          <button className="btn-ghost" onClick={() => void navigator.clipboard?.writeText(created.token!)}>
            {t("common.copy")}
          </button>
        </div>
      )}
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("users.role")}</th>
              <th>{t("cicd.tokenLastUsed")}</th>
              <th>{t("cicd.tokenExpires")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((x) => (
              <tr key={x.id}>
                <td>
                  <strong>{x.name}</strong>
                  <div className="muted small">{x.createdBy}</div>
                </td>
                <td>{t(`role.${x.role}` as MessageKey)}</td>
                <td>{x.lastUsedAt ? timeAgo(x.lastUsedAt) : t("users.never")}</td>
                <td>{x.expiresAt ? new Date(x.expiresAt).toLocaleDateString() : "-"}</td>
                <td className="row-actions">
                  <button className="btn-ghost danger" onClick={() => void revoke(x)}>
                    {t("cicd.tokenRevoke")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {available && (
        <div className="seat-grid">
          <label className="field">
            <span>{t("common.name")}</span>
            <input value={name} placeholder="GitHub Actions" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("users.role")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value as ApiToken["role"])}>
              {TOKEN_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t("cicd.tokenDays")}</span>
            <input type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} />
          </label>
          <div className="field">
            <span>&nbsp;</span>
            <button className="btn" disabled={!name.trim()} onClick={() => void create()}>
              {t("cicd.tokenCreate")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
