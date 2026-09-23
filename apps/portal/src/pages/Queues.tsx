import { useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import type { Queue, QueueItem, QueueItemStatus } from "../api";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import { Empty, ErrorBanner, Field, Modal, PageHeader } from "../ui";

const STATUSES: QueueItemStatus[] = ["new", "in-progress", "successful", "failed", "business-exception"];
const BADGE: Record<QueueItemStatus, string> = {
  new: "pending",
  "in-progress": "running",
  successful: "succeeded",
  failed: "failed",
  "business-exception": "cancelling",
};

function StatusBadge({ status }: { status: QueueItemStatus }) {
  const { t } = useI18n();
  return <span className={`badge badge-${BADGE[status]}`}>{t(`queueStatus.${status}` as MessageKey)}</span>;
}

export function Queues() {
  const { t } = useI18n();
  const me = useMe();
  const { data, error, reload } = usePoll<Queue[]>("/api/queues", 5000);
  const [editing, setEditing] = useState<Partial<Queue> | null>(null);
  const [adding, setAdding] = useState<Queue | null>(null);

  const remove = async (q: Queue) => {
    if (!confirm(t("queues.confirmDelete", { name: q.name }))) return;
    await api(`/api/queues/${q.id}`, { method: "DELETE" }).catch(() => undefined);
    reload();
  };

  return (
    <>
      <PageHeader
        title={t("queues.title")}
        subtitle={t("queues.subtitle")}
        actions={
          atLeast(me, "developer") && (
            <button className="btn" onClick={() => setEditing({ maxRetries: 2 })}>
              {t("queues.new")}
            </button>
          )
        }
      />
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("common.name")}</th>
              {STATUSES.map((s) => (
                <th key={s}>{t(`queueStatus.${s}` as MessageKey)}</th>
              ))}
              <th>{t("queues.maxRetries")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((q) => (
              <tr key={q.id} className="clickable" onClick={() => (window.location.hash = `/queues/${q.id}`)}>
                <td>
                  <strong>{q.name}</strong>
                  {q.description && <div className="muted">{q.description}</div>}
                </td>
                {STATUSES.map((s) => (
                  <td key={s} className={q.counts[s] ? "" : "muted"}>
                    {q.counts[s]}
                  </td>
                ))}
                <td>{q.maxRetries}</td>
                <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {atLeast(me, "operator") && (
                    <button className="btn-ghost" onClick={() => setAdding(q)}>
                      {t("queues.addItem")}
                    </button>
                  )}
                  {atLeast(me, "developer") && (
                    <>
                      <button className="btn-ghost" onClick={() => setEditing(q)}>
                        {t("common.edit")}
                      </button>
                      <button className="btn-ghost danger" onClick={() => void remove(q)}>
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
        <Empty>{t("queues.empty")}</Empty>
      )}
      {editing && (
        <QueueModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {adding && (
        <AddItemModal
          queue={adding}
          onClose={() => setAdding(null)}
          onSaved={() => {
            setAdding(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function QueueModal({ initial, onClose, onSaved }: { initial: Partial<Queue>; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState<Partial<Queue>>(initial);
  const [error, setError] = useState<string>();

  const save = async () => {
    const body = { name: form.name, description: form.description || undefined, maxRetries: Number(form.maxRetries ?? 2) };
    try {
      if (initial.id) await api(`/api/queues/${initial.id}`, { method: "PUT", body });
      else await api("/api/queues", { method: "POST", body });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={initial.id ? t("queues.editTitle", { name: initial.name ?? "" }) : t("queues.newTitle")}
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
      <Field label={t("common.description")}>
        <input value={form.description ?? ""} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field label={t("queues.maxRetries")} hint={t("queues.maxRetriesHint")}>
        <input type="number" min={0} max={10} value={form.maxRetries ?? 2} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} />
      </Field>
    </Modal>
  );
}

function AddItemModal({ queue, onClose, onSaved }: { queue: Queue; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [reference, setReference] = useState("");
  const [data, setData] = useState("{\n  \n}");
  const [error, setError] = useState<string>();

  const save = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      setError(t("queues.invalidJson"));
      return;
    }
    try {
      await api(`/api/queues/${queue.id}/items`, { method: "POST", body: { data: parsed, reference: reference.trim() || undefined } });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal
      title={t("queues.addItemTitle", { name: queue.name })}
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
      <Field label={t("queues.reference")} hint={t("queues.referenceHint")}>
        <input value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
      <Field label={t("queues.data")}>
        <textarea className="mono" rows={8} value={data} onChange={(e) => setData(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function QueueDetail({ id }: { id: string }) {
  const { t, timeAgo } = useI18n();
  const me = useMe();
  const [status, setStatus] = useState("");
  const queues = usePoll<Queue[]>("/api/queues", 5000);
  const items = usePoll<QueueItem[]>(`/api/queues/${id}/items${status ? `?status=${status}` : ""}`, 3000);
  const [adding, setAdding] = useState(false);
  const queue = queues.data?.find((q) => q.id === id);

  const act = async (path: string, method: string) => {
    await api(path, { method }).catch(() => undefined);
    items.reload();
    queues.reload();
  };

  return (
    <>
      <PageHeader
        title={queue?.name ?? t("queues.title")}
        subtitle={queue?.description}
        actions={
          <>
            <a className="btn-ghost" href="#/queues">
              {t("queues.backToAll")}
            </a>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("queues.allItems")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`queueStatus.${s}` as MessageKey)}
                </option>
              ))}
            </select>
            {queue && atLeast(me, "operator") && (
              <button className="btn" onClick={() => setAdding(true)}>
                {t("queues.addItem")}
              </button>
            )}
          </>
        }
      />
      <ErrorBanner error={items.error} />
      {items.data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("queues.reference")}</th>
              <th>{t("common.status")}</th>
              <th>{t("queues.data")}</th>
              <th>{t("queues.retries")}</th>
              <th>{t("queues.message")}</th>
              <th>{t("common.created")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.data.map((i) => (
              <tr key={i.id}>
                <td>{i.reference ?? <span className="muted">{i.id}</span>}</td>
                <td>
                  <StatusBadge status={i.status} />
                </td>
                <td>
                  <code className="data-cell">{JSON.stringify(i.data)}</code>
                </td>
                <td>{i.retries}</td>
                <td>{i.message}</td>
                <td>{timeAgo(i.createdAt)}</td>
                <td className="row-actions">
                  {i.jobId && <a href={`#/jobs/${i.jobId}`}>{t("jobs.job")}</a>}
                  {(i.status === "failed" || i.status === "business-exception") && atLeast(me, "operator") && (
                    <button className="btn-ghost" onClick={() => void act(`/api/queue-items/${i.id}/retry`, "POST")}>
                      {t("queues.retry")}
                    </button>
                  )}
                  {atLeast(me, "developer") && i.status !== "in-progress" && (
                    <button className="btn-ghost danger" onClick={() => void act(`/api/queue-items/${i.id}`, "DELETE")}>
                      {t("common.delete")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{t("queues.noItems")}</Empty>
      )}
      {adding && queue && (
        <AddItemModal
          queue={queue}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            items.reload();
            queues.reload();
          }}
        />
      )}
    </>
  );
}
