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

const PICK_SCRIPT = (hint: string) => String.raw`(() => {
  if (window.__zamtechPicker || window.top !== window) return;
  window.__zamtechPicker = true;
  ${SELECTOR_HELPERS}
  let pausedUntil = 0;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;border:3px solid #4f46e5;background:rgba(79,70,229,.12);border-radius:4px;display:none;transition:all 60ms";
  const banner = document.createElement("div");
  banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);background:#312e81;color:#fff;font:14px/1.4 'Segoe UI',system-ui,sans-serif;padding:10px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.3);pointer-events:none;max-width:90vw;text-align:center";
  banner.textContent = ${JSON.stringify(hint)};
  const mount = () => { if (document.body && !box.isConnected) { document.body.append(box, banner); } };
  document.addEventListener("DOMContentLoaded", mount);
  mount();
  const picking = () => Date.now() >= pausedUntil;
  const pickTarget = (el) => target(el);
  document.addEventListener("mousemove", (ev) => {
    if (!picking()) { box.style.display = "none"; return; }
    const el = pickTarget(ev.target);
    if (!el || el === box || el === banner) return;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left - 3 + "px", top: r.top - 3 + "px", width: r.width + 6 + "px", height: r.height + 6 + "px" });
  }, true);
  const swallow = (ev) => { if (picking()) { ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); } };
  for (const type of ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "auxclick"]) document.addEventListener(type, swallow, true);
  document.addEventListener("click", (ev) => {
    if (!picking()) return;
    swallow(ev);
    const el = pickTarget(ev.target);
    window.__zamtechPick({ selector: selectorFor(el), description: describe(el) });
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") { swallow(ev); window.__zamtechPick(null); }
    if (ev.key === "F2") {
      swallow(ev);
      pausedUntil = Date.now() + 5000;
      box.style.display = "none";
      banner.style.opacity = ".5";
      setTimeout(() => (banner.style.opacity = "1"), 5000);
    }
  }, true);
})();`;

/**
 * Opens a browser at the address and waits for the person to click an element.
 * Null when they press Esc, close the browser, or `stopped()` turns true.
 */
export async function pickWebElement(
  url: string,
  hint: string,
  stopped: () => boolean,
  options: { timeoutMs?: number; headless?: boolean; onPage?: (page: Page) => void } = {},
): Promise<PickedElement | null> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error("Indicating on a web page needs Playwright's Chromium on this PC (reinstall the agent with web automation)");
  }
  const browser: Browser = await pw.chromium.launch({
    headless: options.headless ?? process.env.ZAMTEST_RECORD_HEADLESS === "1",
    executablePath: process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined,
  });
  try {
    const context = await browser.newContext({ viewport: null });
    let result: PickedElement | null | undefined;
    await context.exposeBinding("__zamtechPick", (_source, picked: PickedElement | null) => {
      if (result === undefined) result = picked;
    });
    await context.addInitScript(PICK_SCRIPT(hint));
    const page = await context.newPage();
    await page.goto(url).catch(() => undefined); // an unreachable address still leaves the browser to navigate
    options.onPage?.(page);
    const started = Date.now();
    while (result === undefined && !page.isClosed() && !stopped() && Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 250));
    }
    return result ?? null;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
