/**
 * Small, reviewable edits to a workflow ("change the selector of step 5", "add a
 * wait before it"), as AI fixes propose them. The Designer shows each change
 * and applies them; the server applies them once to check the result is valid.
 */
import { z } from "zod";
import { StepSchema } from "./schema.js";
import type { Step, VariableDef, Workflow } from "./schema.js";

export type StepChange =
  /** Props given are replaced (null removes one); the others stay. */
  | {
      op: "update";
      stepId: string;
      label?: string;
      props?: Record<string, unknown>;
      disabled?: boolean;
      continueOnError?: boolean;
      retry?: { count: number; delayMs?: number } | null;
      timeoutMs?: number | null;
    }
  /** Goes right after or before a step, or at an index of a container's slot (for an empty one). */
  | { op: "insert"; after?: string; before?: string; parentId?: string; slot?: string; index?: number; step: Step }
  | { op: "remove"; stepId: string };

export const StepChangeSchema: z.ZodType<StepChange> = z.union([
  z.object({
    op: z.literal("update"),
    stepId: z.string().min(1),
    label: z.string().optional(),
    props: z.record(z.unknown()).optional(),
    disabled: z.boolean().optional(),
    continueOnError: z.boolean().optional(),
    retry: z.object({ count: z.number().int().min(0).max(10), delayMs: z.number().int().min(0).optional() }).nullable().optional(),
    timeoutMs: z.number().int().min(0).nullable().optional(),
  }),
  z.object({
    op: z.literal("insert"),
    after: z.string().optional(),
    before: z.string().optional(),
    parentId: z.string().optional(),
    slot: z.string().optional(),
    index: z.number().int().min(0).optional(),
    step: StepSchema,
  }),
  z.object({ op: z.literal("remove"), stepId: z.string().min(1) }),
]);

/** Where a step sits: the list that holds it and its index there. */
function locate(root: Step, id: string): { list: Step[]; index: number } | undefined {
  for (const children of Object.values(root.slots ?? {})) {
    const index = children.findIndex((s) => s.id === id);
    if (index >= 0) return { list: children, index };
    for (const child of children) {
      const found = locate(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

function findStep(step: Step, id: string): Step | undefined {
  if (step.id === id) return step;
  for (const children of Object.values(step.slots ?? {})) {
    for (const child of children) {
      const found = findStep(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Applies the changes in order to a copy of the workflow, with the new
 * variables (those not declared yet). Throws with a readable message when a
 * change does not fit (unknown step, ...).
 */
export function applyStepChanges(workflow: Workflow, changes: StepChange[], variables: VariableDef[] = []): Workflow {
  const next = JSON.parse(JSON.stringify(workflow)) as Workflow;
  for (const change of changes) {
    if (change.op === "update") {
      const step = findStep(next.root, change.stepId);
      if (!step || step === next.root) throw new Error(`Step ${change.stepId} is not in the workflow`);
      if (change.label !== undefined) step.label = change.label;
      if (change.disabled !== undefined) step.disabled = change.disabled || undefined;
      if (change.continueOnError !== undefined) step.continueOnError = change.continueOnError || undefined;
      if (change.retry !== undefined) step.retry = change.retry ?? undefined;
      if (change.timeoutMs !== undefined) step.timeoutMs = change.timeoutMs ?? undefined;
      for (const [name, value] of Object.entries(change.props ?? {})) {
        if (value === null) delete step.props[name];
        else step.props[name] = value;
      }
    } else if (change.op === "remove") {
      const at = locate(next.root, change.stepId);
      if (!at) throw new Error(`Step ${change.stepId} is not in the workflow`);
      at.list.splice(at.index, 1);
    } else {
      if (findStep(next.root, change.step.id)) throw new Error(`A step with id ${change.step.id} is already in the workflow`);
      const anchor = change.after ?? change.before;
      if (anchor) {
        const at = locate(next.root, anchor);
        if (!at) throw new Error(`Step ${anchor} is not in the workflow`);
        at.list.splice(change.after ? at.index + 1 : at.index, 0, change.step);
      } else {
        const parent = findStep(next.root, change.parentId ?? next.root.id);
        if (!parent) throw new Error(`Step ${change.parentId} is not in the workflow`);
        const slot = change.slot ?? "body";
        parent.slots = { ...parent.slots, [slot]: parent.slots?.[slot] ?? [] };
        const list = parent.slots[slot]!;
        list.splice(Math.min(change.index ?? list.length, list.length), 0, change.step);
      }
    }
  }
  const names = new Set(next.variables.map((v) => v.name));
  next.variables = [...next.variables, ...variables.filter((v) => !names.has(v.name))];
  return next;
}

