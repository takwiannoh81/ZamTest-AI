export interface LocaleInfo {
  code: string;
  /** Native name shown in the language picker. */
  name: string;
  /** English name, used to tell the AI which language to answer in. */
  english: string;
  dir?: "ltr" | "rtl";
  /** BCP 47 tag for Intl date/number formatting when it differs from `code`. */
  intl?: string;
}

export const LOCALES = [
  { code: "en", name: "English", english: "English" },
  { code: "ja", name: "日本語", english: "Japanese" },
  { code: "zh-CN", name: "简体中文", english: "Simplified Chinese" },
  { code: "fr", name: "Français", english: "French" },
  { code: "es", name: "Español", english: "Spanish" },
  { code: "pt-BR", name: "Português (Brasil)", english: "Brazilian Portuguese" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "nl", name: "Nederlands", english: "Dutch" },
  { code: "ru", name: "Русский", english: "Russian" },
  { code: "vi", name: "Tiếng Việt", english: "Vietnamese" },
  { code: "th", name: "ไทย", english: "Thai" },
  { code: "af", name: "Afrikaans", english: "Afrikaans" },
  { code: "sw", name: "Kiswahili", english: "Swahili" },
  // Latin digits keep dates consistent with the numbers shown elsewhere in the UI.
  { code: "ar", name: "العربية", english: "Arabic", dir: "rtl", intl: "ar-u-nu-latn" },
] as const satisfies readonly LocaleInfo[];

export type Locale = (typeof LOCALES)[number]["code"];
export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(value: unknown): value is Locale {
  return LOCALES.some((l) => l.code === value);
}

function info(locale: string): LocaleInfo | undefined {
  return (LOCALES as readonly LocaleInfo[]).find((l) => l.code === locale);
}

export function localeDir(locale: string): "ltr" | "rtl" {
  return info(locale)?.dir ?? "ltr";
}

export function intlLocale(locale: string): string {
  return info(locale)?.intl ?? locale;
}

/** English name of a locale, used to tell the AI which language to answer in. */
export function languageName(locale: string): string {
  return LOCALES.find((l) => l.code === locale)?.english ?? "English";
}

/** Picks the best supported locale for a list of BCP 47 tags (e.g. navigator.languages). */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const lower = tag.toLowerCase();
    const exact = LOCALES.find((l) => l.code.toLowerCase() === lower);
    if (exact) return exact.code;
    const base = lower.split("-")[0];
    const byBase = LOCALES.find((l) => l.code.toLowerCase().split("-")[0] === base);
    if (byBase) return byBase.code;
  }
  return DEFAULT_LOCALE;
}
