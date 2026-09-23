import type { ActionHandler, ActionMeta } from "@zamtest/core";
import { BUILTIN_ACTIONS } from "@zamtest/core";
import { aiHandlers } from "./ai.js";
import { browserHandlers } from "./browser.js";
import { dataHandlers } from "./data.js";
import { systemHandlers } from "./system.js";

export { actionTools, getAi } from "./ai.js";
export { snapshotDom } from "./browser.js";

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
  ...browserHandlers,
  ...aiHandlers,
};

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
