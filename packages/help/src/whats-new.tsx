import { useState } from "react";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import type { HelpApi } from "./index";

/** This release's news: the same cards as the website's "What's new" (translated there already). */
const ITEMS: Array<{ icon: string; key: string }> = [
  { icon: "✨", key: "genTests" },
  { icon: "🔔", key: "alerts" },
  { icon: "📊", key: "reports" },
  { icon: "🧮", key: "testData" },
  { icon: "🎯", key: "dynamic" },
  { icon: "📜", key: "audit" },
];

/**
 * "What's new", shown once after a release to people who had an account before it.
 * Closing it (either button, ×, or Esc) is remembered on the server, for the Portal
 * and the Designer on every PC.
 */
export function WhatsNew({ api, docsHref }: { api: HelpApi; docsHref: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  if (!open) return null;

  const close = () => {
    setOpen(false);
    void api("/api/auth/me/whats-new", { method: "POST" }).catch(() => undefined);
  };

  return (
    <div className="modal-backdrop" onMouseDown={close} onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="modal whats-new" role="dialog" aria-label={t("site.new.title")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🎉 {t("site.new.title")}</h2>
          <button className="icon-btn" onClick={close} aria-label={t("common.close")} autoFocus>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="whats-new-lead">{t("whatsNew.subtitle")}</p>
          <ul className="whats-new-list">
            {ITEMS.map((item) => (
              <li key={item.key}>
                <span className="whats-new-icon" aria-hidden>
                  {item.icon}
                </span>
                <div>
                  <strong>{t(`site.new.${item.key}.title` as MessageKey)}</strong>
                  <p>{t(`site.new.${item.key}.text` as MessageKey)}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="whats-new-note">{t("whatsNew.agent")}</p>
        </div>
        <div className="modal-foot">
          <a className="btn-ghost" href={docsHref} target={docsHref.startsWith("#") ? undefined : "_blank"} rel="noreferrer" onClick={close}>
            {t("whatsNew.docs")}
          </a>
          <button className="btn" onClick={close}>
            {t("whatsNew.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}
