import { z } from "zod";
import { applyStepChanges, BUILTIN_ACTIONS, safeParseWorkflow, StepChangeSchema, VariableDefSchema, walkSteps } from "@zamtest/core";
import type { ActionMeta, StepChange, VariableDef, Workflow } from "@zamtest/core";
import type { AiClient, BetaMessageParam } from "./client.js";
import { extractJson, textOf } from "./client.js";
import { catalogPrompt, FORMAT } from "./workflow-gen.js";

/** What a failed run left behind, for Claude to find the cause. */
export interface DiagnoseInput {
  workflow: Workflow;
  error: string;
  failedStepId?: string;
  logs: Array<{ time: string; level: string; message: string; stepId?: string }>;
  /** Step screenshots (JPEG), oldest first; the failed step's last. */
  screenshots?: Array<{ stepId: string; label?: string; status: "ok" | "error"; jpeg: Buffer }>;
  /** The workspace's assets: names and types only, never values. */
  assets?: Array<{ name: string; type: string; environment?: string }>;
  pc?: { name: string; os?: string; version?: string; environment?: string };
  /** With environments on: the run's environment (the PC takes only its own). */
  environment?: string;
  /** The application's window as it is now on the PC: its controls, and the screen. */
  live?: { selector: string; found: boolean; tree: string; windows?: string; screen?: Buffer };
  /** Earlier rounds of "keep fixing" that did not make the run pass. */
  previousAttempts?: string[];
  catalog?: ActionMeta[];
  /** English name of the person's language. */
  language?: string;
}

export type Fix =
  | { kind: "editSteps"; title: string; why: string; changes: StepChange[]; variables?: VariableDef[] }
  | { kind: "createAsset"; title: string; why: string; name: string; assetType: "text" | "number" | "boolean" | "credential"; environment?: "dev" | "test" | "prod"; description?: string }
  | { kind: "setPcEnvironment"; title: string; why: string; environment: "dev" | "test" | "prod" }
  | { kind: "manual"; title: string; why: string; instructions: string[] };

export interface Diagnosis {
  /** One or two plain sentences: what went wrong. */
  summary: string;
  /** Where the problem is. */
  cause: "workflow" | "selector" | "asset" | "environment" | "application" | "pc" | "data" | "unknown";
  /** The reasoning, with the evidence it rests on. */
  details: string;
  fixes: Fix[];
}

const ASSET_NAME = /^[A-Za-z0-9_.\/-]+$/;

const FixSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("editSteps"),
    title: z.string().min(1),
    why: z.string().default(""),
    changes: z.array(StepChangeSchema).min(1).max(40),
    variables: z.array(VariableDefSchema).optional(),
  }),
  z.object({
    kind: z.literal("createAsset"),
    title: z.string().min(1),
    why: z.string().default(""),
    name: z.string().regex(ASSET_NAME, "asset names use letters, digits, '.', '_', '-' or '/'"),
    assetType: z.enum(["text", "number", "boolean", "credential"]),
    environment: z.enum(["dev", "test", "prod"]).optional(),
    description: z.string().optional(),
  }),
  z.object({ kind: z.literal("setPcEnvironment"), title: z.string().min(1), why: z.string().default(""), environment: z.enum(["dev", "test", "prod"]) }),
  z.object({ kind: z.literal("manual"), title: z.string().min(1), why: z.string().default(""), instructions: z.array(z.string()).min(1).max(12) }),
]);

const DiagnosisSchema = z.object({
  summary: z.string().min(1),
  cause: z.enum(["workflow", "selector", "asset", "environment", "application", "pc", "data", "unknown"]).catch("unknown"),
  details: z.string().default(""),
  fixes: z.array(FixSchema).max(6),
});

const ANSWER = `Answer with a single \`\`\`json block (nothing after it) of this shape:
{
  "summary": "<1-2 plain sentences for a non-programmer: what went wrong>",
  "cause": "workflow" | "selector" | "asset" | "environment" | "application" | "pc" | "data" | "unknown",
  "details": "<short explanation citing the evidence: log lines, what the screenshot shows, the controls list>",
  "fixes": [ <0-6 fixes, most important first> ]
}
A fix is one of:
- { "kind": "editSteps", "title": "...", "why": "...", "changes": [ <changes> ], "variables": [ <new variables, optional> ] }
  A change is { "op": "update", "stepId": "...", "props": { "<prop>": <new value or null to remove> }, "label"?, "disabled"?, "continueOnError"?, "retry"?: {"count":2,"delayMs":1000} | null, "timeoutMs"?: <ms> | null }
           or { "op": "insert", "after": "<stepId>" | "before": "<stepId>", "step": <complete new step with a new unique id> }
           or { "op": "insert", "parentId": "<container step id>", "slot": "<slot>", "index": 0, "step": <step> }
           or { "op": "remove", "stepId": "..." }
- { "kind": "createAsset", "title": "...", "why": "...", "name": "<asset name>", "assetType": "text" | "number" | "boolean" | "credential", "environment"?: "dev" | "test" | "prod", "description"?: "..." }
  The person types the value (never ask for or invent a secret value).
- { "kind": "setPcEnvironment", "title": "...", "why": "...", "environment": "dev" | "test" | "prod" }
- { "kind": "manual", "title": "...", "why": "...", "instructions": [ "<step the person does outside the workflow>", ... ] }`;

const RULES = `How to diagnose:
- Find the real cause from the evidence before proposing anything. The failing step is marked; the log and screenshots show what happened.
- Keep fixes minimal: change only what is needed, keep step ids, never rewrite unrelated steps.
- Assets: names use letters, digits, '.', '_', '-' and '/'; a name is matched exactly. If a step asks for an asset that does not
  exist and a similarly named one does (other case, separator or spelling), fix the step to use the existing name. Otherwise
  propose "createAsset" (with the exact name the step uses, if that name is valid; if not, fix the step to a valid name and
  create that). For a credential, the step's output is { username, password } (e.g. {{ credential.password }}).
- Selectors: when the live controls list of the window is given, it is the truth: pick the selector from it (prefer a stable
  id, then name, then control type with index), for every step that targets a control that is not there or named differently.
  If the window was not found, say what windows are open, and fix the step that should open or wait for it.
- Use timeouts, "desktop.waitFor"/"browser.waitFor" steps or retries only when the evidence shows a timing problem.
- A cause outside the workflow (application not installed, wrong password, server unreachable, PC offline, missing browser)
  gets a "manual" fix in plain words; do not pretend a workflow change will fix it.
- If you cannot tell, say what is missing and propose how to find out (e.g. a Take Screenshot step), with cause "unknown".
- If earlier rounds are listed, do not repeat a fix that already failed; try the next most likely cause.
- When a step failed because one fixed item of a list is gone, renamed or unavailable (a row, a camera, a card), propose
  props.list on it (see the format) so it picks a suitable item when it runs, e.g. the first one without the offline mark.`;

/** Finds why a run failed and proposes fixes the Designer can apply. */
export async function diagnoseRun(ai: AiClient, input: DiagnoseInput): Promise<Diagnosis> {
  const catalog = input.catalog ?? BUILTIN_ACTIONS;
  const system = `You are the debugging expert inside ZamTech AI, a low-code RPA and test automation platform.
A workflow run failed. You look at the evidence (the workflow, the log, step screenshots, the assets that exist, the PC and,
when given, the live list of controls of the application window) and find the cause, then propose fixes the person can apply.

${FORMAT}

Available actions (* = required prop):
${catalogPrompt(catalog)}

${RULES}

${ANSWER}`;

  const language =
    input.language && input.language !== "English"
      ? `\n\nWrite summary, details, titles, "why" texts, instructions and step labels in ${input.language}. Keep ids, prop names, selectors and expressions as they are.`
      : "";

  const content: Exclude<BetaMessageParam["content"], string> = [];
  const text = (t: string) => content.push({ type: "text", text: t });
  text(`The run failed with: ${input.error}${input.failedStepId ? `\nFailing step id: ${input.failedStepId}` : ""}`);
  text(`Workflow:\n\`\`\`json\n${JSON.stringify(input.workflow, null, 2)}\n\`\`\``);
  text(`Log (oldest first):\n${input.logs.slice(-150).map((l) => `${l.time} ${l.level.toUpperCase()} ${l.stepId ? `[${l.stepId}] ` : ""}${l.message}`).join("\n")}`);
  const assets = input.assets ?? [];
  text(
    assets.length
      ? `Assets that exist in this account (values hidden):\n${assets.map((a) => `- ${a.name} (${a.type}${a.environment ? `, only ${a.environment}` : ""})`).join("\n")}`
      : "This account has no assets yet.",
  );
  if (input.pc) {
    text(`It ran on the PC "${input.pc.name}" (${input.pc.os ?? "unknown OS"}, agent ${input.pc.version ?? "?"}${input.pc.environment ? `, environment ${input.pc.environment}` : ""}).${input.environment ? ` The run's environment: ${input.environment}.` : ""}`);
  }
  for (const shot of input.screenshots ?? []) {
    text(`Screenshot after step ${shot.stepId}${shot.label ? ` "${shot.label}"` : ""} (${shot.status === "error" ? "the step FAILED" : "step passed"}):`);
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.jpeg.toString("base64") } });
  }
  if (input.live) {
    text(
      input.live.found
        ? `Live controls of the window ${input.live.selector} on the PC now (control type, name, id, class; indentation = nesting):\n${input.live.tree}`
        : `The window ${input.live.selector} is NOT open on the PC now. Open windows:\n${input.live.windows ?? input.live.tree}`,
    );
    if (input.live.screen) {
      text("The PC's screen now:");
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.live.screen.toString("base64") } });
    }
  }
  if (input.previousAttempts?.length) text(`Earlier rounds that did not make the run pass:\n${input.previousAttempts.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  text(`Find the cause and propose the fixes.${language}`);

  const messages: BetaMessageParam[] = [{ role: "user", content }];
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await ai.create({ max_tokens: 32000, system, output_config: { effort: "high" }, messages });
    const reply = textOf(message);
    const { diagnosis, errors } = check(reply, input.workflow, catalog);
    if (diagnosis && !errors.length) return diagnosis;
    lastErrors = errors;
    messages.push({ role: "assistant", content: message.content });
    messages.push({ role: "user", content: `That answer has problems:\n- ${errors.join("\n- ")}\nReturn the corrected complete JSON.` });
  }
  throw new Error(`AI could not produce a usable diagnosis: ${lastErrors.join("; ")}`);
}

/** Parses the answer and tries each step fix on the workflow, so only fixes that apply cleanly reach the person. */
function check(reply: string, workflow: Workflow, catalog: ActionMeta[]): { diagnosis?: Diagnosis; errors: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(reply);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
  const parsed = DiagnosisSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, 15).map((i) => `${i.path.join(".")}: ${i.message}`) };
  const diagnosis = parsed.data as Diagnosis;
  const types = new Set(catalog.map((a) => a.type));
  const errors: string[] = [];
  diagnosis.fixes.forEach((fix, i) => {
    if (fix.kind !== "editSteps") return;
    try {
      const next = applyStepChanges(workflow, fix.changes, fix.variables);
      const valid = safeParseWorkflow(next);
      if (!valid.success) errors.push(`fixes[${i}] makes an invalid workflow: ${valid.error.issues[0]?.message}`);
      walkSteps(next.root, (s) => {
        if (!types.has(s.type)) errors.push(`fixes[${i}] uses unknown action type "${s.type}"`);
      });
    } catch (err) {
      errors.push(`fixes[${i}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return { diagnosis, errors };
}
