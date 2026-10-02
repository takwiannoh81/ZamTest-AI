import type { ActionHandler, ActionMeta } from "@zamtest/core";
import { BUILTIN_ACTIONS } from "@zamtest/core";
import { aiHandlers } from "./ai.js";
import { browserHandlers } from "./browser.js";
import { dataHandlers } from "./data.js";
import { desktopHandlers } from "./desktop/index.js";
import { documentHandlers } from "./documents.js";
import { emailHandlers } from "./email.js";
import { officeHandlers } from "./office.js";
import { pdfHandlers } from "./pdf.js";
import { queueHandlers } from "./queue.js";
import { systemHandlers } from "./system.js";
import { verifyHandlers } from "./verify.js";
import { visionHandlers, withVisionFallback } from "./vision.js";

export { actionTools, getAi } from "./ai.js";
export { closeLingeringBrowsers, keepBrowsersOpen, lingeringBrowsers, snapshotDom, takeLingeringBrowser } from "./browser.js";
export { captureStep } from "./screenshots.js";
export type { DocumentResult, DocumentService } from "./documents.js";
export type { IndicatedSpot, VisionAnswer, VisionService, VisionTask } from "./vision.js";
export { spotOnPage, spotOnScreen } from "./vision.js";
export type { StepScreenshot } from "./screenshots.js";
export * as desktop from "./desktop/index.js";
export type { QueueItem, QueueItemStatus, QueueService } from "./queue.js";

/**
 * An action package bundles metadata (for the Designer) with runtime
 * handlers (for bot agents). Custom packages use the same shape.
 */
export interface ActionPackage {
  name: string;
  version: string;
  actions: ActionMeta[];
  handlers: Record<string, ActionHandler>;
}

export const builtinHandlers: Record<string, ActionHandler> = {
  ...systemHandlers,
  ...dataHandlers,
  ...officeHandlers,
  ...emailHandlers,
  ...pdfHandlers,
  ...queueHandlers,
  ...browserHandlers,
  ...desktopHandlers,
  ...aiHandlers,
  ...documentHandlers,
  ...verifyHandlers,
  ...visionHandlers,
};
// A Click or Type whose selector does not work tries AI Vision last.
for (const type of ["browser.click", "browser.type", "desktop.click", "desktop.type"] as const) {
  builtinHandlers[type] = withVisionFallback(type, builtinHandlers[type]!);
}

export const builtinPackage: ActionPackage = {
  name: "@zamtest/actions",
  version: "0.1.0",
  actions: BUILTIN_ACTIONS,
  handlers: builtinHandlers,
};

export function combinePackages(packages: ActionPackage[]): { catalog: ActionMeta[]; handlers: Record<string, ActionHandler> } {
  const catalog = new Map<string, ActionMeta>();
  const handlers: Record<string, ActionHandler> = {};
  for (const pkg of packages) {
    for (const meta of pkg.actions) catalog.set(meta.type, meta);
    Object.assign(handlers, pkg.handlers);
  }
  return { catalog: [...catalog.values()], handlers };
}
