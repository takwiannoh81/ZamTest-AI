/**
 * AI Vision actions: click, type, read, check and wait by what is on the screen,
 * described in words, instead of by selector. For screens where selectors do not
 * work (remote desktops and Citrix, canvas apps, old applications). The bot takes
 * a screenshot (of the open web page, or of the whole Windows screen) and the
 * orchestrator's AI says where the thing is, what it reads, or whether it is shown.
 */
import type { Page } from "playwright";
import type { ActionContext, ActionHandler } from "@zamtest/core";
import { getPage, hasPage } from "./browser.js";
import { getDesktop } from "./desktop/index.js";
import { VerificationError } from "./verify.js";

export type VisionTask = "locate" | "read" | "check";

export interface VisionAnswer {
  found: boolean;
  x?: number;
  y?: number;
  box?: { x: number; y: number; width: number; height: number };
  value?: string;
  confidence: number;
  reason: string;
}

/** The orchestrator looks at screenshots with AI (each look is one AI request). */
export interface VisionService {
  look(input: { task: VisionTask; target: string; image: string; mediaType: "image/jpeg"; width: number; height: number }): Promise<VisionAnswer>;
}

/** The image size the model sees without shrinking it (positions then map exactly). */
const MAX_WIDTH = 1456;
const MAX_HEIGHT = 816;
/** Between two looks while waiting. */
const LOOK_EVERY_MS = 1_500;

export function visionService(ctx: ActionContext): VisionService | undefined {
  return ctx.services.vision as VisionService | undefined;
}

function vision(ctx: ActionContext): VisionService {
  const service = visionService(ctx);
  if (!service) throw new Error("AI Vision needs the orchestrator (it looks at the screen with AI)");
  return service;
}

/** A screenshot, and how to turn a position on it into a click. */
interface Shot {
  image: Buffer;
  width: number;
  height: number;
  where: "page" | "screen";
  click(x: number, y: number, button: "left" | "right" | "double"): Promise<void>;
  type(text: string, clear: boolean, pressEnter: boolean): Promise<void>;
  /** Shows where the click goes (web pages), so the step's screenshot has it. */
  mark(x: number, y: number): Promise<void>;
}

const whereOf = (ctx: ActionContext, props: Record<string, unknown>): "page" | "screen" => {
  const where = String(props.where ?? "auto");
  if (where === "page" || where === "screen") return where;
  return hasPage(ctx) ? "page" : "screen";
};

/** Exported for tests. */
export async function pageShot(page: Page): Promise<Shot> {
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight, sx: window.scrollX, sy: window.scrollY }));
  const scale = Math.min(1, MAX_WIDTH / view.w, MAX_HEIGHT / view.h);
  let image: Buffer;
  // Chromium can shrink the screenshot itself; other browsers send it as it is.
  try {
    if (scale >= 1) throw new Error("not needed");
    const cdp = await page.context().newCDPSession(page);
    const { data } = (await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 75,
      clip: { x: view.sx, y: view.sy, width: view.w, height: view.h, scale },
    })) as { data: string };
    await cdp.detach().catch(() => undefined);
    image = Buffer.from(data, "base64");
  } catch {
    image = await page.screenshot({ type: "jpeg", quality: 75, scale: "css" });
  }
  const s = scale < 1 && image.length ? scale : 1;
  const toPage = (v: number) => v / s;
  return {
    image,
    width: Math.round(view.w * s),
    height: Math.round(view.h * s),
    where: "page",
    click: async (x, y, button) => {
      await page.mouse.click(toPage(x), toPage(y), { button: button === "right" ? "right" : "left", clickCount: button === "double" ? 2 : 1 });
    },
    type: async (text, clear, pressEnter) => {
      if (clear) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await page.keyboard.press("Delete");
      }
      await page.keyboard.type(text);
      if (pressEnter) await page.keyboard.press("Enter");
    },
    mark: async (x, y) => {
      await page
        .evaluate(
          ([px, py]) => {
            const dot = document.createElement("div");
            dot.style.cssText = `position:fixed;left:${px - 14}px;top:${py - 14}px;width:28px;height:28px;border:3px solid #e11d48;border-radius:50%;box-shadow:0 0 0 3px rgba(255,255,255,.85);z-index:2147483647;pointer-events:none`;
            document.documentElement.appendChild(dot);
            setTimeout(() => dot.remove(), 2000);
          },
          [toPage(x), toPage(y)],
        )
        .catch(() => undefined);
    },
  };
}

async function screenShot(ctx: ActionContext): Promise<Shot> {
  const driver = getDesktop(ctx);
  const shot = await driver.call<{ data: string; width: number; height: number; left: number; top: number; screenWidth: number; screenHeight: number }>("snapshot", {
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    quality: 75,
  });
  if (!shot.width || !shot.screenWidth) throw new Error("Update the ZamTech AI agent to use AI Vision on the screen");
  const toScreen = (x: number, y: number) => ({
    x: Math.round(shot.left + (x * shot.screenWidth) / shot.width),
    y: Math.round(shot.top + (y * shot.screenHeight) / shot.height),
  });
  return {
    image: Buffer.from(shot.data, "base64"),
    width: shot.width,
    height: shot.height,
    where: "screen",
    click: async (x, y, button) => {
      await driver.call("clickAt", { ...toScreen(x, y), button: button === "right" ? "right" : "left", double: button === "double" });
    },
    type: async (text, clear, pressEnter) => {
      await driver.call("typeText", { text, clear, pressEnter });
    },
    mark: async () => undefined,
  };
}

const takeShot = (ctx: ActionContext, where: "page" | "screen") => (where === "page" ? pageShot(getPage(ctx)) : screenShot(ctx));

async function look(ctx: ActionContext, task: VisionTask, target: string, where: "page" | "screen") {
  const shot = await takeShot(ctx, where);
  const answer = await vision(ctx).look({ task, target, image: shot.image.toString("base64"), mediaType: "image/jpeg", width: shot.width, height: shot.height });
  return { shot, answer };
}

const onWhat = (where: "page" | "screen") => (where === "page" ? "the page" : "the screen");

/** Finds the target and clicks it; where it clicked. */
export async function visionClick(
  ctx: ActionContext,
  target: string,
  where: "page" | "screen",
  button: "left" | "right" | "double" = "left",
): Promise<{ shot: Shot; x: number; y: number }> {
  const { shot, answer } = await look(ctx, "locate", target, where);
  if (!answer.found || answer.x === undefined || answer.y === undefined) {
    throw new Error(`AI Vision did not find ${JSON.stringify(target)} on ${onWhat(where)}${answer.reason ? `: ${answer.reason}` : ""}`);
  }
  await shot.mark(answer.x, answer.y);
  await shot.click(answer.x, answer.y, button);
  ctx.log("info", `AI Vision clicked ${JSON.stringify(target)} at (${answer.x}, ${answer.y}) of a ${shot.width} x ${shot.height} screenshot, ${Math.round(answer.confidence * 100)}% sure: ${answer.reason}`);
  ctx.emit("visionClick", { target, x: answer.x, y: answer.y, width: shot.width, height: shot.height, box: answer.box, confidence: answer.confidence, where });
  return { shot, x: answer.x, y: answer.y };
}

/** Clicks the target, then types into it. */
export async function visionType(ctx: ActionContext, target: string, text: string, where: "page" | "screen", clear = true, pressEnter = false): Promise<void> {
  const { shot } = await visionClick(ctx, target, where);
  await shot.type(text, clear, pressEnter);
}

/** Looks until the screen shows it, or the time is up. */
async function waitUntilShown(ctx: ActionContext, expectation: string, where: "page" | "screen", timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  let last = "";
  for (let first = true; first || Date.now() < end; first = false) {
    if (ctx.signal.aborted) throw new Error("Cancelled");
    const { answer } = await look(ctx, "check", expectation, where);
    if (answer.found) return { passed: true, reason: answer.reason };
    last = answer.reason;
    const left = end - Date.now();
    if (left <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(LOOK_EVERY_MS, left)));
  }
  return { passed: false, reason: last };
}

const text = (v: unknown) => String(v ?? "").trim();

export const visionHandlers: Record<string, ActionHandler> = {
  "vision.click": async (props, ctx) => {
    const button = String(props.button ?? "left") as "left" | "right" | "double";
    await visionClick(ctx, text(props.target), whereOf(ctx, props), button);
  },

  "vision.type": async (props, ctx) => {
    await visionType(ctx, text(props.target), String(props.text ?? ""), whereOf(ctx, props), props.clear !== false, Boolean(props.pressEnter));
  },

  "vision.read": async (props, ctx) => {
    const where = whereOf(ctx, props);
    const target = text(props.target);
    const { answer } = await look(ctx, "read", target, where);
    if (!answer.found) throw new Error(`AI Vision did not find ${JSON.stringify(target)} on ${onWhat(where)}${answer.reason ? `: ${answer.reason}` : ""}`);
    ctx.log("info", `AI Vision read ${JSON.stringify(target)}: ${JSON.stringify(answer.value)} (${Math.round(answer.confidence * 100)}% sure)`);
    return answer.value ?? "";
  },

  "vision.verify": async (props, ctx) => {
    const where = whereOf(ctx, props);
    const expectation = text(props.expectation);
    const { passed, reason } = await waitUntilShown(ctx, expectation, where, Number(props.timeoutMs ?? 5000));
    if (!passed) throw new VerificationError(`Expected ${onWhat(where)} to show ${JSON.stringify(expectation)}, but it does not${reason ? `: ${reason}` : ""}`);
    ctx.log("info", `Check passed (AI Vision): ${reason}`);
  },

  "vision.waitFor": async (props, ctx) => {
    const where = whereOf(ctx, props);
    const expectation = text(props.expectation);
    const timeoutMs = Number(props.timeoutMs ?? 30_000);
    const { passed, reason } = await waitUntilShown(ctx, expectation, where, timeoutMs);
    if (!passed) throw new Error(`${onWhat(where)[0]!.toUpperCase()}${onWhat(where).slice(1)} did not show ${JSON.stringify(expectation)} within ${Math.round(timeoutMs / 1000)} s${reason ? `: ${reason}` : ""}`);
    ctx.log("info", `AI Vision: ${reason}`);
  },
};

/**
 * AI Vision as the last try of a Click or Type step whose selector did not work (after
 * AI self-healing, when that is on): it looks for the step's target description, or its
 * label, on the page or the screen. Off with the step's AI self-healing.
 */
export function withVisionFallback(type: "browser.click" | "browser.type" | "desktop.click" | "desktop.type", handler: ActionHandler): ActionHandler {
  const where = type.startsWith("browser.") ? "page" : "screen";
  return async (props, ctx) => {
    try {
      return await handler(props, ctx);
    } catch (err) {
      const target = text(props.description) || text(ctx.step.label);
      if (ctx.signal.aborted || !visionService(ctx) || props.aiHeal === false || !target) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      ctx.log("warn", `The selector did not work (${reason.split("\n")[0]}); AI Vision looks for ${JSON.stringify(target)} on ${onWhat(where)}`);
      try {
        if (type.endsWith(".click")) {
          const button = props.double ? "double" : props.button === "right" ? "right" : "left";
          await visionClick(ctx, target, where, button);
        } else {
          await visionType(ctx, target, String(props.text ?? ""), where, props.clear !== false, Boolean(props.pressEnter));
        }
      } catch (visionErr) {
        throw new Error(`${reason} (AI Vision could not do it either: ${visionErr instanceof Error ? visionErr.message : String(visionErr)})`);
      }
      ctx.log("warn", "AI Vision did the step. Update its selector (Indicate) so the next run does not need AI Vision.");
      return undefined;
    }
  };
}
