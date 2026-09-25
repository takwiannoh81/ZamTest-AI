import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardEvent } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { currentLocale, useI18n } from "@zamtest/i18n/react";
import type { HelpApi } from "./index";
import { recentProblems } from "./problems";

type Kind = "blocking" | "annoying" | "suggestion";
interface Mine {
  id: string;
  kind: Kind;
  what: string;
  status: "new" | "investigating" | "fixed" | "wontfix";
  note?: string;
  createdAt: string;
}
interface Picture {
  name: string;
  type: string;
  base64: string;
  url: string;
}

const MAX_IMAGES = 3;
const MAX_BYTES = 4 * 1024 * 1024;

function readPicture(file: File): Promise<Picture> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name || "screenshot.png", type: file.type, base64: url.replace(/^data:[^,]*,/, ""), url });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the picture"));
    reader.readAsDataURL(file);
  });
}

/**
 * Report a problem (or suggest something): what happened, what the person was
 * doing, screenshots (attach or paste), and details that help find it, which
 * the form shows before anything is sent. Below: the person's own reports.
 */
export function ReportProblem({ api, app, where, onSent }: { api: HelpApi; app: "portal" | "designer"; where?: string; onSent?: () => void }) {
  const { t, dateTime } = useI18n();
  const [kind, setKind] = useState<Kind>("annoying");
  const [what, setWhat] = useState("");
  const [doing, setDoing] = useState("");
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [mine, setMine] = useState<Mine[]>([]);
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<Mine[]>("/api/bug-reports/mine")
      .then(setMine)
      .catch(() => undefined);
  }, [api]);
  useEffect(load, [load]);

  const context = {
    app,
    page: typeof location !== "undefined" ? location.href.split("?")[0] : undefined,
    where,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    language: currentLocale(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : undefined,
    errors: recentProblems(),
  };

  const add = async (files: File[]) => {
    setError(undefined);
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      if (f.size > MAX_BYTES) {
        setError(t("report.tooBig", { name: f.name }));
        continue;
      }
      const picture = await readPicture(f);
      setPictures((list) => (list.length >= MAX_IMAGES ? list : [...list, picture]));
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (images.length) {
      e.preventDefault();
      void add(images);
    }
  };

  const send = async () => {
    setSending(true);
    setError(undefined);
    try {
      await api("/api/bug-reports", {
        method: "POST",
        body: { kind, what: what.trim(), doing: doing.trim() || undefined, context, images: pictures.map(({ name, type, base64 }) => ({ name, type, base64 })) },
      });
      setSent(true);
      setWhat("");
      setDoing("");
      setPictures([]);
      load();
      onSent?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="report-problem" onPaste={onPaste}>
      {sent ? (
        <div className="report-sent">
          <p>✅ {t("report.thanks")}</p>
          <button className="btn-ghost" onClick={() => setSent(false)}>
            {t("report.another")}
          </button>
        </div>
      ) : (
        <>
          <div className="report-kinds" role="radiogroup" aria-label={t("report.kind")}>
            {(["blocking", "annoying", "suggestion"] as Kind[]).map((k) => (
              <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>
                {k === "blocking" ? "🔴" : k === "annoying" ? "🟠" : "💡"} {t(`report.kind.${k}` as MessageKey)}
              </button>
            ))}
          </div>
          <label className="report-field">
            <span>{kind === "suggestion" ? t("report.whatIdea") : t("report.what")}</span>
            <textarea rows={4} value={what} placeholder={t("report.whatPlaceholder")} onChange={(e) => setWhat(e.target.value)} autoFocus />
          </label>
          {kind !== "suggestion" && (
            <label className="report-field">
              <span>{t("report.doing")}</span>
              <textarea rows={3} value={doing} placeholder={t("report.doingPlaceholder")} onChange={(e) => setDoing(e.target.value)} />
            </label>
          )}
          <div className="report-pictures">
            <input ref={file} type="file" accept="image/*" multiple hidden onChange={(e) => void add(Array.from(e.target.files ?? [])).then(() => file.current && (file.current.value = ""))} />
            <button className="btn-ghost" disabled={pictures.length >= MAX_IMAGES} onClick={() => file.current?.click()}>
              📎 {t("report.attach")}
            </button>
            <span className="help-note">{t("report.paste")}</span>
            <div className="report-thumbs">
              {pictures.map((p, i) => (
                <figure key={i}>
                  <img src={p.url} alt={p.name} />
                  <button className="icon-btn" aria-label={t("common.remove")} onClick={() => setPictures(pictures.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </figure>
              ))}
            </div>
          </div>
          <details className="report-details">
            <summary>{t("report.included")}</summary>
            <ul>
              <li>{t("report.includedPage", { page: `${app}${where ? ` (${where})` : ""}` })}</li>
              <li>{t("report.includedBrowser")}</li>
              <li>{context.errors.length ? t("report.includedErrors", { count: context.errors.length }) : t("report.noErrors")}</li>
              <li>{t("report.includedAccount")}</li>
            </ul>
            {context.errors.length > 0 && (
              <pre className="report-errors">{context.errors.map((e) => `${e.time.slice(11, 19)} ${e.message}`).join("\n")}</pre>
            )}
          </details>
          {error && <p className="help-error">{error}</p>}
          <button className="btn" disabled={what.trim().length < 5 || sending} onClick={() => void send()}>
            {sending ? t("report.sending") : t("report.send")}
          </button>
        </>
      )}

      {mine.length > 0 && (
        <section className="report-mine">
          <h3>{t("report.mine")}</h3>
          <ul>
            {mine.map((r) => (
              <li key={r.id}>
                <span className={`report-status status-${r.status}`}>{t(`report.status.${r.status}` as MessageKey)}</span>
                <div>
                  <strong>{r.what.split("\n")[0]!.slice(0, 120)}</strong>
                  <div className="help-note">{dateTime(r.createdAt)}</div>
                  {r.note && <div className="report-note">💬 {r.note}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
