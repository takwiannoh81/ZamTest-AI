import { z } from "zod";

/**
 * A workflow is a tree of steps. Every step has a `type` that points at an
 * activity in the catalog (e.g. "core.log", "browser.click"). Container
 * activities (sequence, if, forEach, tryCatch...) hold child steps in named
 * slots, e.g. `{ then: [...], else: [...] }`.
 *
 * Property values are plain JSON. Strings may contain `{{ expression }}`
 * templates that are evaluated against workflow variables at run time.
 */

export interface Step {
  id: string;
  type: string;
  label?: string;
  disabled?: boolean;
  props: Record<string, unknown>;
  slots?: Record<string, Step[]>;
  /** Keep running the parent sequence if this step throws. */
  continueOnError?: boolean;
  retry?: { count: number; delayMs?: number };
  timeoutMs?: number;
}

export const StepSchema: z.ZodType<Step> = z.lazy(() =>
  z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    label: z.string().optional(),
    disabled: z.boolean().optional(),
    props: z.record(z.unknown()).default({}),
    slots: z.record(z.array(StepSchema)).optional(),
    continueOnError: z.boolean().optional(),
    retry: z
      .object({ count: z.number().int().min(0).max(20), delayMs: z.number().int().min(0).optional() })
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
) as z.ZodType<Step>;

export const VariableTypeSchema = z.enum(["string", "number", "boolean", "object", "array", "any"]);
export type VariableType = z.infer<typeof VariableTypeSchema>;

export const VariableDefSchema = z.object({
  name: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "Variable names must be valid identifiers"),
  type: VariableTypeSchema.default("any"),
  default: z.unknown().optional(),
  /** "in" arguments can be supplied when a job starts; "out" are returned on completion. */
  direction: z.enum(["local", "in", "out", "inout"]).default("local"),
  description: z.string().optional(),
});
export type VariableDef = z.infer<typeof VariableDefSchema>;

export const WorkflowSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  variables: z.array(VariableDefSchema).default([]),
  root: StepSchema,
});
export type Workflow = z.infer<typeof WorkflowSchema>;

/* ------------------------------------------------------------------ */
/* Activity metadata (what the Designer needs to render the palette    */
/* and the properties panel). Implementations live elsewhere.          */
/* ------------------------------------------------------------------ */

export const PropTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "boolean",
  "expression",
  "selector",
  "variable",
  "enum",
  "json",
  "secret",
]);
export type PropType = z.infer<typeof PropTypeSchema>;

export const PropDefSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: PropTypeSchema,
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
  /** Output props name the variable the activity writes its result into. */
  output: z.boolean().optional(),
});
export type PropDef = z.infer<typeof PropDefSchema>;

export const ActivityMetaSchema = z.object({
  type: z.string(),
  displayName: z.string(),
  category: z.string(),
  description: z.string(),
  icon: z.string().optional(),
  props: z.array(PropDefSchema),
  /** Named child slots for container activities. */
  slots: z.array(z.string()).optional(),
  /** Whether an AI agent may call this activity as a tool. */
  agentTool: z.boolean().optional(),
});
export type ActivityMeta = z.infer<typeof ActivityMetaSchema>;

export function parseWorkflow(input: unknown): Workflow {
  return WorkflowSchema.parse(input);
}

export function safeParseWorkflow(input: unknown) {
  return WorkflowSchema.safeParse(input);
}

let idCounter = 0;
export function newStepId(prefix = "s"): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Depth-first walk over every step in a workflow. */
export function walkSteps(step: Step, visit: (step: Step, parent?: Step) => void, parent?: Step): void {
  visit(step, parent);
  for (const children of Object.values(step.slots ?? {})) {
    for (const child of children) walkSteps(child, visit, step);
  }
}
