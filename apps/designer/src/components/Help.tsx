import { useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { HelpCenter } from "@zamtest/help";
import { api } from "../api";

/** "?": the docs and the help assistant in a panel at the side, next to the work. */
export function HelpButton({ where }: { where: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn-ghost help-btn" title={t("help.title")} aria-label={t("help.title")} onClick={() => setOpen(!open)}>
        ? {t("help.button")}
      </button>
      {open && (
        <div className="help-drawer" role="dialog" aria-label={t("help.title")}>
          <div className="help-drawer-head">
            <strong>{t("help.title")}</strong>
            <button className="icon-btn" onClick={() => setOpen(false)} aria-label={t("common.close")}>
              ×
            </button>
          </div>
          <HelpCenter api={api} layout="panel" where={where} />
        </div>
      )}
    </>
  );
}
