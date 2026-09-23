import { describe, expect, it } from "vitest";
import { catalogSource, createTranslator, detectLocale, en, LOCALE_LOADERS, localeDir, LOCALES } from "../src/index.js";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const source = catalogSource();

describe("locale detection", () => {
  it("matches exact tags, base languages and falls back to English", () => {
    expect(detectLocale(["fr-CA"])).toBe("fr");
    expect(detectLocale(["zh-TW", "en"])).toBe("zh-CN");
    expect(detectLocale(["pt-PT"])).toBe("pt-BR");
    expect(detectLocale(["ko", "de-AT"])).toBe("de");
    expect(detectLocale(["ko"])).toBe("en");
    expect(detectLocale(["ar-EG"])).toBe("ar");
  });

  it("marks Arabic as right-to-left with Latin digits in dates", () => {
    expect(localeDir("ar")).toBe("rtl");
    expect(localeDir("fr")).toBe("ltr");
    const t = createTranslator("ar");
    expect(t.dir).toBe("rtl");
    expect(t.dateTime("2026-01-02T03:04:05Z")).toMatch(/2026/);
  });
});

describe("translator", () => {
  it("interpolates and falls back to English", () => {
    const t = createTranslator("en");
    expect(t.t("dashboard.busyCount", { count: 3 })).toBe("3 busy");
    expect(t.actionName({ type: "core.log", displayName: "Log Message" })).toBe("Log Message");
  });
});

describe.each(Object.entries(LOCALE_LOADERS))("locale %s", (code, load) => {
  it("is registered", () => {
    expect(LOCALES.some((l) => l.code === code)).toBe(true);
  });

  it("translates every UI string with matching placeholders", async () => {
    const { ui } = await load();
    expect(Object.keys(ui).sort()).toEqual(Object.keys(en).sort());
    for (const [key, english] of Object.entries(en)) {
      const text = ui[key as keyof typeof en];
      expect(text?.trim(), key).toBeTruthy();
      expect(placeholders(text), key).toEqual(placeholders(english));
    }
  });

  it("translates every action catalog string", async () => {
    const { catalog } = await load();
    const missing = Object.keys(source).filter((k) => !catalog[k]?.trim());
    const extra = Object.keys(catalog).filter((k) => !(k in source));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });
});
