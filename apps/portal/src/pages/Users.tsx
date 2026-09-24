import { useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import type { User } from "../api";
import { usePoll } from "../hooks";
import { useMe } from "../session";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";

const ROLES: User["role"][] = ["admin", "developer", "operator", "viewer"];

export function Users() {
  const { t, timeAgo } = useI18n();
  const me = useMe();
  const { data, error, reload } = usePoll<User[]>("/api/users", 0);
  const [editing, setEditing] = useState<Partial<User> | null>(null);
  const [actionError, setActionError] = useState<string>();

  const act = async (fn: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title={t("users.title")}
        subtitle={t("users.subtitle")}
        actions={
          <button className="btn" onClick={() => setEditing({ role: "developer" })}>
            {t("users.new")}
          </button>
        }
      />
      {me?.kind === "token" && <div className="notice">{t("users.tokenNotice")}</div>}
      <ErrorBanner error={error ?? actionError} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("auth.email")}</th>
              <th>{t("users.role")}</th>
              <th>{t("common.status")}</th>
              <th>{t("users.lastLogin")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td>
                  <strong>{u.name}</strong>
                  {u.id === me?.id && <span className="muted"> ({t("users.you")})</span>}
                </td>
                <td>{u.email}</td>
                <td>
                  <span className="role-badge">{t(`role.${u.role}` as MessageKey)}</span>
                  {u.authSource === "sso" && <span className="role-badge">{t("users.sso")}</span>}
                  {u.platformOwner && <span className="role-badge owner-badge">{t("users.platformOwner")}</span>}
                </td>
                <td>{u.disabled ? t("users.disabled") : t("users.active")}</td>
                <td>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : t("users.never")}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => setEditing(u)}>
                    {t("common.edit")}
                  </button>
                  {u.id !== me?.id && (
                    <>
                      <button className="btn-ghost" onClick={() => void act(() => api(`/api/users/${u.id}`, { method: "PUT", body: { disabled: !u.disabled } }))}>
                        {u.disabled ? t("users.enable") : t("users.disable")}
                      </button>
                      {u.mfaEnabled && (
                        <button
                          className="btn-ghost"
                          onClick={() => confirm(t("users.confirmResetMfa", { name: u.name })) && void act(() => api(`/api/users/${u.id}/mfa/reset`, { method: "POST" }))}
                        >
                          {t("users.resetMfa")}
                        </button>
                      )}
                      <button
                        className="btn-ghost danger"
                        onClick={() => confirm(t("users.confirmDelete", { name: u.name })) && void act(() => api(`/api/users/${u.id}`, { method: "DELETE" }))}
                      >
                        {t("common.delete")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("users.empty")}</Empty>
      )}
      <section className="roles-legend">
        {ROLES.map((r) => (
          <div key={r}>
            <span className="role-badge">{t(`role.${r}` as MessageKey)}</span> <span className="muted">{t(`role.${r}Help` as MessageKey)}</span>
          </div>
        ))}
      </section>
      {editing && (
        <UserModal
          initial={editing}
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

function UserModal({ initial, onClose, onSaved }: { initial: Partial<User>; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const me = useMe();
  const [form, setForm] = useState<Partial<User> & { password?: string }>(initial);
  const [error, setError] = useState<string>();
  // Only the platform owner hands platform ownership on, to admins of the platform's own workspace.
  const canGrantOwner = Boolean(me?.platformAdmin && initial.id && me.workspace.id === "ws_default");

  const save = async () => {
    const body = {
      email: form.email,
      name: form.name,
      role: form.role,
      password: form.password || undefined,
      ...(canGrantOwner && Boolean(form.platformOwner) !== Boolean(initial.platformOwner) ? { platformOwner: Boolean(form.platformOwner) } : {}),
    };
    try {
      if (initial.id) await api(`/api/users/${initial.id}`, { method: "PUT", body });
      else await api("/api/users", { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={initial.id ? t("users.editTitle", { name: initial.name ?? "" }) : t("users.newTitle")}
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
      <Field label={t("auth.email")}>
        <input type="email" value={form.email ?? ""} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </Field>
      <Field label={t("users.role")} hint={form.role ? t(`role.${form.role}Help` as MessageKey) : undefined}>
        <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as User["role"] })}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`role.${r}` as MessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("auth.password")} hint={initial.id ? `${t("users.passwordHint")} ${t("users.passwordKeep")}` : t("users.passwordHint")}>
        <input type="password" autoComplete="new-password" value={form.password ?? ""} onChange={(e) => setForm({ ...form, password: e.target.value })} />
      </Field>
      {canGrantOwner && form.role === "admin" && (
        <>
          <label className="toggle">
            <input
              type="checkbox"
              checked={Boolean(form.platformOwner)}
              disabled={initial.id === me?.id}
              onChange={(e) => setForm({ ...form, platformOwner: e.target.checked })}
            />
            <strong>{t("users.platformOwner")}</strong>
          </label>
          <p className="muted small">{t("users.platformOwnerHelp")}</p>
        </>
      )}
    </Modal>
  );
}
