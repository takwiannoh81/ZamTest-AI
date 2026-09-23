/// <reference lib="dom" />
import type { Browser, Page } from "playwright";
import type { ActionContext, ActionHandler } from "@zamtest/core";
import { errorMessage } from "@zamtest/core";
import { getAi } from "./ai.js";

const SESSION = "browser.session";
const DEFAULT_ACTION_TIMEOUT = 10_000;
/** Upper bound for DOM sent to AI (characters). Larger pages are truncated and the model is told so. */
export const MAX_DOM_CHARS = 150_000;

interface BrowserSession {
  browser: Browser;
  page: Page;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Browser actions need Playwright on the agent machine: `pnpm add playwright && npx playwright install`");
  }
}

export function getPage(ctx: ActionContext): Page {
  const session = ctx.resources.get(SESSION) as BrowserSession | undefined;
  if (!session) throw new Error("No browser is open. Add an 'Open Browser' action first.");
  return session.page;
}

export function hasPage(ctx: ActionContext): boolean {
  return ctx.resources.has(SESSION);
}

/**
 * Condensed DOM for AI: drops scripts/styles/SVG internals and non-semantic
 * attributes so the model sees structure, text and stable hooks only.
 */
export async function snapshotDom(page: Page, maxChars = MAX_DOM_CHARS): Promise<{ html: string; truncated: boolean }> {
  const html = await page.evaluate(() => {
    const KEEP = /^(id|name|type|role|href|value|placeholder|title|alt|for|label|aria-.*|data-.*)$/;
    const root = document.body.cloneNode(true) as HTMLElement;
    root.querySelectorAll("script,style,noscript,template,link,meta").forEach((n) => n.remove());
    root.querySelectorAll("svg").forEach((n) => {
      n.innerHTML = "";
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_TEXT);
    const drop: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.COMMENT_NODE) drop.push(node);
      else if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ");
        node.textContent = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      } else {
        const el = node as Element;
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === "class") {
            // keep short, human-looking class names only
            const cls = attr.value
              .split(/\s+/)
              .filter((c) => c && c.length < 30 && !/\d{3,}|[_-](?=[a-zA-Z0-9]*\d)[a-zA-Z0-9]{5,}$/.test(c))
              .slice(0, 4)
              .join(" ");
            if (cls) el.setAttribute("class", cls);
            else el.removeAttribute("class");
          } else if (!KEEP.test(attr.name)) {
            el.removeAttribute(attr.name);
          }
        }
      }
    }
    drop.forEach((n) => n.parentNode?.removeChild(n));
    return root.outerHTML.replace(/>\s+</g, "><");
  });
  return html.length > maxChars ? { html: html.slice(0, maxChars), truncated: true } : { html, truncated: false };
}

/**
 * Runs a selector-based action. If the selector no longer matches and
 * self-healing is enabled, asks AI for replacement selectors, validates each
 * one against the live page, and retries with the first that matches exactly
 * one element. Healed selectors are reported as a `selectorHealed` event so
 * the Portal/Designer can offer to update the workflow.
 */
async function withSelector<T>(
  ctx: ActionContext,
  props: Record<string, unknown>,
  action: (selector: string, timeout: number) => Promise<T>,
): Promise<T> {
  const selector = String(props.selector);
  const heal = props.aiHeal !== false && Boolean(getAi(ctx, false));
  const timeout = Number(props.timeoutMs ?? (heal ? DEFAULT_ACTION_TIMEOUT : 30_000));
  try {
    return await action(selector, timeout);
  } catch (err) {
    if (!heal) throw err;
    const page = getPage(ctx);
    ctx.log("warn", `Selector failed (${selector}); asking AI to heal it...`);
    const { html, truncated } = await snapshotDom(page);
    const suggestion = await getAi(ctx)!.healSelector({
      failedSelector: selector,
      description: props.description ? String(props.description) : undefined,
      html: truncated ? `${html}\n<!-- DOM truncated at ${MAX_DOM_CHARS} characters -->` : html,
      url: page.url(),
      error: errorMessage(err),
    });
    for (const candidate of suggestion.candidates.slice(0, 3)) {
      try {
        if ((await page.locator(candidate.selector).count()) !== 1) continue;
      } catch {
        continue; // invalid selector syntax
      }
      const result = await action(candidate.selector, timeout);
      ctx.log("warn", `Self-healed selector: ${selector} -> ${candidate.selector} (${candidate.reason})`);
      ctx.emit("selectorHealed", { oldSelector: selector, newSelector: candidate.selector, reason: candidate.reason });
      return result;
    }
    throw new Error(`${errorMessage(err)} (AI self-healing found no working replacement)`);
  }
}

export const browserHandlers: Record<string, ActionHandler> = {
  "browser.open": async (props, ctx) => {
    const pw = await loadPlaywright();
    const existing = ctx.resources.get(SESSION) as BrowserSession | undefined;
    if (existing) await existing.browser.close().catch(() => undefined);
    const kind = (String(props.browser ?? "chromium") as "chromium" | "firefox" | "webkit") || "chromium";
    // ZAMTEST_BROWSER_EXECUTABLE points at a custom Chromium build (e.g. a corporate-managed browser).
    const executablePath = kind === "chromium" ? process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined : undefined;
    const browser = await pw[kind].launch({ headless: Boolean(props.headless), executablePath });
    const page = await browser.newPage();
    const session: BrowserSession = { browser, page };
    ctx.resources.set(SESSION, session);
    ctx.onDispose(async () => {
      if (ctx.resources.get(SESSION) === session) ctx.resources.delete(SESSION);
      await browser.close().catch(() => undefined);
    });
    await page.goto(String(props.url));
    ctx.log("info", `Opened ${kind} at ${props.url}`);
  },

  "browser.navigate": async (props, ctx) => {
    await getPage(ctx).goto(String(props.url));
    return getPage(ctx).url();
  },

  "browser.click": (props, ctx) =>
    withSelector(ctx, props, (sel, timeout) => getPage(ctx).locator(sel).click({ timeout })),

  "browser.type": (props, ctx) =>
    withSelector(ctx, props, async (sel, timeout) => {
      const loc = getPage(ctx).locator(sel);
      if (props.clear !== false) await loc.fill(String(props.text ?? ""), { timeout });
      else await loc.pressSequentially(String(props.text ?? ""), { timeout });
      if (props.pressEnter) await loc.press("Enter", { timeout });
    }),

  "browser.getText": (props, ctx) =>
    withSelector(ctx, props, async (sel, timeout) => (await getPage(ctx).locator(sel).innerText({ timeout })).trim()),

  "browser.waitFor": (props, ctx) =>
    withSelector(ctx, { ...props, timeoutMs: props.timeoutMs ?? 30_000 }, (sel, timeout) =>
      getPage(ctx).locator(sel).waitFor({ state: "visible", timeout }),
    ),

  "browser.screenshot": async (props, ctx) => {
    const path = String(props.path || "screenshot.png");
    await getPage(ctx).screenshot({ path, fullPage: true });
    return path;
  },

  "browser.close": async (_props, ctx) => {
    const session = ctx.resources.get(SESSION) as BrowserSession | undefined;
    ctx.resources.delete(SESSION);
    await session?.browser.close();
  },
};
