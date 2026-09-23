import type { ActionMeta } from "@zamtest/core";
import { catalogKey } from "./catalog.js";
import type { Locale } from "./locales.js";
import { en } from "./locales/en.js";
import type { MessageKey } from "./locales/en.js";
import type { LocaleMessages } from "./types.js";

export type Params = Record<string, string | number>;

export function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export interface Translator {
  locale: Locale;
  t(key: MessageKey, params?: Params): string;
  category(category: string): string;
  actionName(meta: Pick<ActionMeta, "type" | "displayName">): string;
  actionDescription(meta: Pick<ActionMeta, "type" | "description">): string;
  propLabel(type: string, prop: { name: string; label: string }): string;
  propDescription(type: string, prop: { name: string; description?: string }): string | undefined;
  dateTime(iso: string | number | Date): string;
  timeAgo(iso?: string): string;
}

export function createTranslator(locale: Locale, messages?: LocaleMessages): Translator {
  const ui = messages?.ui;
  const catalog = messages?.catalog ?? {};
  const fromCatalog = (key: string, fallback: string) => catalog[key] || fallback;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  return {
    locale,
    t: (key, params) => format(ui?.[key] || en[key] || key, params),
    category: (c) => fromCatalog(catalogKey.category(c), c),
    actionName: (m) => fromCatalog(catalogKey.name(m.type), m.displayName),
    actionDescription: (m) => fromCatalog(catalogKey.description(m.type), m.description),
    propLabel: (type, p) => fromCatalog(catalogKey.propLabel(type, p.name), p.label),
    propDescription: (type, p) => (p.description ? fromCatalog(catalogKey.propDescription(type, p.name), p.description) : undefined),
    dateTime: (value) => new Date(value).toLocaleString(locale),
    timeAgo: (iso) => {
      if (!iso) return "-";
      const seconds = Math.round((Date.parse(iso) - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 5) return format(ui?.["common.justNow"] || en["common.justNow"]);
      if (abs < 60) return relative.format(seconds, "second");
      if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
      if (abs < 86400) return relative.format(Math.round(seconds / 3600), "hour");
      return new Date(iso).toLocaleDateString(locale);
    },
  };
}
