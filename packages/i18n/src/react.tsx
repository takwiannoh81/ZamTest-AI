import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { loadLocale } from "./loaders.js";
import { detectLocale, isLocale, LOCALES } from "./locales.js";
import type { Locale } from "./locales.js";
import { createTranslator } from "./translator.js";
import type { Translator } from "./translator.js";
import type { LocaleMessages } from "./types.js";

const STORAGE_KEY = "zamtest.locale";

interface I18nValue extends Translator {
  setLocale(locale: Locale): void;
}

const I18nContext = createContext<I18nValue | null>(null);

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* storage unavailable */
  }
  return typeof navigator === "undefined" ? "en" : detectLocale(navigator.languages ?? [navigator.language]);
}

/** Loads the chosen language (lazily) and provides a translator to the app. */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [loaded, setLoaded] = useState<{ locale: Locale; messages?: LocaleMessages }>({ locale: "en" });

  useEffect(() => {
    let alive = true;
    loadLocale(locale)
      .then((messages) => alive && setLoaded({ locale, messages }))
      .catch(() => alive && setLoaded({ locale: "en" }));
    return () => {
      alive = false;
    };
  }, [locale]);

  useEffect(() => {
    document.documentElement.lang = loaded.locale;
  }, [loaded.locale]);

  const value = useMemo<I18nValue>(
    () => ({
      ...createTranslator(loaded.locale, loaded.messages),
      setLocale: (next) => {
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          /* storage unavailable */
        }
        setLocaleState(next);
      },
    }),
    [loaded],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside <I18nProvider>");
  return value;
}

export function LanguageSelect({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <select className={className} aria-label={t("common.language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
      {LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
