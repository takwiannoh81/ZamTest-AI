import { useI18n } from "@zamtest/i18n/react";
import type { MessageKey } from "@zamtest/i18n";
import { useEffect, useMemo, useState } from "react";
import { api, BASE } from "../api";
import type { DocumentTask, DocumentTaskSummary } from "../api";
import { usePoll } from "../hooks";
import { atLeast, useMe } from "../session";
import { Empty, ErrorBanner, PageHeader } from "../ui";

const statusClass: Record<DocumentTask["status"], string> = { pending: "pending", approved: "succeeded", rejected: "failed", auto: "online" };

/** The list: documents waiting for a person, and the ones done. */
export function Reviews() {
  const { t, timeAgo } = useI18n();
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const { data, error } = usePoll<DocumentTaskSummary[]>(`/api/documents?status=${tab}`, 10_000);
  return (
    <>
      <PageHeader title={t("reviews.title")} subtitle={t("reviews.subtitle")} />
      <div className="segmented">
        <button className={tab === "pending" ? "active" : ""} onClick={() => setTab("pending")}>
          {t("reviews.toReview")}
        </button>
        <button className={tab === "done" ? "active" : ""} onClick={() => setTab("done")}>
          {t("reviews.done")}
        </button>
      </div>
      <ErrorBanner error={error} />
      {data?.length ? (
        <table>
          <thead>
            <tr>
              <th>{t("reviews.document")}</th>
              <th>{t("common.process")}</th>
              <th>{tab === "pending" ? t("reviews.toCheck") : t("common.status")}</th>
              <th>{tab === "pending" ? t("reviews.received") : t("reviews.reviewedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => (window.location.hash = `/reviews/${d.id}`)}>
                <td>
                  <a href={`#/reviews/${d.id}`}>
                    <strong>{d.title || d.name}</strong>
                  </a>
                  <div className="muted small">{d.summary}</div>
                </td>
                <td>{d.processName ?? "-"}</td>
                <td>
                  {tab === "pending" ? (
                    d.unsure.length ? (
                      <span className="warn-text">{d.unsure.join(", ")}</span>
                    ) : (
                      t("reviews.allFields")
                    )
                  ) : (
                    <span className={`badge badge-${statusClass[d.status]}`}>{t(`reviews.status.${d.status}` as MessageKey)}</span>
                  )}
                </td>
                <td>{tab === "pending" ? timeAgo(d.createdAt) : d.reviewedBy ? `${d.reviewedBy.replace(/ <.*>$/, "")} · ${timeAgo(d.reviewedAt)}` : timeAgo(d.doneAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{tab === "pending" ? t("reviews.nothingToReview") : t("reviews.noneDone")}</Empty>
      )}
    </>
  );
}

/** The document next to its fields; the reviewer corrects them, then approves or rejects. */
export function ReviewDetail({ id }: { id: string }) {
  const { t, dateTime } = useI18n();
  const me = useMe();
  const canDecide = atLeast(me, "operator");
  const [doc, setDoc] = useState<DocumentTask>();
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [comment, setComment] = useState("");
  const [fileUrl, setFileUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<DocumentTask>(`/api/documents/${id}`)
      .then((d) => {
        setDoc(d);
        const shown = d.final ?? d.result.fields;
        setValues(Object.fromEntries(d.fields.map((f) => [f.name, f.type === "boolean" ? Boolean(shown[f.name]) : shown[f.name] === null || shown[f.name] === undefined ? "" : String(shown[f.name])])));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  // The file, as a local copy the page can show (the Portal does not allow itself in frames).
  useEffect(() => {
    if (!doc?.hasFile) return;
    let url: string | undefined;
    fetch(`${BASE}/api/documents/${id}/file`, { credentials: "include" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => setFileUrl((url = URL.createObjectURL(blob))))
      .catch((e: Error) => setError(e.message));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [doc?.hasFile, id]);

  const unsure = useMemo(() => new Set(doc?.unsure ?? []), [doc]);
  if (!doc) return <div>{error ? <ErrorBanner error={error} /> : t("common.loading")}</div>;
  const pending = doc.status === "pending";

  const decide = async (decision: "approve" | "reject") => {
    if (decision === "reject" && !comment.trim()) {
      setError(t("reviews.rejectNeedsReason"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api(`/api/documents/${id}/${decision}`, { method: "POST", body: { fields: values, comment: comment.trim() || undefined } });
      // On to the next document waiting, if there is one.
      const next = (await api<DocumentTaskSummary[]>("/api/documents?status=pending")).find((d) => d.id !== id);
      window.location.hash = next ? `/reviews/${next.id}` : "/reviews";
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const confidence = (name: string) => {
    const c = doc.result.confidence[name];
    const missing = doc.result.fields[name] === null;
    const low = unsure.has(name);
    return (
      <span className={`conf ${missing ? "missing" : low ? "low" : "ok"}`} title={t("reviews.confidenceHint")}>
        {missing ? t("reviews.notFound") : `${Math.round((c ?? 0) * 100)}%`}
      </span>
    );
  };

  return (
    <>
      <PageHeader
        title={doc.title || doc.name}
        subtitle={`${doc.result.documentType} · ${doc.result.summary}`}
        actions={
          <a className="btn-ghost" href="#/reviews">
            ← {t("reviews.title")}
          </a>
        }
      />
      <ErrorBanner error={error} />
      {!pending && (
        <div className="notice">
          {doc.status === "auto"
            ? t("reviews.wasAuto")
            : t(doc.status === "approved" ? "reviews.wasApproved" : "reviews.wasRejected", { name: doc.reviewedBy?.replace(/ <.*>$/, "") ?? "?", time: doc.reviewedAt ? dateTime(doc.reviewedAt) : "?" })}
          {doc.comment && ` · "${doc.comment}"`}
          {doc.thenJobId && (
            <>
              {" · "}
              <a href={`#/jobs/${doc.thenJobId}`}>{t("reviews.openJob")}</a>
            </>
          )}
          {doc.thenError && <span className="warn-text"> · {doc.thenError}</span>}
        </div>
      )}
      <div className="review">
        <div className="review-doc">
          {!doc.hasFile ? (
            <Empty>{t("reviews.fileGone")}</Empty>
          ) : !fileUrl ? (
            <div className="muted">{t("common.loading")}</div>
          ) : doc.mediaType === "application/pdf" ? (
            <iframe title={doc.name} src={fileUrl} />
          ) : (
            <img alt={doc.name} src={fileUrl} />
          )}
          <div className="muted small">
            {doc.name} · {Math.max(1, Math.round(doc.size / 1024))} KB{doc.processName ? ` · ${doc.processName}` : ""} · {dateTime(doc.createdAt)}
          </div>
        </div>
        <form
          className="review-fields"
          onSubmit={(e) => {
            e.preventDefault();
            if (pending && canDecide && !busy) void decide("approve");
          }}
        >
          {pending && doc.unsure.length > 0 && <p className="warn-text small">{t("reviews.checkThese", { fields: doc.unsure.join(", ") })}</p>}
          {doc.fields.map((f) => {
            const value = values[f.name];
            const changed = doc.corrected?.includes(f.name);
            return (
              <label key={f.name} className={`review-field${unsure.has(f.name) ? " unsure" : ""}`}>
                <span className="review-label">
                  <strong>{f.name}</strong>
                  <span className="muted small">{t(`reviews.type.${f.type}` as MessageKey)}</span>
                  {confidence(f.name)}
                  {changed && <span className="badge">{t("reviews.corrected")}</span>}
                </span>
                {f.type === "boolean" ? (
                  <input type="checkbox" checked={Boolean(value)} disabled={!pending || !canDecide} onChange={(e) => setValues({ ...values, [f.name]: e.target.checked })} />
                ) : (
                  <input
                    type={f.type === "date" ? "date" : "text"}
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    value={String(value ?? "")}
                    readOnly={!pending || !canDecide}
                    onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  />
                )}
                {(f.description || doc.result.evidence[f.name]) && (
                  <span className="muted small">
                    {f.description}
                    {f.description && doc.result.evidence[f.name] ? " · " : ""}
                    {doc.result.evidence[f.name] && t("reviews.onDocument", { text: doc.result.evidence[f.name]! })}
                  </span>
                )}
              </label>
            );
          })}
          {pending && canDecide ? (
            <>
              <label className="review-field">
                <span className="review-label">
                  <strong>{t("reviews.comment")}</strong>
                </span>
                <textarea rows={2} value={comment} placeholder={t("reviews.commentPlaceholder")} onChange={(e) => setComment(e.target.value)} />
              </label>
              <div className="review-actions">
                <button type="submit" className="btn" disabled={busy}>
                  ✓ {t("reviews.approve")}
                </button>
                <button type="button" className="btn-ghost danger" disabled={busy} onClick={() => void decide("reject")}>
                  {t("reviews.reject")}
                </button>
                <span className="muted small">{t("reviews.enterHint")}</span>
              </div>
            </>
          ) : (
            pending && <p className="muted small">{t("reviews.cannotDecide")}</p>
          )}
        </form>
      </div>
    </>
  );
}
