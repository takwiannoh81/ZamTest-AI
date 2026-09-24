import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { loadLocale } from "./loaders.js";
import { detectLocale, isLocale, localeDir, LOCALES } from "./locales.js";
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
    document.documentElement.dir = localeDir(loaded.locale);
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

/* ---------------------------------- colours ---------------------------------- */

/** Light, dark, or "auto": whatever the device is set to. */
export type Theme = "light" | "dark" | "auto";
const THEME_COOKIE = "zt_theme";

/**
 * The cookie is shared by the website, Portal and Designer (all on subdomains of
 * the same domain), so the choice follows the person between them.
 */
function themeCookieDomain(): string {
  const host = typeof location === "undefined" ? "" : location.hostname;
  const parts = host.split(".");
  if (host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":") || parts.length < 2) return "";
  return `; domain=.${parts.slice(-2).join(".")}`;
}

export function readTheme(): Theme {
  if (typeof document === "undefined") return "auto";
  const saved = /(?:^|;\s*)zt_theme=(light|dark|auto)/.exec(document.cookie)?.[1];
  return (saved as Theme | undefined) ?? "auto";
}

/** Shows the colours now: `data-theme` on <html>; none for "auto" (the CSS follows the device). */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  applyTheme(theme);
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax${themeCookieDomain()}`;
}

/** Light / Dark / Automatic, next to the language menu. */
export function ThemeSelect({ className }: { className?: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <select
      className={className}
      aria-label={t("theme.label")}
      title={t("theme.label")}
      value={theme}
      onChange={(e) => {
        const next = e.target.value as Theme;
        saveTheme(next);
        setTheme(next);
      }}
    >
      <option value="auto">◐ {t("theme.auto")}</option>
      <option value="light">☀ {t("theme.light")}</option>
      <option value="dark">☾ {t("theme.dark")}</option>
    </select>
  );
}
