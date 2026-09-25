import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** The English website texts (site.* keys), read from the locale file. */
function englishTexts(): Record<string, string> {
  const file = fileURLToPath(new URL("../../packages/i18n/src/locales/en.ts", import.meta.url));
  const texts: Record<string, string> = {};
  for (const m of readFileSync(file, "utf8").matchAll(/"(site\.[^"]+)":\s*("(?:[^"\\]|\\.)*")/g)) texts[m[1]!] = JSON.parse(m[2]!) as string;
  return texts;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * Search engines read the page's words from its HTML: the page's own English text
 * goes into #root, and React draws the page over it when it starts (same content).
 */
function staticContent(): Plugin {
  return {
    name: "zamtech-static-content",
    transformIndexHtml(html) {
      const t = englishTexts();
      const cards = (prefix: string, keys: string[]) =>
        keys
          .filter((k) => t[`${prefix}.${k}.title`])
          .map((k) => `<article><h3>${esc(t[`${prefix}.${k}.title`]!)}</h3><p>${esc(t[`${prefix}.${k}.text`] ?? "")}</p></article>`)
          .join("");
      const body = `<main>
<header><h1>${esc(t["site.hero.title"] ?? "")}</h1><p>${esc(t["site.hero.badge"] ?? "")}</p><p>${esc(t["site.hero.subtitle"] ?? "")}</p></header>
<section><h2>${esc(t["site.new.title"] ?? "")}</h2>${cards("site.new", ["genTests", "alerts", "reports", "testData", "dynamic", "audit"])}</section>
<section><h2>${esc(t["site.features.title"] ?? "")}</h2>${cards("site.features", ["designer", "portal", "agents", "browser", "test", "desktop", "security", "cicd"])}</section>
<section><h2>${esc(t["site.ai.title"] ?? "")}</h2>${cards("site.ai", ["build", "heal", "agents", "extract", "fix", "tests"])}</section>
<section><h2>${esc(t["site.how.title"] ?? "")}</h2>${cards("site.how", ["step1", "step2", "step3"])}</section>
<section><h2>${esc(t["site.cta.title"] ?? "")}</h2><p>${esc(t["site.cta.text"] ?? "")}</p><a href="https://portal.zamtechai.com/?signup=1">${esc(t["site.cta.button"] ?? "")}</a></section>
</main>`;
      return html.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    },
  };
}

export default defineConfig({ plugins: [react(), staticContent()] });
