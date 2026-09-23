import type { Locale } from "./locales.js";
import type { LocaleMessages } from "./types.js";

/** Lazy loaders so each web app only downloads the language in use. */
export const LOCALE_LOADERS: Record<Exclude<Locale, "en">, () => Promise<LocaleMessages>> = {
  ja: () => import("./locales/ja.js").then((m) => m.ja),
  "zh-CN": () => import("./locales/zh-CN.js").then((m) => m.zhCN),
  fr: () => import("./locales/fr.js").then((m) => m.fr),
  es: () => import("./locales/es.js").then((m) => m.es),
  "pt-BR": () => import("./locales/pt-BR.js").then((m) => m.ptBR),
  de: () => import("./locales/de.js").then((m) => m.de),
  nl: () => import("./locales/nl.js").then((m) => m.nl),
  ru: () => import("./locales/ru.js").then((m) => m.ru),
  vi: () => import("./locales/vi.js").then((m) => m.vi),
  th: () => import("./locales/th.js").then((m) => m.th),
  af: () => import("./locales/af.js").then((m) => m.af),
  sw: () => import("./locales/sw.js").then((m) => m.sw),
};

export async function loadLocale(locale: Locale): Promise<LocaleMessages | undefined> {
  return locale === "en" ? undefined : LOCALE_LOADERS[locale]();
}
