import { useI18n } from "@zamtest/i18n/react";
import { useState } from "react";
import { api } from "../api";
import type { Asset } from "../api";
import { usePoll } from "../hooks";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";

export function Assets() {
  const { t, timeAgo } = useI18n();
  const { data, error, reload } = usePoll<Asset[]>("/api/assets", 0);
  const [editing, setEditing] = useState<Partial<Asset> | null>(null);

  const remove = async (a: Asset) => {
    if (!confirm(t("assets.confirmDelete", { name: a.name }))) return;
    await api(`/api/assets/${a.id}`, { method: "DELETE" });
    reload();
  };

  const typeLabel = (type: Asset["type"]) =>
    ({ text: t("assets.typeText"), number: t("assets.typeNumber"), boolean: t("assets.typeBoolean"), credential: t("assets.typeCredential") })[type];

  const show = (a: Asset) => {
    if (a.type === "credential") return `${(a.value as { username?: string }).username ?? ""} / ********`;
    return String(a.value);
  };

  return (
    <>
      <PageHeader
        title={t("assets.title")}
        subtitle={t("assets.subtitle")}
        actions={
          <button className="btn" onClick={() => setEditing({ type: "text", value: "" })}>
            {t("assets.new")}
          </button>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              <th>{t("common.type")}</th>
              <th>{t("common.value")}</th>
              <th>{t("common.updated")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.name}</strong>
                  {a.description && <div className="muted">{a.description}</div>}
                </td>
                <td>{typeLabel(a.type)}</td>
                <td>
                  <code>{show(a)}</code>
                </td>
                <td>{timeAgo(a.updatedAt)}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => setEditing(a)}>
                    {t("common.edit")}
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(a)}>
                    {t("common.delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("assets.empty")}</Empty>
      )}
      {editing && (
        <AssetModal
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

function AssetModal({ initial, onClose, onSaved }: { initial: Partial<Asset>; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<Partial<Asset>>(initial);
  const [error, setError] = useState<string>();
  const cred = (form.value ?? {}) as { username?: string; password?: string };

  const save = async () => {
    let value = form.value;
    if (form.type === "number") value = Number(value);
    if (form.type === "boolean") value = value === true || value === "true";
    const body = { name: form.name, type: form.type, value, description: form.description };
    try {
      if (initial.id) await api(`/api/assets/${initial.id}`, { method: "PUT", body });
      else await api("/api/assets", { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={initial.id ? t("assets.editTitle", { name: initial.name ?? "" }) : t("assets.newTitle")}
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
        <input value={form.name ?? ""} disabled={Boolean(initial.id)} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label={t("common.type")}>
        <select
          value={form.type}
          onChange={(e) => {
            const type = e.target.value as Asset["type"];
            setForm({ ...form, type, value: type === "credential" ? { username: "", password: "" } : "" });
          }}
        >
          <option value="text">{t("assets.typeText")}</option>
          <option value="number">{t("assets.typeNumber")}</option>
          <option value="boolean">{t("assets.typeBoolean")}</option>
          <option value="credential">{t("assets.typeCredential")}</option>
        </select>
      </Field>
      {form.type === "credential" ? (
        <>
          <Field label={t("assets.username")}>
            <input value={cred.username ?? ""} onChange={(e) => setForm({ ...form, value: { ...cred, username: e.target.value } })} />
          </Field>
          <Field label={t("assets.password")} hint={initial.id ? t("assets.passwordKeep") : undefined}>
            <input type="password" value={cred.password ?? ""} onChange={(e) => setForm({ ...form, value: { ...cred, password: e.target.value } })} />
          </Field>
        </>
      ) : form.type === "boolean" ? (
        <Field label={t("common.value")}>
          <select value={String(form.value)} onChange={(e) => setForm({ ...form, value: e.target.value })}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </Field>
      ) : (
        <Field label={t("common.value")}>
          <input value={String(form.value ?? "")} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        </Field>
      )}
      <Field label={t("common.description")}>
        <input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
    </Modal>
  );
}
