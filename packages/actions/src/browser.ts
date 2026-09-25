/// <reference lib="dom" />
import type { Browser, Page } from "playwright";
import type { ActionContext, ActionHandler } from "@zamtest/core";
import { errorMessage } from "@zamtest/core";
import { getAi } from "./ai.js";
import { expectation, matchOf, shown, textMatches, VerificationError, waitFor } from "./verify.js";

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

/**
 * Try-out runs from the Designer leave their visible browser open at the end, so
 * the person sees where it stopped (a run can be over in a second). It closes
 * when the next run starts, or after LINGER_MS. Other jobs close their browsers.
 */
const LINGER_MS = 10 * 60_000;
/** How long a page may keep loading after it opens before the next step goes ahead anyway. */
const SETTLE_TIMEOUT = 10_000;
/** After typing, the text is checked this long later (a page that redraws its form wipes it). */
const TYPE_CHECK_MS = 300;
const TYPE_ATTEMPTS = 3;
let keepOpen = false;
/** Running the steps before a step for Indicate: the browser is shown (the person points in it) and always kept. */
let forPicking = false;
const lingering = new Set<Browser>();

/** For the next run: leave its visible browsers open at the end (Designer try-outs; forIndicate: shown and kept). */
export function keepBrowsersOpen(on: boolean, forIndicate = false): void {
  keepOpen = on;
  forPicking = on && forIndicate;
}

/** Closes browsers an earlier try-out left open; how many there were. */
export async function closeLingeringBrowsers(): Promise<number> {
  const open = [...lingering];
  lingering.clear();
  await Promise.all(open.map((b) => b.close().catch(() => undefined)));
  return open.length;
}

/** Browsers left open by the run that just ended. */
export const lingeringBrowsers = () => lingering.size;

/** The browser the last run left open, handed over (it is no longer closed by the next run or the timer). */
export function takeLingeringBrowser(): Browser | undefined {
  const last = [...lingering].at(-1);
  if (last) lingering.delete(last);
  return last;
}

export const browserHandlers: Record<string, ActionHandler> = {
  "browser.open": async (props, ctx) => {
    const pw = await loadPlaywright();
    const existing = ctx.resources.get(SESSION) as BrowserSession | undefined;
    if (existing) await existing.browser.close().catch(() => undefined);
    const kind = (String(props.browser ?? "chromium") as "chromium" | "firefox" | "webkit") || "chromium";
    // ZAMTEST_BROWSER_EXECUTABLE points at a custom Chromium build (e.g. a corporate-managed browser).
    const executablePath = kind === "chromium" ? process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined : undefined;
    // Machines without a screen (servers, containers) can only run headless browsers.
    const noDisplay = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
    // Before indicating, the person has to see the page (tests keep it hidden with ZAMTEST_RECORD_HEADLESS).
    const shown = forPicking && process.env.ZAMTEST_RECORD_HEADLESS !== "1";
    const headless = (Boolean(props.headless) && !shown) || process.env.ZAMTEST_HEADLESS === "1" || noDisplay;
    const keepForPicking = forPicking;
    if (headless && !props.headless) ctx.log("info", "No display on this machine; running the browser headless");
    const browser = await pw[kind].launch({ headless, executablePath });
    const page = await browser.newPage();
    const session: BrowserSession = { browser, page };
    ctx.resources.set(SESSION, session);
    ctx.onDispose(async () => {
      if (ctx.resources.get(SESSION) === session) ctx.resources.delete(SESSION);
      if (keepOpen && (!headless || keepForPicking) && browser.isConnected()) {
        lingering.add(browser);
        setTimeout(() => {
          if (lingering.delete(browser)) void browser.close().catch(() => undefined);
        }, LINGER_MS).unref?.();
        return;
      }
      await browser.close().catch(() => undefined);
    });
    await page.goto(String(props.url));
    // Pages that keep loading after they appear (a login form drawn again when the app starts)
    // would wipe what the next steps type: wait until the page is quiet, at most a few seconds.
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT }).catch(() => undefined);
    // In front of the Designer and other windows, so the person sees it work.
    if (!headless) await page.bringToFront().catch(() => undefined);
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
      const text = String(props.text ?? "");
      if (props.clear === false) await loc.pressSequentially(text, { timeout });
      else {
        // Some pages clear a field just after it was filled (the form is drawn again while the app
        // finishes loading): check the text stayed, and type it again when it did not.
        for (let attempt = 1; ; attempt++) {
          await loc.fill(text, { timeout });
          await getPage(ctx).waitForTimeout(TYPE_CHECK_MS);
          const now = await loc.inputValue({ timeout: 2000 }).catch(() => undefined);
          // Not an input (e.g. a rich text editor), or the text is there.
          if (now === undefined || now === text) break;
          if (attempt >= TYPE_ATTEMPTS) throw new Error(`The page cleared the field again after typing ${TYPE_ATTEMPTS} times (${sel})`);
          // The text itself is not logged: it may be a password.
          ctx.log("warn", `The page cleared the field right after typing (${sel}); typing again`);
          await getPage(ctx).waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT }).catch(() => undefined);
        }
      }
      if (props.pressEnter) await loc.press("Enter", { timeout });
    }),

  "browser.select": (props, ctx) =>
    withSelector(ctx, props, async (sel, timeout) => {
      const loc = getPage(ctx).locator(sel);
      const value = String(props.value ?? "");
      // Try the option value first, then the visible label.
      await loc.selectOption({ value }, { timeout }).catch(() => loc.selectOption({ label: value }, { timeout }));
    }),

  "browser.getText": (props, ctx) =>
    withSelector(ctx, props, async (sel, timeout) => (await getPage(ctx).locator(sel).innerText({ timeout })).trim()),

  "browser.waitFor": (props, ctx) =>
    withSelector(ctx, { ...props, timeoutMs: props.timeoutMs ?? 30_000 }, (sel, timeout) =>
      getPage(ctx).locator(sel).waitFor({ state: "visible", timeout }),
    ),

  "browser.verifyText": async (props, ctx) => {
    const page = getPage(ctx);
    const selector = String(props.selector);
    const expected = String(props.text ?? "");
    const match = matchOf(props.match);
    const { passed, last } = await waitFor(
      () => page.locator(selector).first().innerText({ timeout: 500 }).then((t) => t, () => undefined),
      (text) => text !== undefined && textMatches(text, expected, match),
      Number(props.timeoutMs ?? 5000),
      ctx.signal,
    );
    if (!passed) throw new VerificationError(`Expected the text of ${selector} to ${expectation(match, expected)}, but found ${shown(last)}`);
    ctx.log("info", `Check passed: ${selector} has the expected text`);
  },

  "browser.verifyVisible": async (props, ctx) => {
    const page = getPage(ctx);
    const selector = String(props.selector);
    const wanted = props.visible !== false;
    const { passed } = await waitFor(
      () => page.locator(selector).first().isVisible().catch(() => false),
      (visible) => visible === wanted,
      Number(props.timeoutMs ?? 5000),
      ctx.signal,
    );
    if (!passed) throw new VerificationError(wanted ? `Expected ${selector} to be visible, but it is not on the page` : `Expected ${selector} not to be visible, but it is`);
    ctx.log("info", `Check passed: ${selector} is ${wanted ? "visible" : "not visible"}`);
  },

  "browser.verifyTitle": async (props, ctx) => {
    const page = getPage(ctx);
    const expected = String(props.text ?? "");
    const match = matchOf(props.match);
    const { passed, last } = await waitFor(() => page.title().catch(() => ""), (title) => textMatches(title, expected, match), Number(props.timeoutMs ?? 5000), ctx.signal);
    if (!passed) throw new VerificationError(`Expected the page title to ${expectation(match, expected)}, but it is ${shown(last)}`);
    ctx.log("info", "Check passed: page title");
  },

  "browser.verifyUrl": async (props, ctx) => {
    const page = getPage(ctx);
    const expected = String(props.text ?? "");
    const match = matchOf(props.match);
    const { passed, last } = await waitFor(async () => page.url(), (url) => textMatches(url, expected, match), Number(props.timeoutMs ?? 5000), ctx.signal);
    if (!passed) throw new VerificationError(`Expected the page address to ${expectation(match, expected)}, but it is ${shown(last)}`);
    ctx.log("info", "Check passed: page address");
  },

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
