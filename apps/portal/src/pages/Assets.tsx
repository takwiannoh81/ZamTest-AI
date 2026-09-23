import { useState } from "react";
import { api } from "../api";
import type { Asset } from "../api";
import { timeAgo, usePoll } from "../hooks";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";

export function Assets() {
  const { data, error, reload } = usePoll<Asset[]>("/api/assets", 0);
  const [editing, setEditing] = useState<Partial<Asset> | null>(null);

  const remove = async (a: Asset) => {
    if (!confirm(`Delete asset ${a.name}?`)) return;
    await api(`/api/assets/${a.id}`, { method: "DELETE" });
    reload();
  };

  const show = (a: Asset) => {
    if (a.type === "credential") return `${(a.value as { username?: string }).username ?? ""} / ********`;
    return String(a.value);
  };

  return (
    <>
      <PageHeader
        title="Assets"
        subtitle="Shared configuration and credentials used by automations (read with the Get Asset action)"
        actions={
          <button className="btn" onClick={() => setEditing({ type: "text", value: "" })}>
            + New asset
          </button>
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Value</th>
              <th>Updated</th>
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
                <td>{a.type}</td>
                <td>
                  <code>{show(a)}</code>
                </td>
                <td>{timeAgo(a.updatedAt)}</td>
                <td className="row-actions">
                  <button className="btn-ghost" onClick={() => setEditing(a)}>
                    Edit
                  </button>
                  <button className="btn-ghost danger" onClick={() => void remove(a)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>No assets yet.</Empty>
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
      title={initial.id ? `Edit ${initial.name}` : "New asset"}
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
        <input value={form.name ?? ""} disabled={Boolean(initial.id)} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="Type">
        <select
          value={form.type}
          onChange={(e) => {
            const type = e.target.value as Asset["type"];
            setForm({ ...form, type, value: type === "credential" ? { username: "", password: "" } : "" });
          }}
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="credential">Credential</option>
        </select>
      </Field>
      {form.type === "credential" ? (
        <>
          <Field label="Username">
            <input value={cred.username ?? ""} onChange={(e) => setForm({ ...form, value: { ...cred, username: e.target.value } })} />
          </Field>
          <Field label="Password" hint={initial.id ? "Leave as ******** to keep the current password" : undefined}>
            <input type="password" value={cred.password ?? ""} onChange={(e) => setForm({ ...form, value: { ...cred, password: e.target.value } })} />
          </Field>
        </>
      ) : form.type === "boolean" ? (
        <Field label="Value">
          <select value={String(form.value)} onChange={(e) => setForm({ ...form, value: e.target.value })}>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </Field>
      ) : (
        <Field label="Value">
          <input value={String(form.value ?? "")} onChange={(e) => setForm({ ...form, value: e.target.value })} />
        </Field>
      )}
      <Field label="Description">
        <input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
    </Modal>
  );
}
