import { sleep, stringify } from "@zamtest/core";
import type { ActivityHandler, LogLevel } from "@zamtest/core";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

export const systemHandlers: Record<string, ActivityHandler> = {
  "core.log": (props, ctx) => {
    const level = (["debug", "info", "warn", "error"].includes(String(props.level)) ? props.level : "info") as LogLevel;
    ctx.log(level, stringify(props.message));
  },

  "core.assign": (props, ctx) => {
    ctx.setVar(String(props.variable), props.value);
  },

  "core.delay": (props, ctx) => sleep(Number(props.ms ?? 0), ctx.signal),

  "core.comment": () => undefined,

  "core.throw": (props) => {
    throw new Error(stringify(props.message) || "Workflow raised an exception");
  },

  "core.getAsset": async (props, ctx) => {
    if (!ctx.services.getAsset) throw new Error("Assets are only available when running under an orchestrator");
    return ctx.services.getAsset(String(props.name));
  },

  "core.runScript": async (props, ctx) => {
    const fn = new AsyncFunction("vars", "log", String(props.code ?? ""));
    return fn(ctx.vars, (message: unknown) => ctx.log("info", stringify(message)));
  },
};
