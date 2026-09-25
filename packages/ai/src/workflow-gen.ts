import { BUILTIN_ACTIONS, newStepId, safeParseWorkflow, walkSteps } from "@zamtest/core";
import type { ActionMeta, Workflow } from "@zamtest/core";
import type { AiClient, BetaMessageParam } from "./client.js";
import { extractJson, textOf } from "./client.js";

export const FORMAT = `A workflow is JSON:
{
  "schemaVersion": 1,
  "id": "<kebab-case id>",
  "name": "<human name>",
  "description": "<one sentence>",
  "variables": [ { "name": "invoiceTotal", "type": "number", "default": 0, "direction": "local", "description": "..." } ],
  "root": { "id": "root", "type": "core.sequence", "props": {}, "slots": { "body": [ <steps> ] } }
}
A step is { "id": "<unique>", "type": "<action type>", "label": "<short label>", "props": { ... }, "slots": { "<slot>": [ <steps> ] } }.
Only container actions have "slots", using exactly the slot names listed for them.
Optional per-step fields: "continueOnError": true, "retry": { "count": 2, "delayMs": 1000 }, "timeoutMs": 30000.

Property value rules:
- "expression" props are JavaScript expressions over workflow variables, e.g. "rows.length > 0".
- Other string props may embed templates: "Hello {{ customer.name }}". A value that is exactly "{{ x }}" keeps x's type.
- "variable" props hold a bare variable name (no braces). Declare every variable you use in "variables"
  (loop item/index variables included).
- "selector" props use Playwright syntax (css=..., role=button[name="..."], text="...", internal:label="...").
- "selector" props of desktop.* actions (Windows applications) use the desktop grammar instead: segments separated by ">",
  each a lower-case UI Automation control type with [name="..."], [id="..."], [class="..."], [process="..."] (first segment only) or [index=N],
  operators = ~= ^= $=. Example: window[process="notepad"] > document, window[name$=" - Notepad"] > menuitem[name="File"].
  Start desktop processes with desktop.launch (waitFor set to the window selector).
  When you cannot see the page, write your best guess and ALWAYS fill the "description" prop so selectors can be healed at run time.
- Use "core.getAsset" for credentials and configuration; never hard-code secrets.
- Dynamic targets: a step that should act on one item of a list (rows, cards, list items, dropdown options, search results)
  chosen when it runs, not a fixed one, keeps one example item in "selector" and adds props.list:
  { "items": "<selector matching every item>", "inner": "<optional: part inside the item>",
    "skipIfHas": "<optional: selector inside an item; items containing it are skipped, e.g. an offline icon>",
    "onlyText": "<optional>", "skipText": "<optional>", "which": "first" | "last" | "random" | "next" }
  ("next" tries the items in turn until the step works). Use it whenever the person says "any", "first available",
  "an online one", or the item may change between runs.`;

export function catalogPrompt(catalog: ActionMeta[]): string {
  return catalog
    .map((a) => {
      const props = a.props
        .map((p) => `${p.name}:${p.type}${p.required ? "*" : ""}${p.options ? `(${p.options.join("|")})` : ""}`)
        .join(", ");
      const slots = a.slots?.length ? ` slots=[${a.slots.join(", ")}]` : "";
      return `- ${a.type} - ${a.description} props: {${props}}${slots}`;
    })
    .join("\n");
}

export interface GenerateWorkflowInput {
  prompt: string;
  /** When present, the model edits this workflow instead of starting from scratch. */
  existing?: Workflow;
  catalog?: ActionMeta[];
  /** English name of the user's language, e.g. "Japanese". Defaults to English. */
  language?: string;
  /** The account's assets (names and types, never values), so steps use ones that exist. */
  assets?: Array<{ name: string; type: string }>;
  /** A Windows application's window as it is on the person's PC: its controls (and the screen), for real selectors. */
  live?: { selector: string; tree: string; screen?: Buffer };
}

export interface GenerateWorkflowResult {
  workflow: Workflow;
  notes: string;
}

/**
 * Builds (or edits) a whole automation project from a natural-language
 * description. The result is validated against the workflow schema and the
 * action catalog; validation errors are sent back to Claude once to fix.
 */
export async function generateWorkflow(ai: AiClient, input: GenerateWorkflowInput): Promise<GenerateWorkflowResult> {
  const catalog = input.catalog ?? BUILTIN_ACTIONS;
  const system = `You are the automation architect inside ZamTech AI, a low-code RPA platform.
You design workflows that are reliable in production: validate inputs, wrap fragile UI work in Try/Catch,
log progress with meaningful messages, add retries on flaky network or UI steps, and close browsers you open.

${FORMAT}

Available actions (* = required prop):
${catalogPrompt(catalog)}

Reply with a short explanation of the design (max 5 bullet points), then the complete workflow JSON in a single \`\`\`json block.`;

  const request = input.existing
    ? `Modify this workflow as requested.\n\nRequest: ${input.prompt}\n\nCurrent workflow:\n\`\`\`json\n${JSON.stringify(input.existing, null, 2)}\n\`\`\``
    : `Build a workflow for this automation:\n\n${input.prompt}`;

  const languageNote =
    input.language && input.language !== "English"
      ? `\n\nWrite the design explanation and all human-readable text in the workflow (name, description, step labels, log messages, ` +
        `target descriptions, variable descriptions) in ${input.language}. Keep action types, prop names, variable names, ` +
        `selectors and expressions exactly as the format requires (variable names must be ASCII identifiers).`
      : "";
  const context: string[] = [];
  if (input.assets?.length) {
    context.push(`Assets that exist in this account (use these exact names with core.getAsset; values are hidden):\n${input.assets.map((a) => `- ${a.name} (${a.type})`).join("\n")}`);
  }
  if (input.live) {
    context.push(
      `The application's window ${input.live.selector} as it is open on the person's PC now. Its controls (control type, name, id, class;` +
        ` indentation = nesting) are the truth: build desktop selectors from them, starting with ${input.live.selector}:\n${input.live.tree}`,
    );
  }
  const content: Exclude<BetaMessageParam["content"], string> = [{ type: "text", text: [request + languageNote, ...context].join("\n\n") }];
  if (input.live?.screen) {
    content.push({ type: "text", text: "The window on screen:" });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: input.live.screen.toString("base64") } });
  }
  const messages: BetaMessageParam[] = [{ role: "user", content }];
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await ai.create({
      max_tokens: 64000,
      system,
      output_config: { effort: "high" },
      messages,
    });
    const text = textOf(message);
    const { workflow, errors } = validateGenerated(text, catalog);
    if (workflow && errors.length === 0) {
      return { workflow, notes: text.replace(/```(?:json)?[\s\S]*?```/i, "").trim() };
    }
    lastErrors = errors;
    messages.push({ role: "assistant", content: message.content });
    messages.push({
      role: "user",
      content: `The workflow failed validation:\n- ${errors.join("\n- ")}\nReturn the corrected complete workflow JSON.`,
    });
  }
  throw new Error(`AI could not produce a valid workflow: ${lastErrors.join("; ")}`);
}

function validateGenerated(text: string, catalog: ActionMeta[]): { workflow?: Workflow; errors: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
  const parsed = safeParseWorkflow(raw);
  if (!parsed.success) {
    return { errors: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const workflow = parsed.data;
  const errors: string[] = [];
  const types = new Map(catalog.map((a) => [a.type, a]));
  const seen = new Set<string>();
  walkSteps(workflow.root, (step) => {
    if (seen.has(step.id)) step.id = newStepId();
    seen.add(step.id);
    const meta = types.get(step.type);
    if (!meta) {
      errors.push(`Unknown action type "${step.type}" (step ${step.id})`);
      return;
    }
    for (const slot of Object.keys(step.slots ?? {})) {
      if (!meta.slots?.includes(slot)) errors.push(`"${step.type}" has no slot "${slot}" (step ${step.id})`);
    }
  });
  return { workflow, errors };
}
