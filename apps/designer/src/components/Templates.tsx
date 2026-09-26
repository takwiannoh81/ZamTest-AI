import { useMemo, useState } from "react";
import { TEMPLATES, workflowFromTemplate } from "@zamtest/core";
import type { Template, TemplateCategory } from "@zamtest/core";
import type { MessageKey } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { api } from "../api";
import { ErrorBanner, Modal } from "./ui";

const CATEGORIES: Array<TemplateCategory | "all"> = ["all", "email", "data", "web", "integration", "testing"];

/**
 * The template gallery: pick a ready-made workflow or test case; it is created
 * with a translated name, and a description that says what to change.
 */
export function TemplatesModal({ onClose, onCreated }: { onClose: () => void; onCreated: (kind: Template["kind"], id: string) => void }) {
  const { t } = useI18n();
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const text = (template: Template, part: "name" | "description" | "setup") => t(`templates.${template.id}.${part}` as MessageKey);

  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    return TEMPLATES.filter((tpl) => category === "all" || tpl.category === category).filter(
      (tpl) => !words || `${text(tpl, "name")} ${text(tpl, "description")}`.toLowerCase().includes(words),
    );
  }, [category, search, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const use = async (template: Template) => {
    setBusy(template.id);
    setError(undefined);
    try {
      const name = text(template, "name");
      const definition = workflowFromTemplate(template, name, text(template, "setup"));
      const created =
        template.kind === "test"
          ? await api<{ id: string }>("/api/test-cases", { method: "POST", body: { name, definition, description: text(template, "setup") } })
          : await api<{ id: string }>("/api/workflows", { method: "POST", body: { name, description: text(template, "setup"), definition } });
      onCreated(template.kind, created.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  };

  return (
    <Modal title={`📚 ${t("templates.title")}`} onClose={onClose}>
      <p className="muted small">{t("templates.subtitle")}</p>
      <ErrorBanner error={error} />
      <div className="tpl-bar">
        <input className="tpl-search" value={search} placeholder={t("templates.search")} autoFocus onChange={(e) => setSearch(e.target.value)} />
        <div className="tpl-cats">
          {CATEGORIES.map((c) => (
            <button key={c} className={`chip${category === c ? " on" : ""}`} onClick={() => setCategory(c)}>
              {t(`templates.cat.${c}` as MessageKey)}
            </button>
          ))}
        </div>
      </div>
      {shown.length ? (
        <div className="tpl-grid">
          {shown.map((tpl) => (
            <div key={tpl.id} className="tpl-card">
              <div className="tpl-head">
                <span className="tpl-icon" aria-hidden>
                  {tpl.icon}
                </span>
                <strong>{text(tpl, "name")}</strong>
              </div>
              <p className="small">{text(tpl, "description")}</p>
              <div className="tpl-tags">
                {tpl.kind === "test" && <span className="tpl-tag">🧪 {t("templates.test")}</span>}
                {tpl.startsWith && <span className="tpl-tag">{t(`templates.startsWith.${tpl.startsWith}` as MessageKey)}</span>}
                {tpl.ai && <span className="tpl-tag ai">✨ {t("templates.ai")}</span>}
              </div>
              <button className="btn" disabled={Boolean(busy)} onClick={() => void use(tpl)}>
                {busy === tpl.id ? t("common.loading") : t("templates.use")}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">{t("templates.noMatch")}</p>
      )}
    </Modal>
  );
}
