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
  /** The list the element belongs to (e.g. every camera row), for "any item like this one". */
  similar?: { items: string; count: number; inner?: string };
  /** Picked inside a list's item: how many of the items contain it (e.g. the offline icon: 13 of 17). */
  inside?: { matches: number; total: number };
}

/** What is picked: an element (and the list it belongs to), or something inside the items of a list. */
export interface PickMode {
  mode?: "element" | "inside";
  /** Inside: the list's items (a css= selector). */
  items?: string;
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

export const PICK_SCRIPT = (texts: PickTexts, pickMode: PickMode = {}) => String.raw`(() => {
  if (window.__zamtechPicker || window.top !== window) return;
  window.__zamtechPicker = true;
  ${SELECTOR_HELPERS}
  const T = ${JSON.stringify(texts)};
  const MODE = ${JSON.stringify(pickMode.mode ?? "element")};
  const ITEMS = ${JSON.stringify((pickMode.items ?? "").replace(/^css=/, ""))};
  // Rows of a list look alike: same tag and the same (not generated) classes.
  const classesOf = (x) => [...x.classList].filter((c) => !generated(c));
  const sig = (x) => x.tagName + "|" + classesOf(x).sort().join(".");
  const cssOf = (x) => x.tagName.toLowerCase() + classesOf(x).map((c) => "." + css(c)).join("");
  const uniqueCss = (x) => {
    if (x.id && !generated(x.id) && unique("#" + css(x.id))) return "#" + css(x.id);
    const path = cssPath(x);
    return unique(path) ? path : null;
  };
  const relative = (from, to) => {
    const path = [];
    for (let x = to; x && x !== from; x = x.parentElement) path.unshift(cssOf(x));
    return path.join(" > ");
  };
  /** The list an element belongs to: the nearest row (ancestor or itself) that has look-alike siblings. */
  const similarOf = (el) => {
    for (let n = el, depth = 0; n && n.parentElement && n !== document.body && depth < 8; n = n.parentElement, depth++) {
      const parent = n.parentElement;
      if ([...parent.children].filter((c) => sig(c) === sig(n)).length < 2) continue;
      const parentCss = uniqueCss(parent);
      if (!parentCss) continue;
      const itemsCss = parentCss + " > " + cssOf(n);
      let all;
      try { all = [...document.querySelectorAll(itemsCss)]; } catch { continue; }
      if (all.length < 2 || !all.includes(n)) continue;
      const inner = n === el ? undefined : relative(n, el);
      return { items: "css=" + itemsCss, count: all.length, inner: inner ? "css=" + inner : undefined, nodes: all };
    }
    return undefined;
  };
  const itemOf = (el) => { try { return ITEMS ? el.closest(ITEMS) : null; } catch { return null; } };
  /** Shows the found items for a moment, then reports. */
  const flash = (nodes, done) => {
    const marks = nodes.slice(0, 200).map((n) => {
      const r = n.getBoundingClientRect();
      const m = document.createElement("div");
      m.style.cssText = "position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #06b6d4;background:rgba(6,182,212,.12);border-radius:4px;left:" + (r.left - 2) + "px;top:" + (r.top - 2) + "px;width:" + (r.width + 4) + "px;height:" + (r.height + 4) + "px";
      document.body.append(m);
      return m;
    });
    setTimeout(() => { marks.forEach((m) => m.remove()); done(); }, 1200);
  };
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
    const el = MODE === "inside" ? ev.target : pickTarget(ev.target);
    if (!el || el === box || (MODE === "inside" && !itemOf(el))) { box.style.display = "none"; return; }
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
    if (MODE === "inside") {
      // Something inside one item (e.g. the offline icon): how many of the items contain it.
      const el = ev.target;
      const item = itemOf(el);
      if (!item || item === el) return;
      const rel = relative(item, el);
      const all = [...document.querySelectorAll(ITEMS)];
      const having = all.filter((it) => { try { return Boolean(it.querySelector(rel)); } catch { return false; } });
      flash(having, () => window.__zamtechPick({ selector: "css=" + rel, description: describe(el), inside: { matches: having.length, total: all.length } }));
      return;
    }
    const el = pickTarget(ev.target);
    const similar = similarOf(el);
    const picked = { selector: selectorFor(el), description: describe(el) };
    if (!similar) { window.__zamtechPick(picked); return; }
    flash(similar.nodes, () => window.__zamtechPick({ ...picked, similar: { items: similar.items, count: similar.count, inner: similar.inner } }));
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
  options: { timeoutMs?: number; headless?: boolean; onPage?: (page: Page) => void; attachTo?: Browser } & PickMode = {},
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
    const script = PICK_SCRIPT(words, { mode: options.mode, items: options.items });
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
