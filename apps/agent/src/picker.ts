/**
 * Indicate an element on a web page: a browser opens at the address, the
 * element under the mouse is outlined, and a click picks it (the page does not
 * get that click). F2 lets the page be used normally for a few seconds, e.g. to
 * log in or open a menu first; Esc cancels.
 */
import type { Browser, Page } from "playwright";
import { SELECTOR_HELPERS } from "./recorder.js";

export interface PickedElement {
  selector: string;
  description: string;
}

/** The banner's texts, in the person's language. */
export interface PickTexts {
  /** While picking: what to do. */
  pick: string;
  /** While paused: the page can be used (log in, open a menu). */
  paused: string;
  pause: string;
  resume: string;
  cancel: string;
}

const ENGLISH: PickTexts = {
  pick: "Click the element for this step. Need to log in or open a menu first? Click Pause.",
  paused: "Paused: use the page as usual (log in, open a menu), then click Indicate.",
  pause: "Pause",
  resume: "Indicate",
  cancel: "Cancel",
};

export const PICK_SCRIPT = (texts: PickTexts) => String.raw`(() => {
  if (window.__zamtechPicker || window.top !== window) return;
  window.__zamtechPicker = true;
  ${SELECTOR_HELPERS}
  const T = ${JSON.stringify(texts)};
  // Paused (using the page) until the person clicks Indicate; kept when a page opens another (logging in).
  const KEY = "__zamtechPickPaused";
  let paused = false;
  try { paused = sessionStorage.getItem(KEY) === "1"; } catch {}
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #4f46e5;background:rgba(79,70,229,.12);border-radius:4px;display:none;transition:all 60ms";
  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;z-index:2147483647;left:50%;transform:translateX(-50%);background:#312e81;color:#fff;font:14px/1.4 'Segoe UI',system-ui,sans-serif;padding:10px 12px 10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);max-width:92vw;display:flex;align-items:center;gap:12px;pointer-events:none;transition:top .15s,bottom .15s";
  const message = document.createElement("span");
  const button = (label, primary) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "pointer-events:auto;border:none;border-radius:7px;padding:6px 12px;font:600 13px 'Segoe UI',system-ui,sans-serif;cursor:pointer;white-space:nowrap;" + (primary ? "background:#fff;color:#312e81" : "background:rgba(255,255,255,.15);color:#fff");
    return b;
  };
  const toggle = button("", true);
  const cancel = button(T.cancel, false);
  banner.append(message, toggle, cancel);
  const show = () => {
    message.textContent = paused ? T.paused : T.pick;
    toggle.textContent = paused ? "◎ " + T.resume : "⏸ " + T.pause;
    banner.style.background = paused ? "#475569" : "#312e81";
    if (paused) box.style.display = "none";
  };
  const setPaused = (next) => {
    paused = next;
    try { sessionStorage.setItem(KEY, paused ? "1" : "0"); } catch {}
    show();
  };
  toggle.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); setPaused(!paused); });
  cancel.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); window.__zamtechPick(null); });
  show();
  const mount = () => { if (document.body && !box.isConnected) { document.body.append(box, banner); } };
  document.addEventListener("DOMContentLoaded", mount);
  mount();
  const onBanner = (el) => el && banner.contains(el);
  const pickTarget = (el) => target(el);
  // The banner lets clicks through (except its buttons) and moves to the other edge when the mouse
  // comes over it, so it never hides what the person wants to point at.
  let atTop = true;
  const place = () => { banner.style.top = atTop ? "12px" : "auto"; banner.style.bottom = atTop ? "auto" : "12px"; };
  place();
  document.addEventListener("mousemove", (ev) => {
    const edge = banner.getBoundingClientRect();
    if (!onBanner(ev.target) && ev.clientX >= edge.left && ev.clientX <= edge.right && ev.clientY >= edge.top && ev.clientY <= edge.bottom) { atTop = !atTop; place(); }
    if (paused || onBanner(ev.target)) { box.style.display = "none"; return; }
    const el = pickTarget(ev.target);
    if (!el || el === box) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
  }, true);
  const swallow = (ev) => { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); };
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick"]) {
    document.addEventListener(type, (ev) => { if (!paused && !onBanner(ev.target)) swallow(ev); }, true);
  }
  document.addEventListener("click", (ev) => {
    if (paused || onBanner(ev.target)) return;
    swallow(ev);
    const el = pickTarget(ev.target);
    window.__zamtechPick({ selector: selectorFor(el), description: describe(el) });
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !paused) { swallow(ev); window.__zamtechPick(null); }
    if (ev.key === "F2") { swallow(ev); setPaused(!paused); }
  }, true);
})();`

/**
 * Opens a browser at the address (or uses one already open: `attachTo`, e.g. where the
 * steps before this one left it) and waits for the person to click an element. Null
 * when they cancel, close the browser, or `stopped()` turns true.
 */
export async function pickWebElement(
  url: string,
  texts: Partial<PickTexts> | string | undefined,
  stopped: () => boolean,
  options: { timeoutMs?: number; headless?: boolean; onPage?: (page: Page) => void; attachTo?: Browser } = {},
): Promise<PickedElement | null> {
  // Long enough to log in and find the page (paused) before indicating.
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const words: PickTexts = { ...ENGLISH, ...(typeof texts === "string" ? { pick: texts } : texts) };
  let browser = options.attachTo;
  if (!browser) {
    let pw: typeof import("playwright");
    try {
      pw = await import("playwright");
    } catch {
      throw new Error("Indicating on a web page needs Playwright's Chromium on this PC (reinstall the agent with web automation)");
    }
    browser = await pw.chromium.launch({
      headless: options.headless ?? process.env.ZAMTEST_RECORD_HEADLESS === "1",
      executablePath: process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined,
    });
  }
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext({ viewport: null }));
    let result: PickedElement | null | undefined;
    await context.exposeBinding("__zamtechPick", (_source, picked: PickedElement | null) => {
      if (result === undefined) result = picked;
    });
    const script = PICK_SCRIPT(words);
    await context.addInitScript(script);
    let page = context.pages().at(-1);
    if (page) {
      // Already on the page: start picking there now.
      await page.bringToFront().catch(() => undefined);
      await page.evaluate(script).catch(() => undefined);
    } else {
      page = await context.newPage();
      await page.goto(url).catch(() => undefined); // an unreachable address still leaves the browser to navigate
    }
    options.onPage?.(page);
    const started = Date.now();
    const open = () => context.pages().some((p) => !p.isClosed());
    while (result === undefined && open() && !stopped() && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return result ?? null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
