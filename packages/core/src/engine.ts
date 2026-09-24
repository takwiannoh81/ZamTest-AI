import { BUILTIN_ACTIONS, CONTROL_FLOW_TYPES } from "./catalog.js";
import { evaluate, interpolate, interpolateDeep } from "./expressions.js";
import type { ActionMeta, PropDef, Step, Workflow } from "./schema.js";
import { WorkflowSchema } from "./schema.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type EngineEvent =
  | { type: "log"; time: string; level: LogLevel; message: string; stepId?: string; data?: unknown }
  | { type: "stepStart"; time: string; stepId: string; stepType: string; label?: string }
  | {
      type: "stepEnd";
      time: string;
      stepId: string;
      stepType: string;
      status: "ok" | "error";
      durationMs: number;
      error?: string;
    }
  | { type: "custom"; time: string; name: string; stepId?: string; data?: unknown };

/** Services the host (bot agent, test harness...) makes available to actions. */
export interface EngineServices {
  getAsset?: (name: string) => Promise<unknown>;
  [key: string]: unknown;
}

export interface ActionContext {
  readonly step: Step;
  readonly vars: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly services: EngineServices;
  /** Shared per-run resources, e.g. the open browser page. */
  readonly resources: Map<string, unknown>;
  readonly catalog: ActionMeta[];
  setVar(name: string, value: unknown): void;
  log(level: LogLevel, message: string, data?: unknown): void;
  emit(name: string, data?: unknown): void;
  /** Register cleanup that runs when the job ends (success or failure). */
  onDispose(fn: () => unknown | Promise<unknown>): void;
  /** Runs another leaf action with already-resolved props (used by AI agents). */
  invoke(type: string, props: Record<string, unknown>): Promise<unknown>;
}

export type ActionHandler = (props: Record<string, unknown>, ctx: ActionContext) => unknown | Promise<unknown>;

export interface RunOptions {
  handlers: Record<string, ActionHandler>;
  catalog?: ActionMeta[];
  inputs?: Record<string, unknown>;
  services?: EngineServices;
  signal?: AbortSignal;
  onEvent?: (event: EngineEvent) => void;
  /**
   * Called after each action (not control-flow) step, before the next step and before
   * the run's resources close: e.g. to take a screenshot. Errors are ignored.
   */
  afterStep?: (info: AfterStepInfo) => unknown | Promise<unknown>;
  /** Internal: a workflow run by a "Call Workflow" step shares its caller's resources (open browser...). */
  shared?: SharedRun;
}

interface SharedRun {
  resources: Map<string, unknown>;
  disposers: Array<() => unknown | Promise<unknown>>;
  /** Called workflows by id (from the top workflow's `workflows`). */
  library: Record<string, unknown>;
  depth: number;
}

/** Calls within calls, at most. */
const MAX_CALL_DEPTH = 10;

export interface AfterStepInfo {
  step: Step;
  status: "ok" | "error";
  error?: string;
  /** The run's shared resources (open browser page, desktop driver...). */
  resources: Map<string, unknown>;
}

/** How long afterStep may take before the run moves on. */
const AFTER_STEP_TIMEOUT_MS = 10_000;

export interface RunResult {
  status: "succeeded" | "failed" | "cancelled";
  outputs: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

class BreakSignal {}

export class CancelledError extends Error {
  constructor() {
    super("Job was cancelled");
    this.name = "CancelledError";
  }
}

export class StepTimeoutError extends Error {
  constructor(step: Step, ms: number) {
    super(`Step "${step.label ?? step.type}" timed out after ${ms} ms`);
    this.name = "StepTimeoutError";
  }
}

const now = () => new Date().toISOString();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runWorkflow(workflow: Workflow, options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const catalog = options.catalog ?? BUILTIN_ACTIONS;
  const metaByType = new Map(catalog.map((a) => [a.type, a]));
  const signal = options.signal ?? new AbortController().signal;
  const services = options.services ?? {};
  // A called workflow uses its caller's resources; the top run closes them at its end.
  const resources = options.shared?.resources ?? new Map<string, unknown>();
  const disposers: Array<() => unknown | Promise<unknown>> = options.shared?.disposers ?? [];
  const library = options.shared?.library ?? workflow.workflows ?? {};
  const depth = options.shared?.depth ?? 0;
  const emit = (event: EngineEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* listeners must never break a run */
    }
  };

  const vars: Record<string, unknown> = {};
  for (const v of workflow.variables) {
    vars[v.name] = v.default === undefined ? undefined : structuredClone(v.default);
  }
  for (const v of workflow.variables) {
    if ((v.direction === "in" || v.direction === "inout") && options.inputs && v.name in options.inputs) {
      vars[v.name] = options.inputs[v.name];
    }
  }

  const makeContext = (step: Step): ActionContext => ({
    step,
    vars,
    signal,
    services,
    resources,
    catalog,
    setVar: (name, value) => {
      if (!name) return;
      vars[name] = value;
    },
    log: (level, message, data) => emit({ type: "log", time: now(), level, message, stepId: step.id, data }),
    emit: (name, data) => emit({ type: "custom", time: now(), name, stepId: step.id, data }),
    onDispose: (fn) => disposers.push(fn),
    invoke: async (type, props) => {
      const handler = options.handlers[type];
      if (!handler) throw new Error(`No handler registered for action "${type}"`);
      return handler(props, makeContext({ ...step, type, props }));
    },
  });

  const resolveProps = (step: Step): Record<string, unknown> => {
    const meta = metaByType.get(step.type);
    const defs = new Map<string, PropDef>((meta?.props ?? []).map((p) => [p.name, p]));
    const resolved: Record<string, unknown> = {};
    for (const def of defs.values()) {
      if (def.default !== undefined) resolved[def.name] = def.default;
    }
    for (const [name, raw] of Object.entries(step.props ?? {})) {
      resolved[name] = resolveValue(raw, defs.get(name));
    }
    for (const def of defs.values()) {
      if (def.required && (resolved[def.name] === undefined || resolved[def.name] === "")) {
        throw new Error(`"${meta?.displayName ?? step.type}" is missing required property "${def.label}"`);
      }
    }
    return resolved;
  };

  const resolveValue = (raw: unknown, def?: PropDef): unknown => {
    if (raw === undefined || raw === null) return raw;
    switch (def?.type) {
      case "variable":
        return raw;
      case "expression":
        if (typeof raw !== "string") return raw;
        return raw.trim() === "" ? undefined : evaluate(raw, vars);
      case "number": {
        const v = typeof raw === "string" ? interpolate(raw, vars) : raw;
        return typeof v === "number" ? v : Number(v);
      }
      case "boolean": {
        const v = typeof raw === "string" ? interpolate(raw, vars) : raw;
        return typeof v === "string" ? v === "true" : Boolean(v);
      }
      default:
        return interpolateDeep(raw, vars);
    }
  };

  const afterStep = async (step: Step, status: "ok" | "error", error?: string) => {
    if (!options.afterStep || signal.aborted) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(options.afterStep({ step, status, error, resources })),
        new Promise((resolve) => (timer = setTimeout(resolve, AFTER_STEP_TIMEOUT_MS))),
      ]);
    } catch {
      /* a failed screenshot never fails the run */
    } finally {
      clearTimeout(timer);
    }
  };

  const runSteps = async (steps: Step[] | undefined): Promise<void> => {
    for (const step of steps ?? []) {
      await runStep(step);
    }
  };

  const runStep = async (step: Step): Promise<void> => {
    if (step.disabled) return;
    if (signal.aborted) throw new CancelledError();

    const t0 = Date.now();
    emit({ type: "stepStart", time: now(), stepId: step.id, stepType: step.type, label: step.label });
    try {
      if (CONTROL_FLOW_TYPES.has(step.type)) {
        await runControl(step);
      } else {
        try {
          await runLeafWithPolicies(step);
        } catch (err) {
          if (!(err instanceof CancelledError) && !(err instanceof BreakSignal)) await afterStep(step, "error", errorMessage(err));
          throw err;
        }
        await afterStep(step, "ok");
      }
      emit({ type: "stepEnd", time: now(), stepId: step.id, stepType: step.type, status: "ok", durationMs: Date.now() - t0 });
    } catch (err) {
      if (err instanceof BreakSignal) {
        emit({ type: "stepEnd", time: now(), stepId: step.id, stepType: step.type, status: "ok", durationMs: Date.now() - t0 });
        throw err;
      }
      emit({
        type: "stepEnd",
        time: now(),
        stepId: step.id,
        stepType: step.type,
        status: "error",
        durationMs: Date.now() - t0,
        error: errorMessage(err),
      });
      if (step.continueOnError && !(err instanceof CancelledError)) {
        emit({ type: "log", time: now(), level: "warn", stepId: step.id, message: `Continuing after error: ${errorMessage(err)}` });
        return;
      }
      throw err;
    }
  };

  const runLeafWithPolicies = async (step: Step): Promise<void> => {
    const attempts = 1 + (step.retry?.count ?? 0);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await withTimeout(step, () => runLeaf(step));
        return;
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        lastError = err;
        if (attempt < attempts) {
          emit({
            type: "log",
            time: now(),
            level: "warn",
            stepId: step.id,
            message: `Attempt ${attempt}/${attempts} failed: ${errorMessage(err)}. Retrying...`,
          });
          await sleep(step.retry?.delayMs ?? 1000, signal);
        }
      }
    }
    throw lastError;
  };

  const withTimeout = async <T>(step: Step, fn: () => Promise<T>): Promise<T> => {
    if (!step.timeoutMs) return fn();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new StepTimeoutError(step, step.timeoutMs!)), step.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** "Call Workflow": runs another workflow with its own variables, in this run. */
  const callWorkflow = async (step: Step): Promise<void> => {
    const props = resolveProps(step);
    const id = String(props.workflowId ?? "");
    const parsed = WorkflowSchema.safeParse(library[id]);
    if (!parsed.success) throw new Error(`The called workflow ${id} is not available to this run (deleted, or not saved)`);
    if (depth >= MAX_CALL_DEPTH) throw new Error(`Workflows call each other more than ${MAX_CALL_DEPTH} levels deep`);
    const called = parsed.data as Workflow;
    const inputs = props.inputs && typeof props.inputs === "object" ? (props.inputs as Record<string, unknown>) : {};
    emit({ type: "log", time: now(), level: "info", stepId: step.id, message: `Calling workflow "${called.name}"` });
    const result = await runWorkflow(called, { ...options, inputs, shared: { resources, disposers, library, depth: depth + 1 } });
    if (result.status === "cancelled") throw new CancelledError();
    if (result.status === "failed") throw new Error(`Workflow "${called.name}" failed: ${result.error}`);
    const target = step.props?.output;
    if (typeof target === "string" && target) vars[target] = result.outputs;
  };

  const runLeaf = async (step: Step): Promise<void> => {
    if (step.type === "core.callWorkflow") return callWorkflow(step);
    const handler = options.handlers[step.type];
    if (!handler) throw new Error(`No handler registered for action "${step.type}"`);
    const props = resolveProps(step);
    const result = await handler(props, makeContext(step));
    const meta = metaByType.get(step.type);
    const outputDef = meta?.props.find((p) => p.name === "output" && p.output);
    const target = step.props?.output;
    if (outputDef && typeof target === "string" && target) vars[target] = result;
  };

  const runControl = async (step: Step): Promise<void> => {
    const slots = step.slots ?? {};
    switch (step.type) {
      case "core.sequence":
        return runSteps(slots.body);
      case "core.if": {
        const { condition } = resolveProps(step);
        return runSteps(condition ? slots.then : slots.else);
      }
      case "core.forEach": {
        const props = resolveProps(step);
        const items = props.items;
        if (items === undefined || items === null) return;
        const list: unknown[] = Array.isArray(items)
          ? items
          : typeof items === "object" && Symbol.iterator in (items as object)
            ? Array.from(items as Iterable<unknown>)
            : typeof items === "object"
              ? Object.entries(items as object).map(([key, value]) => ({ key, value }))
              : [items];
        const itemVar = String(props.itemVariable || "item");
        const indexVar = props.indexVariable ? String(props.indexVariable) : undefined;
        for (let i = 0; i < list.length; i++) {
          vars[itemVar] = list[i];
          if (indexVar) vars[indexVar] = i;
          try {
            await runSteps(slots.body);
          } catch (err) {
            if (err instanceof BreakSignal) break;
            throw err;
          }
        }
        return;
      }
      case "core.while": {
        const max = Number(resolveProps(step).maxIterations ?? 1000);
        let i = 0;
        while (resolveProps(step).condition) {
          if (++i > max) throw new Error(`While loop exceeded ${max} iterations`);
          try {
            await runSteps(slots.body);
          } catch (err) {
            if (err instanceof BreakSignal) break;
            throw err;
          }
        }
        return;
      }
      case "core.tryCatch": {
        const errorVar = String(resolveProps(step).errorVariable || "error");
        try {
          await runSteps(slots.try);
        } catch (err) {
          if (err instanceof BreakSignal || err instanceof CancelledError) throw err;
          vars[errorVar] = { message: errorMessage(err), name: err instanceof Error ? err.name : "Error" };
          await runSteps(slots.catch);
        } finally {
          if (!signal.aborted) await runSteps(slots.finally);
        }
        return;
      }
      case "core.break":
        throw new BreakSignal();
    }
  };

  let status: RunResult["status"] = "succeeded";
  let error: string | undefined;
  try {
    await runStep(workflow.root);
  } catch (err) {
    if (err instanceof BreakSignal) {
      /* a stray Break outside a loop just ends the workflow */
    } else if (err instanceof CancelledError || signal.aborted) {
      status = "cancelled";
      error = "Cancelled";
    } else {
      status = "failed";
      error = errorMessage(err);
      emit({ type: "log", time: now(), level: "error", message: error });
    }
  } finally {
    // A called workflow leaves its resources (e.g. the open browser) to its caller.
    for (const dispose of options.shared ? [] : disposers.reverse()) {
      try {
        await dispose();
      } catch (err) {
        emit({ type: "log", time: now(), level: "warn", message: `Cleanup failed: ${errorMessage(err)}` });
      }
    }
  }

  const outputs: Record<string, unknown> = {};
  for (const v of workflow.variables) {
    if (v.direction === "out" || v.direction === "inout") outputs[v.name] = vars[v.name];
  }
  return { status, outputs, error, durationMs: Date.now() - started };
}
