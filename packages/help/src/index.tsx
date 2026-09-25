import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { LOCALES } from "@zamtest/i18n";
import { useI18n } from "@zamtest/i18n/react";
import { Markdown } from "./markdown";
import "./help.css";

export { Markdown } from "./markdown";

/** The app's own API call (it adds the app's sign-in and client headers). */
export type HelpApi = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

interface SectionInfo {
  id: string;
  title: string;
  summary: string;
  translated: boolean;
}

interface Section extends SectionInfo {
  body: string;
}

const languageOf = (code: string) => LOCALES.find((l) => l.code === code)?.name ?? code;

/**
 * The docs: the list of sections (searchable) and the one being read. In
 * another language, sections switch from English as their translation is ready.
 */
export function DocsView({ api, initial, onOpen }: { api: HelpApi; initial?: string; onOpen?: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [sections, setSections] = useState<SectionInfo[]>();
  const [translating, setTranslating] = useState(false);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | undefined>(initial);
  const [section, setSection] = useState<Section>();
  const [loadingSection, setLoadingSection] = useState(false);
  const [error, setError] = useState<string>();

  // The list; asked again while sections are being translated.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api<{ sections: SectionInfo[]; translating: boolean }>(`/api/docs?lang=${encodeURIComponent(locale)}`)
        .then((r) => {
          if (!alive) return;
          setSections(r.sections);
          setTranslating(r.translating);
          setOpenId((current) => current ?? r.sections[0]?.id);
          if (r.translating) timer = setTimeout(load, 4000);
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, locale]);

  // The open section (translated on first read in this language).
  const listed = sections?.find((s) => s.id === openId);
  useEffect(() => {
    if (!openId) return;
    let alive = true;
    setLoadingSection(true);
    api<Section>(`/api/docs/${encodeURIComponent(openId)}?lang=${encodeURIComponent(locale)}`)
      .then((s) => alive && setSection(s))
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoadingSection(false));
    return () => {
      alive = false;
    };
    // Again when its translation arrives in the list.
  }, [api, openId, locale, listed?.translated]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sections ?? []).filter((s) => !q || `${s.title} ${s.summary}`.toLowerCase().includes(q));
  }, [sections, query]);

  const open = (id: string) => {
    setOpenId(id);
    onOpen?.(id);
  };

  return (
    <div className="help-docs">
      <nav className="help-docs-nav">
        <input className="help-search" placeholder={t("help.searchDocs")} value={query} onChange={(e) => setQuery(e.target.value)} />
        {translating && <p className="help-note">{t("help.translating", { language: languageOf(locale) })}</p>}
        <ul>
          {shown.map((s) => (
            <li key={s.id}>
              <button className={s.id === openId ? "on" : ""} onClick={() => open(s.id)} title={s.summary}>
                {s.title}
              </button>
            </li>
          ))}
        </ul>
        {sections && !shown.length && <p className="help-note">{t("help.noResults")}</p>}
      </nav>
      <article className="help-article">
        {error && <p className="help-error">{error}</p>}
        {section && section.id === openId ? (
          <>
            <h2>{section.title}</h2>
            <p className="help-summary">{section.summary}</p>
            {!section.translated && locale !== "en" && <p className="help-note">{loadingSection ? t("help.translatingSection") : t("help.notTranslated")}</p>}
            <Markdown text={section.body} />
          </>
        ) : (
          <p className="help-note">{loadingSection ? t("help.translatingSection") : t("common.loading")}</p>
        )}
      </article>
    </div>
  );
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const saved = (key: string): ChatMessage[] => {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? "[]") as ChatMessage[];
  } catch {
    return [];
  }
};

/** The help assistant: answers from the docs, in the person's language. */
export function HelpChat({
  api,
  where,
  intro,
  suggestions,
  storageKey = "zamtest.helpChat",
}: {
  api: HelpApi;
  where?: string;
  /** Instead of the in-product greeting and suggestions (e.g. on the website). */
  intro?: string;
  suggestions?: string[];
  /** Where the conversation is kept for this browser tab. */
  storageKey?: string;
}) {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>(() => saved(storageKey));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState<number>();
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(messages.slice(-20)));
    } catch {
      /* storage unavailable */
    }
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, storageKey]);

  const ask = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ answer: string; left: number }>("/api/help/chat", { method: "POST", body: { messages: next.slice(-20), language: locale, where } });
      setMessages([...next, { role: "assistant", content: r.answer }]);
      setLeft(r.left);
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
      setMessages(messages);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void ask(draft);
    }
  };

  return (
    <div className="help-chat">
      <div className="help-chat-log" ref={box}>
        {!messages.length && (
          <div className="help-chat-intro">
            <p>{intro ?? t("help.intro")}</p>
            {(suggestions ?? [t("help.suggest1"), t("help.suggest2"), t("help.suggest3")]).map((q) => (
              <button key={q} className="help-suggestion" onClick={() => void ask(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`help-msg help-msg-${m.role}`}>
            {m.role === "assistant" ? <Markdown text={m.content} /> : m.content}
          </div>
        ))}
        {busy && (
          <div className="help-msg help-msg-assistant help-typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>
      {error && <p className="help-error">{error}</p>}
      <div className="help-chat-input">
        <textarea rows={2} value={draft} placeholder={t("help.askPlaceholder")} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} />
        <button className="help-send" disabled={busy || !draft.trim()} onClick={() => void ask(draft)}>
          {t("help.send")}
        </button>
      </div>
      <div className="help-chat-foot">
        {left !== undefined && <span>{t("help.left", { count: left })}</span>}
        {messages.length > 0 && (
          <button className="help-link" onClick={() => setMessages([])}>
            {t("help.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

/** Docs and the assistant side by side (a page), or in tabs (a narrow panel). */
export function HelpCenter({ api, where, layout, initial, onOpen }: { api: HelpApi; where?: string; layout: "page" | "panel"; initial?: string; onOpen?: (id: string) => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"docs" | "ask">("docs");
  if (layout === "page") {
    return (
      <div className="help-center help-center-page">
        <DocsView api={api} initial={initial} onOpen={onOpen} />
        <aside className="help-center-chat">
          <h3>{t("help.askTitle")}</h3>
          <HelpChat api={api} where={where} />
        </aside>
      </div>
    );
  }
  return (
    <div className="help-center help-center-panel">
      <div className="help-tabs">
        <button className={tab === "docs" ? "on" : ""} onClick={() => setTab("docs")}>
          {t("help.docs")}
        </button>
        <button className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>
          {t("help.ask")}
        </button>
      </div>
      {tab === "docs" ? <DocsView api={api} initial={initial} onOpen={onOpen} /> : <HelpChat api={api} where={where} />}
    </div>
  );
}
