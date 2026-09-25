import { BUILTIN_ACTIONS, newStepId, safeParseWorkflow, walkSteps } from "@zamtest/core";
import type { ActionMeta, Step, VariableDef, Workflow } from "@zamtest/core";
import type { AiClient, BetaMessageParam } from "./client.js";
import { extractJson, textOf } from "./client.js";
import { catalogPrompt, FORMAT } from "./workflow-gen.js";

/** A page the agent visited on the person's PC. */
export interface SitePage {
  url: string;
  title: string;
  /** The page before the person signed in: its fields are the sign-in form. */
  beforeSignIn?: boolean;
  headings: string[];
  text: string;
  fields: Array<{ selector: string; description: string; type: string; required?: boolean; options?: string[] }>;
  buttons: Array<{ selector: string; description: string }>;
  links: Array<{ selector: string; text: string; href: string }>;
  tables: Array<{ selector: string; headers: string[]; rows: number }>;
  /** JPEG. */
  screen?: Buffer;
}

export interface GenerateTestsInput {
  pages: SitePage[];
  /** How the tests sign in: not at all, with steps added before each test, or with a credential asset (AI writes the steps). */
  signIn: { kind: "none" } | { kind: "steps"; description: string } | { kind: "asset"; asset: string };
  /** What the person wants tested (optional). */
  focus?: string;
  count: number;
  assets?: Array<{ name: string; type: string }>;
  catalog?: ActionMeta[];
  /** English name of the person's language. */
  language?: string;
}

export interface GeneratedTest {
  name: string;
  description: string;
  /** The page it tests (for grouping). */
  page?: string;
  steps: Step[];
  variables: VariableDef[];
}

export interface GenerateTestsResult {
  tests: GeneratedTest[];
  /** A short summary of what was covered and what was left out. */
  notes: string;
}

/** Screens AI sees (the rest are text only). */
const MAX_SCREENS = 10;

const RULES = `How to write the tests:
- Each test checks ONE thing a user cares about (a page loads with its key content, navigation reaches the right page, a form
  rejects invalid input, a search or filter shows results, a table lists data, a menu opens). Prefer what matters to the business
  over trivia. Cover the most important pages first. No two tests check the same thing.
- Use ONLY selectors that appear in the page data below (fields, buttons, links, tables); never invent ids or classes.
  For text on the page, "text=\\"...\\"" with text that is in the page's visible text is fine. Fill every step's "description"
  prop when the action has one, so broken selectors can be healed.
- Check with the Verify actions (browser.verifyText with text that is really on the page, browser.verifyVisible,
  browser.verifyTitle, browser.verifyUrl). Every test has at least one check after its actions.
- Never do anything that changes or deletes real data or costs money: do not submit forms that create, save, send, pay, order,
  delete, approve or sign out, unless the person's focus asks for it. Checking that a form refuses empty or invalid input
  (submit it empty and verify the error message) is fine when the page data shows required fields.
- Tests are independent: each one opens what it needs and ends with browser.close.
- Wait for slow pages with browser.waitFor (a selector from the page) before checking, when the page loads data.
- Name each test in a few words ("Dashboard shows the orders list") and describe in one sentence what it checks.`;

const SIGN_IN = {
  none: "The site needs no sign-in: each test starts with browser.open at the address of the page it tests.",
  steps: (d: string) =>
    `Sign-in steps are added before each test automatically (${d}); after them the browser is open and signed in. Do NOT open the browser ` +
    `or sign in: start each test with browser.navigate to the address of the page it tests.`,
  asset: (a: string) =>
    `Each test signs in itself, first: core.getAsset with name "${a}" (a credential; its value is { username, password }) saved to a ` +
    `variable (declare it), browser.open at the sign-in page's address, browser.type of {{ <var>.username }} and {{ <var>.password }} into ` +
    `the sign-in page's fields (the page marked BEFORE SIGN-IN), and a click on its sign-in button; then browser.waitFor something ` +
    `on the page after sign-in, then browser.navigate to the page it tests.`,
};

const ANSWER = `Answer with a short summary (what you covered, what you left out and why, max 5 bullet points), then a single \`\`\`json block:
{ "tests": [ { "name": "...", "description": "...", "page": "<address of the page it tests>",
  "variables": [ <variable definitions, as in the workflow format> ], "steps": [ <steps, as in the workflow format> ] } ] }`;

function pageText(p: SitePage, i: number): string {
  const lines = [`PAGE ${i + 1}${p.beforeSignIn ? " (BEFORE SIGN-IN: the sign-in page)" : ""}: ${p.title || "(no title)"}`, `Address: ${p.url}`];
  if (p.headings.length) lines.push(`Headings: ${p.headings.join(" | ")}`);
  if (p.fields.length) lines.push(`Fields:\n${p.fields.map((f) => `- ${f.selector} | ${f.description} | ${f.type}${f.required ? " | required" : ""}${f.options?.length ? ` | options: ${f.options.join(", ")}` : ""}`).join("\n")}`);
  if (p.buttons.length) lines.push(`Buttons:\n${p.buttons.map((b) => `- ${b.selector} | ${b.description}`).join("\n")}`);
  if (p.links.length) lines.push(`Links:\n${p.links.map((l) => `- ${l.selector} | ${l.text} -> ${l.href}`).join("\n")}`);
  if (p.tables.length) lines.push(`Tables:\n${p.tables.map((t) => `- ${t.selector} | columns: ${t.headers.join(", ") || "?"} | ${t.rows} rows`).join("\n")}`);
  if (p.text) lines.push(`Visible text:\n${p.text}`);
  return lines.join("\n");
}

/** Writes test cases for a website from the pages the agent visited. */
export async function generateTests(ai: AiClient, input: GenerateTestsInput): Promise<GenerateTestsResult> {
  const catalog = input.catalog ?? BUILTIN_ACTIONS;
  // Test cases of websites: web, verify and core actions only.
  const actions = catalog.filter((a) => a.type.startsWith("browser.") || a.type.startsWith("core.") || a.type.startsWith("verify."));
  const system = `You are the test automation lead inside ZamTech AI, a low-code test automation platform. You look at a website that
the agent explored on the person's PC and write its automated test cases. Each test case is a workflow's steps.

${FORMAT}

Available actions (* = required prop):
${catalogPrompt(actions)}

${RULES}

${ANSWER}`;

  const signIn = input.signIn.kind === "none" ? SIGN_IN.none : input.signIn.kind === "steps" ? SIGN_IN.steps(input.signIn.description) : SIGN_IN.asset(input.signIn.asset);
  const language =
    input.language && input.language !== "English"
      ? `\n\nWrite the summary, test names, descriptions, step labels and log messages in ${input.language}. Keep action types, prop names, variable names and selectors as they are; text to verify stays exactly as it is on the page.`
      : "";
  const content: Exclude<BetaMessageParam["content"], string> = [];
  const text = (t: string) => content.push({ type: "text", text: t });
  text(`Write ${input.count} test cases for this website.${input.focus ? `\nWhat the person wants tested: ${input.focus}` : ""}\n\n${signIn}${language}`);
  if (input.assets?.length) text(`Assets in this account (names only):\n${input.assets.map((a) => `- ${a.name} (${a.type})`).join("\n")}`);
  let screens = 0;
  input.pages.forEach((p, i) => {
    text(pageText(p, i));
    if (p.screen && screens < MAX_SCREENS) {
      screens++;
      text(`The screen of page ${i + 1}:`);
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.screen.toString("base64") } });
    }
  });

  const messages: BetaMessageParam[] = [{ role: "user", content }];
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const message = await ai.create({ max_tokens: 64000, system, output_config: { effort: "high" }, messages });
    const reply = textOf(message);
    const { tests, errors } = checkTests(reply, actions, input.count);
    if (tests && !errors.length) return { tests, notes: reply.replace(/```(?:json)?[\s\S]*?```/i, "").trim() };
    lastErrors = errors;
    messages.push({ role: "assistant", content: message.content });
    messages.push({ role: "user", content: `These tests have problems:\n- ${errors.join("\n- ")}\nReturn the corrected complete JSON.` });
  }
  throw new Error(`AI could not write valid tests: ${lastErrors.slice(0, 5).join("; ")}`);
}

/** Each test must be a valid workflow of known actions. */
export function checkTests(reply: string, catalog: ActionMeta[], max: number): { tests?: GeneratedTest[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = extractJson(reply);
  } catch (err) {
    return { errors: [err instanceof Error ? err.message : String(err)] };
  }
  const list = (raw as { tests?: unknown })?.tests;
  if (!Array.isArray(list) || !list.length) return { errors: ['The JSON needs a non-empty "tests" array'] };
  const types = new Map(catalog.map((a) => [a.type, a]));
  const errors: string[] = [];
  const tests: GeneratedTest[] = [];
  list.slice(0, Math.max(max, 1) + 2).forEach((t: Record<string, unknown>, i) => {
    const name = typeof t?.name === "string" && t.name.trim() ? t.name.trim().slice(0, 200) : "";
    if (!name) errors.push(`tests[${i}] has no name`);
    const parsed = safeParseWorkflow({
      schemaVersion: 1,
      id: `test-${i + 1}`,
      name: name || `Test ${i + 1}`,
      variables: t?.variables ?? [],
      root: { id: "root", type: "core.sequence", props: {}, slots: { body: t?.steps ?? [] } },
    });
    if (!parsed.success) {
      errors.push(...parsed.error.issues.slice(0, 5).map((issue) => `tests[${i}].${issue.path.join(".")}: ${issue.message}`));
      return;
    }
    const workflow: Workflow = parsed.data;
    const seen = new Set<string>();
    let checks = 0;
    walkSteps(workflow.root, (step) => {
      if (step.id === "root") return;
      if (seen.has(step.id)) step.id = newStepId();
      seen.add(step.id);
      const meta = types.get(step.type);
      if (!meta) errors.push(`tests[${i}] uses unknown action type "${step.type}"`);
      else for (const slot of Object.keys(step.slots ?? {})) if (!meta.slots?.includes(slot)) errors.push(`tests[${i}]: "${step.type}" has no slot "${slot}"`);
      if (step.type.includes("verify")) checks++;
    });
    const steps = workflow.root.slots?.body ?? [];
    if (!steps.length) errors.push(`tests[${i}] has no steps`);
    else if (!checks) errors.push(`tests[${i}] ("${name}") checks nothing: add a Verify step`);
    tests.push({ name, description: typeof t?.description === "string" ? t.description.slice(0, 1000) : "", page: typeof t?.page === "string" ? t.page : undefined, steps, variables: workflow.variables });
  });
  return { tests, errors };
}
