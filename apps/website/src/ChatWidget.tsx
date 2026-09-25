import { useEffect, useState } from "react";
import { useI18n } from "@zamtest/i18n/react";
import { HelpChat } from "@zamtest/help";
import type { HelpApi } from "@zamtest/help";

const API_URL = (import.meta.env.VITE_AGENT_SERVER_URL ?? "http://localhost:4000").replace(/\/+$/, "");
/** Closed by the visitor: not shown again during this visit. */
const DISMISSED = "zamtest.siteChatDismissed";
/** The greeting appears this long after the page opens. */
const GREETING_DELAY_MS = 5000;

/** The website's questions go to the public assistant (no account needed). */
const publicApi: HelpApi = async <T,>(_path: string, init?: { method?: string; body?: unknown }) => {
  const res = await fetch(`${API_URL}/api/public/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(init?.body ?? {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
};

const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISSED) === "1";
  } catch {
    return false;
  }
};

/**
 * Bottom left: a greeting a few seconds after the page opens ("Questions? Ask
 * me"), and a chat with the assistant, in the visitor's language.
 */
export function ChatWidget() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [greeting, setGreeting] = useState(false);

  useEffect(() => {
    if (wasDismissed()) return;
    const timer = setTimeout(() => setGreeting(true), GREETING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const dismiss = () => {
    setGreeting(false);
    try {
      sessionStorage.setItem(DISMISSED, "1");
    } catch {
      /* storage unavailable */
    }
  };

  return (
    <div className="site-chat">
      {open ? (
        <div className="site-chat-panel" role="dialog" aria-label={t("sitechat.title")}>
          <div className="site-chat-head">
            <span className="site-chat-avatar">Z</span>
            <div>
              <strong>{t("sitechat.title")}</strong>
              <small>{t("sitechat.subtitle")}</small>
            </div>
            <button className="site-chat-close" onClick={() => setOpen(false)} aria-label={t("common.close")}>
              ×
            </button>
          </div>
          <HelpChat
            api={publicApi}
            storageKey="zamtest.siteChat"
            intro={t("sitechat.intro")}
            suggestions={[t("sitechat.suggest1"), t("sitechat.suggest2"), t("sitechat.suggest3")]}
          />
        </div>
      ) : (
        <>
          {greeting && (
            <div className="site-chat-greeting" role="status">
              <button className="site-chat-greeting-text" onClick={() => { setOpen(true); dismiss(); }}>
                👋 {t("sitechat.greeting")}
              </button>
              <button className="site-chat-greeting-close" onClick={dismiss} aria-label={t("common.close")}>
                ×
              </button>
            </div>
          )}
          <button className="site-chat-launcher" onClick={() => { setOpen(true); dismiss(); }} aria-label={t("sitechat.title")}>
            💬
          </button>
        </>
      )}
    </div>
  );
}
