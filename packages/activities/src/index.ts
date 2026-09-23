import type { ActivityHandler, ActivityMeta } from "@zamtest/core";
import { BUILTIN_ACTIVITIES } from "@zamtest/core";
import { aiHandlers } from "./ai.js";
import { browserHandlers } from "./browser.js";
import { dataHandlers } from "./data.js";
import { systemHandlers } from "./system.js";

export { activityTools, getAi } from "./ai.js";
export { snapshotDom } from "./browser.js";

/**
 * An activity package bundles metadata (for the Designer) with runtime
 * handlers (for bot agents). Custom packages use the same shape.
 */
export interface ActivityPackage {
  name: string;
  version: string;
  activities: ActivityMeta[];
  handlers: Record<string, ActivityHandler>;
}

export const builtinHandlers: Record<string, ActivityHandler> = {
  ...systemHandlers,
  ...dataHandlers,
  ...browserHandlers,
  ...aiHandlers,
};

export const builtinPackage: ActivityPackage = {
  name: "@zamtest/activities",
  version: "0.1.0",
  activities: BUILTIN_ACTIVITIES,
  handlers: builtinHandlers,
};

export function combinePackages(packages: ActivityPackage[]): { catalog: ActivityMeta[]; handlers: Record<string, ActivityHandler> } {
  const catalog = new Map<string, ActivityMeta>();
  const handlers: Record<string, ActivityHandler> = {};
  for (const pkg of packages) {
    for (const meta of pkg.activities) catalog.set(meta.type, meta);
    Object.assign(handlers, pkg.handlers);
  }
  return { catalog: [...catalog.values()], handlers };
}
