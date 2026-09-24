import type { Page } from "playwright";
import type { DesktopDriver } from "./desktop/driver.js";

/** Resource keys of the browser session and desktop driver (see browser.ts, desktop/index.ts). */
const BROWSER = "browser.session";
const DESKTOP = "desktop.driver";

export interface StepScreenshot {
  /** JPEG. */
  data: Buffer;
  /** Where it came from. */
  source: "browser" | "desktop";
}

/**
 * The screen after a step, for the job's timeline: the browser page after browser
 * steps, the Windows desktop after desktop steps, and whichever is open after a
 * failed step of any kind. Nothing is started just to take a screenshot.
 */
export async function captureStep(resources: Map<string, unknown>, stepType: string, failed: boolean): Promise<StepScreenshot | undefined> {
  const page = (resources.get(BROWSER) as { page?: Page } | undefined)?.page;
  const desktop = resources.get(DESKTOP) as DesktopDriver | undefined;
  const fromBrowser = async () =>
    page && !page.isClosed() ? { data: await page.screenshot({ type: "jpeg", quality: 60, timeout: 5000 }), source: "browser" as const } : undefined;
  const fromDesktop = async () => {
    if (!desktop?.running) return undefined;
    const { data } = await desktop.call<{ data: string }>("snapshot", { maxWidth: 1600, quality: 60 });
    return { data: Buffer.from(data, "base64"), source: "desktop" as const };
  };
  if (stepType.startsWith("browser.")) return fromBrowser();
  if (stepType.startsWith("desktop.")) return fromDesktop();
  if (failed) return (await fromBrowser()) ?? (await fromDesktop());
  return undefined;
}
