import { resolve } from "node:path";
import type { ActionContext, ActionHandler } from "@zamtest/core";
import { errorMessage } from "@zamtest/core";
import { getAi } from "../ai.js";
import { DesktopDriver } from "./driver.js";
import { formatSelector, parseSelector } from "./selector.js";

export { DesktopDriver, DesktopUnsupportedError, DRIVER_SCRIPT } from "./driver.js";
export { describeChain, formatSelector, parseSelector, selectorFromChain, SelectorError } from "./selector.js";
export type { ElementInfo, Segment } from "./selector.js";

const DRIVER = "desktop.driver";
/** Upper bound for the UI Automation tree sent to AI (nodes). */
const MAX_TREE_NODES = 1500;

/** Returns the job's desktop driver, starting it on first use. */
export function getDesktop(ctx: ActionContext): DesktopDriver {
  let driver = ctx.resources.get(DRIVER) as DesktopDriver | undefined;
  if (!driver) {
    driver = DesktopDriver.start();
    ctx.resources.set(DRIVER, driver);
    const started = driver;
    ctx.onDispose(async () => {
      if (ctx.resources.get(DRIVER) === started) ctx.resources.delete(DRIVER);
      await started.close();
    });
  }
  return driver;
}

/**
 * Text outline of the UI Automation tree for AI: the window named by the
 * selector's first segment, or the list of top-level windows when that
 * window is missing.
 */
export async function desktopSnapshot(ctx: ActionContext, selector?: string, maxNodes = MAX_TREE_NODES): Promise<string> {
  const driver = getDesktop(ctx);
  if (selector) {
    try {
      const windowOnly = formatSelector(parseSelector(selector).slice(0, 1));
      const { tree } = await driver.call<{ tree: string }>("tree", { selector: windowOnly, maxNodes });
      return tree;
    } catch {
      // fall through to the window list
    }
  }
  const { tree } = await driver.call<{ tree: string }>("tree", { maxNodes });
  return tree;
}

/** Same contract as the browser version: on failure, ask AI for a replacement and validate it (exactly one match). */
async function withDesktopSelector<T>(
  ctx: ActionContext,
  props: Record<string, unknown>,
  action: (selector: string) => Promise<T>,
): Promise<T> {
  const selector = String(props.selector);
  parseSelector(selector); // syntax errors are the author's to fix, not AI's
  const heal = props.aiHeal !== false && Boolean(getAi(ctx, false));
  try {
    return await action(selector);
  } catch (err) {
    if (!heal || !/not found/i.test(errorMessage(err))) throw err;
    ctx.log("warn", `Desktop selector failed (${selector}); asking AI to heal it...`);
    const tree = await desktopSnapshot(ctx, selector);
    const suggestion = await getAi(ctx)!.healDesktopSelector({
      failedSelector: selector,
      description: props.description ? String(props.description) : undefined,
      tree,
      error: errorMessage(err),
    });
    const driver = getDesktop(ctx);
    for (const candidate of suggestion.candidates.slice(0, 3)) {
      try {
        const { count } = await driver.call<{ count: number }>("count", { selector: candidate.selector });
        if (count !== 1) continue;
      } catch {
        continue; // invalid selector
      }
      const result = await action(candidate.selector);
      ctx.log("warn", `Self-healed selector: ${selector} -> ${candidate.selector} (${candidate.reason})`);
      ctx.emit("selectorHealed", { oldSelector: selector, newSelector: candidate.selector, reason: candidate.reason });
      return result;
    }
    throw new Error(`${errorMessage(err)}: ${selector} (AI self-healing found no working replacement)`);
  }
}

const timeoutOf = (props: Record<string, unknown>, fallback = 10_000) => Number(props.timeoutMs ?? fallback);

export const desktopHandlers: Record<string, ActionHandler> = {
  "desktop.launch": async (props, ctx) => {
    const driver = getDesktop(ctx);
    const { pid } = await driver.call<{ pid: number }>("launch", { path: String(props.path), args: props.args ? String(props.args) : undefined });
    ctx.log("info", `Started ${props.path} (process ${pid})`);
    if (props.waitFor) await driver.call("waitFor", { selector: String(props.waitFor), timeoutMs: timeoutOf(props, 30_000) });
    return pid;
  },

  "desktop.click": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      const r = await getDesktop(ctx).call<{ method: string }>("click", {
        selector,
        button: props.button ?? "left",
        double: Boolean(props.double),
        mode: props.mode ?? "auto",
        timeoutMs: timeoutOf(props),
      });
      ctx.log("debug", `Clicked ${selector} (${r.method})`);
    }),

  "desktop.type": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      await getDesktop(ctx).call("type", {
        selector,
        text: String(props.text ?? ""),
        clear: props.clear !== false,
        pressEnter: Boolean(props.pressEnter),
        timeoutMs: timeoutOf(props),
      });
    }),

  "desktop.sendKeys": async (props, ctx) => {
    const send = (selector?: string) => getDesktop(ctx).call("sendKeys", { keys: String(props.keys ?? ""), selector, timeoutMs: timeoutOf(props) });
    if (!props.selector) {
      await send();
      return;
    }
    await withDesktopSelector(ctx, props, send);
  },

  "desktop.getText": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      const { text } = await getDesktop(ctx).call<{ text: string }>("getText", { selector, timeoutMs: timeoutOf(props) });
      return (text ?? "").trim();
    }),

  "desktop.select": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      await getDesktop(ctx).call("select", { selector, value: String(props.value ?? ""), timeoutMs: timeoutOf(props) });
    }),

  "desktop.readTable": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      const { headers, rows } = await getDesktop(ctx).call<{ headers: string[]; rows: string[][] }>("readTable", { selector, timeoutMs: timeoutOf(props) });
      if (!headers?.length) return rows ?? [];
      return (rows ?? []).map((row) => Object.fromEntries(headers.map((h, i) => [h || `column${i + 1}`, row[i] ?? ""])));
    }),

  "desktop.waitFor": (props, ctx) =>
    withDesktopSelector(ctx, props, async (selector) => {
      await getDesktop(ctx).call("waitFor", { selector, state: props.state ?? "visible", timeoutMs: timeoutOf(props, 30_000) });
    }),

  "desktop.screenshot": async (props, ctx) => {
    const { path } = await getDesktop(ctx).call<{ path: string }>("screenshot", {
      path: resolve(String(props.path || "desktop.png")),
      selector: props.selector ? String(props.selector) : undefined,
    });
    return path;
  },

  "desktop.closeWindow": async (props, ctx) => {
    await getDesktop(ctx).call("close", { selector: String(props.selector), timeoutMs: timeoutOf(props) });
  },
};
