/**
 * Exploring a website for AI to write its tests: a browser opens at the address
 * (or goes on from where the sign-in steps left it), the person may sign in
 * first and click "Start exploring", then the pages of the site are visited one
 * by one - only by following links, never by clicking buttons or sending forms -
 * and each page's fields, buttons, links, text and screen are sent back.
 */
import type { Browser, Page } from "playwright";
import { SELECTOR_HELPERS } from "./recorder.js";

/** One page as AI sees it. */
export interface ExploredPage {
  url: string;
  title: string;
  /** The page before the person signed in (its fields are the sign-in form). */
  beforeSignIn?: boolean;
  headings: string[];
  /** Visible text, shortened. */
  text: string;
  fields: Array<{ selector: string; description: string; type: string; required?: boolean; options?: string[] }>;
  buttons: Array<{ selector: string; description: string }>;
  links: Array<{ selector: string; text: string; href: string }>;
  tables: Array<{ selector: string; headers: string[]; rows: number }>;
  /** The screen, as a JPEG in base64. */
  screen?: string;
}

/** The banner's texts, in the person's language. */
export interface ExploreTexts {
  /** Shown while waiting: sign in (or open the page to start from), then click the button. */
  wait: string;
  start: string;
}

const ENGLISH: ExploreTexts = {
  wait: "Sign in, or open the page to start from. Then click Start exploring.",
  start: "Start exploring",
};

export const SNAPSHOT_SCRIPT = String.raw`(() => {
  // The banner is ours, not the site's.
  const banner = document.getElementById("__zamtech-explore");
  if (banner) banner.remove();
  ${SELECTOR_HELPERS}
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const all = (sel) => [...document.querySelectorAll(sel)].filter((el) => visible(el) && !el.closest("#__zamtech-explore"));
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const fields = all("input, textarea, select").filter((el) => !["hidden", "submit", "button", "reset", "image"].includes(el.type)).slice(0, 60).map((el) => ({
    selector: selectorFor(el),
    description: describe(el),
    type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : (el.type || "text"),
    required: el.required || el.getAttribute("aria-required") === "true" || undefined,
    options: el.tagName === "SELECT" ? [...el.options].slice(0, 15).map((o) => clip(o.text.trim(), 40)) : undefined,
  }));
  const buttons = all("button, [role=button], input[type=submit], input[type=button], [role=tab], [role=menuitem]").slice(0, 60).map((el) => ({ selector: selectorFor(el), description: describe(el) }));
  const links = all("a[href]").filter((a) => !/^(javascript|mailto|tel):/i.test(a.getAttribute("href") || "")).slice(0, 80).map((a) => ({ selector: selectorFor(a), text: clip(text(a), 60), href: a.href }));
  const tables = all("table, [role=grid], [role=table]").slice(0, 8).map((t) => ({
    selector: selectorFor(t),
    headers: [...t.querySelectorAll("th, [role=columnheader]")].slice(0, 15).map((h) => clip(text(h), 40)),
    rows: t.querySelectorAll("tbody tr, [role=row]").length,
  }));
  const headings = all("h1, h2, h3").slice(0, 20).map((h) => clip(text(h), 100));
  return { url: location.href, title: document.title, headings, text: clip((document.body && document.body.innerText || "").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), 2500), fields, buttons, links, tables };
})()`;

/** A banner at the top with one button; clicks elsewhere reach the page (to sign in). */
const WAIT_SCRIPT = (texts: ExploreTexts) => String.raw`(() => {
  // Once started, not again on the pages visited next.
  try { if (sessionStorage.getItem("__zamtechExploreGo")) return; } catch {}
  if (window.top !== window || document.getElementById("__zamtech-explore")) return;
  const T = ${JSON.stringify(texts)};
  const add = () => {
    if (!document.body || document.getElementById("__zamtech-explore")) return;
    const bar = document.createElement("div");
    bar.id = "__zamtech-explore";
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;justify-content:center;pointer-events:none;font:14px Segoe UI,Arial,sans-serif";
    const box = document.createElement("div");
    box.style.cssText = "pointer-events:auto;margin:8px;padding:9px 12px;background:#1f2330;color:#fff;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center";
    const msg = document.createElement("span");
    msg.textContent = T.wait;
    const go = document.createElement("button");
    go.textContent = T.start;
    go.style.cssText = "background:#6d5dfc;color:#fff;border:0;border-radius:6px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer";
    go.onclick = () => {
      try { sessionStorage.setItem("__zamtechExploreGo", "1"); } catch {}
      bar.remove();
      window.__zamtechExploreGo && window.__zamtechExploreGo();
    };
    box.append(msg, go);
    bar.append(box);
    document.body.append(bar);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
})()`;

/** Links that would sign out, delete or download instead of showing a page. */
const RISKY = /log\s*-?\s*(out|off)|sign\s*-?\s*out|abmelden|d[ée]connexion|cerrar sesi|delete|remove|destroy|unsubscribe|\.(pdf|zip|exe|msi|csv|xlsx?|docx?)(\?|$)/i;

/** The address without its #fragment (the same page). */
const pageKey = (url: string) => url.split("#")[0]!.replace(/\/$/, "");

export interface ExploreOptions {
  /** Go on in this browser (after the sign-in steps ran), on its current page. */
  attachTo?: Browser;
  /** Wait for the person to sign in and click Start exploring. */
  waitForPerson?: boolean;
  texts?: Partial<ExploreTexts>;
  maxPages?: number;
  headless?: boolean;
  stopped: () => boolean;
  onProgress?: (info: { stage: "waiting" | "exploring"; page?: number; title?: string }) => void;
}

/** How long the person has to sign in. */
const WAIT_TIMEOUT_MS = 15 * 60_000;

async function snapshot(page: Page): Promise<ExploredPage> {
  const data = (await page.evaluate(SNAPSHOT_SCRIPT)) as ExploredPage;
  const screen = await page
    .screenshot({ type: "jpeg", quality: 55 })
    .then((b) => b.toString("base64"))
    .catch(() => undefined);
  return { ...data, screen };
}

async function settle(page: Page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

export async function exploreSite(url: string, options: ExploreOptions): Promise<ExploredPage[]> {
  const maxPages = Math.min(Math.max(options.maxPages ?? 8, 1), 20);
  const words = { ...ENGLISH, ...options.texts };
  let browser = options.attachTo;
  if (!browser) {
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      throw new Error("Exploring a website needs Playwright's Chromium on this PC (reinstall the agent with web automation)");
    }
    browser = await pw.chromium.launch({
      headless: options.headless ?? process.env.ZAMTEST_RECORD_HEADLESS === "1",
      executablePath: process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined,
    });
  }
  const pages: ExploredPage[] = [];
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: null }));
    let page = context.pages().at(-1);
    if (page) await page.bringToFront().catch(() => undefined);
    else {
      page = await context.newPage();
      await page.goto(url).catch(() => undefined);
    }
    await settle(page);

    if (options.waitForPerson) {
      // The sign-in page first: AI writes the tests' sign-in steps from its fields.
      pages.push({ ...(await snapshot(page)), beforeSignIn: true });
      let go = false;
      await context.exposeBinding("__zamtechExploreGo", () => void (go = true));
      await context.addInitScript(WAIT_SCRIPT(words));
      await page.evaluate(WAIT_SCRIPT(words)).catch(() => undefined);
      options.onProgress?.({ stage: "waiting" });
      const started = Date.now();
      while (!go && !options.stopped() && !page.isClosed() && Date.now() - started < WAIT_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 300));
        // The person may open a new tab: go on in the newest one.
        page = context.pages().filter((p) => !p.isClosed()).at(-1) ?? page;
      }
      if (!go) return options.stopped() ? [] : pages;
      await page.evaluate(`document.getElementById("__zamtech-explore")?.remove()`).catch(() => undefined);
      await settle(page);
    }

    // From here, page after page by following the site's own links.
    const origin = new URL(page.url()).origin;
    const seen = new Set<string>();
    const queue: string[] = [page.url()];
    let first = true;
    while (queue.length && pages.filter((p) => !p.beforeSignIn).length < maxPages && !options.stopped()) {
      const next = queue.shift()!;
      if (seen.has(pageKey(next))) continue;
      seen.add(pageKey(next));
      if (!first) {
        const res = await page.goto(next, { timeout: 20_000 }).catch(() => null);
        if (res && res.status() >= 400) continue;
        await settle(page);
        // Redirected somewhere already seen (e.g. back to the start).
        if (pageKey(page.url()) !== pageKey(next) && seen.has(pageKey(page.url()))) continue;
        seen.add(pageKey(page.url()));
      }
      first = false;
      const shot = await snapshot(page).catch(() => undefined);
      if (!shot) continue;
      pages.push(shot);
      options.onProgress?.({ stage: "exploring", page: pages.filter((p) => !p.beforeSignIn).length, title: shot.title || shot.url });
      for (const link of shot.links) {
        let href: URL;
        try {
          href = new URL(link.href);
        } catch {
          continue;
        }
        if (href.origin !== origin || RISKY.test(link.text) || RISKY.test(href.pathname + href.search)) continue;
        if (!seen.has(pageKey(href.href)) && !queue.some((q) => pageKey(q) === pageKey(href.href))) queue.push(href.href);
      }
    }
    return pages;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
