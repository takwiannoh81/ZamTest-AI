import { useState } from "react";
import { LanguageSelect, useI18n } from "@zamtest/i18n/react";
import { getToken, setToken } from "../api";
import { usePoll } from "../hooks";
import { Field, PageHeader } from "../ui";

export function Settings() {
  const { t } = useI18n();
  const [token, setLocal] = useState(getToken());
  const [saved, setSaved] = useState(false);
  const ai = usePoll<{ configured: boolean; model: string | null }>("/api/ai/status", 0);

  return (
    <>
      <PageHeader title={t("settings.title")} />
      <section className="card">
        <h2>{t("common.language")}</h2>
        <p className="muted">{t("settings.languageHelp")}</p>
        <LanguageSelect />
      </section>
      <section className="card">
        <h2>{t("settings.apiAccess")}</h2>
        <p className="muted">{t("settings.apiHelp")}</p>
        <Field label={t("settings.adminToken")}>
          <input type="password" value={token} onChange={(e) => setLocal(e.target.value)} />
        </Field>
        <button
          className="btn"
          onClick={() => {
            setToken(token);
            setSaved(true);
          }}
        >
          {t("common.save")}
        </button>
        {saved && <span className="muted"> {t("settings.saved")}</span>}
        {getToken() && (
          <button
            className="btn-ghost"
            style={{ marginInlineStart: 8 }}
            onClick={() => {
              setToken("");
              window.location.reload();
            }}
          >
            {t("auth.signOut")}
          </button>
        )}
      </section>
      <section className="card">
        <h2>{t("settings.ai")}</h2>
        {ai.data?.configured ? (
          <p>{t("settings.aiEnabled", { model: ai.data.model ?? "" })}</p>
        ) : (
          <p className="muted">{t("settings.aiDisabled")}</p>
        )}
      </section>
    </>
  );
}
