/**
 * "Export as Playwright test": a workflow as a Playwright Test file (@playwright/test),
 * to run with `npx playwright test` in a team's own tools and CI. One way only: the
 * file cannot be brought back. Browser steps, checks and control flow are translated;
 * steps that only run on ZamTech AI bots (Excel, email, desktop apps, AI...) are kept
 * as TODO comments.
 */
import { BUILTIN_ACTIONS } from "./catalog.js";
import type { ActionMeta, Step, Workflow } from "./schema.js";

const TEMPLATE = /\{\{([\s\S]+?)\}\}/g;
const HAS_TEMPLATE = /\{\{[\s\S]+?\}\}/;
const WHOLE_TEMPLATE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface PlaywrightExport {
  /** The .spec.ts file. */
  code: string;
  /** A file name for it, e.g. "login-and-check.spec.ts". */
  fileName: string;
  /** Steps left as TODO comments. */
  unsupported: number;
}

/** A property value as a JavaScript expression: templates become `${...}`. */
function js(value: unknown): string {
  if (typeof value === "string") {
    const whole = WHOLE_TEMPLATE.exec(value);
    if (whole && !whole[1]!.includes("}}")) return whole[1]!.trim();
    if (!HAS_TEMPLATE.test(value)) return JSON.stringify(value);
    let out = "`";
    let last = 0;
    for (const m of value.matchAll(TEMPLATE)) {
      out += value.slice(last, m.index).replace(/[`\\]|\$\{/g, (c) => `\\${c}`);
      out += `\${${m[1]!.trim()}}`;
      last = m.index! + m[0].length;
    }
    return `${out + value.slice(last).replace(/[`\\]|\$\{/g, (c) => `\\${c}`)}\``;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** An expected text for Playwright: as it is, containing it, or a regular expression. */
function expected(value: unknown, match: unknown, forWholeText: boolean): string {
  const m = String(match ?? "contains");
  if (m === "regex") return `new RegExp(${js(value)})`;
  if (m === "equals" || !forWholeText) return js(value);
  // Titles and addresses: "contains" as a regular expression.
  return typeof value === "string" && !HAS_TEMPLATE.test(value) ? `/${escapeRegex(value)}/` : `new RegExp(escapeRegExp(${js(value)}))`;
}

export function workflowToPlaywright(workflow: Workflow, catalog: ActionMeta[] = BUILTIN_ACTIONS): PlaywrightExport {
  const metas = new Map(catalog.map((m) => [m.type, m]));
  const lines: string[] = [];
  let unsupported = 0;
  let needsEscape = false;
  let needsAsset = false;

  // Every variable a step writes is declared at the top.
  const declared = new Set(workflow.variables.map((v) => v.name));
  const written: string[] = [];
  const collect = (s: Step) => {
    const meta = metas.get(s.type);
    for (const p of meta?.props ?? []) {
      const v = s.props[p.name];
      if (p.output && typeof v === "string" && IDENTIFIER.test(v) && !declared.has(v)) {
        declared.add(v);
        written.push(v);
      }
    }
    for (const children of Object.values(s.slots ?? {})) children.forEach(collect);
  };
  collect(workflow.root);

  const loc = (props: Record<string, unknown>) => `page.locator(${js(props.selector)})`;
  const timeout = (props: Record<string, unknown>, fallback?: number) =>
    props.timeoutMs !== undefined ? `{ timeout: ${js(props.timeoutMs)} }` : fallback !== undefined ? `{ timeout: ${fallback} }` : "";
  const withTimeout = (props: Record<string, unknown>, fallback?: number) => {
    const t = timeout(props, fallback);
    return t ? `, ${t}` : "";
  };

  const emit = (steps: Step[] | undefined, indent: string) => {
    for (const step of steps ?? []) emitStep(step, indent);
  };

  const emitStep = (step: Step, indent: string) => {
    const p = step.props;
    const meta = metas.get(step.type);
    const name = step.label || meta?.displayName || step.type;
    const out = (line: string) => lines.push(`${indent}${line}`);
    const output = (value: string) => {
      const v = p.output;
      out(typeof v === "string" && IDENTIFIER.test(v) ? `${v} = ${value};` : `${value.startsWith("await ") ? "" : "void "}${value};`);
    };
    if (step.disabled) {
      out(`// (turned off) ${name}`);
      return;
    }
    if (step.label && !["core.comment"].includes(step.type)) out(`// ${step.label.replace(/\s*\n\s*/g, " ")}`);
    if (p.list) out("// ZamTech AI chose this element from a list at run time; this uses the one that was indicated.");
    const inner = step.continueOnError ? `${indent}  ` : indent;
    if (step.continueOnError) out("try {");
    const line = (text: string) => lines.push(`${inner}${text}`);
    const sub = (steps: Step[] | undefined) => emit(steps, `${inner}  `);

    switch (step.type) {
      case "core.sequence":
        line("{");
        sub(step.slots?.body);
        line("}");
        break;
      case "core.if":
        line(`if (${p.condition || "false"}) {`);
        sub(step.slots?.then);
        if (step.slots?.else?.length) {
          line("} else {");
          sub(step.slots.else);
        }
        line("}");
        break;
      case "core.forEach": {
        const item = typeof p.itemVariable === "string" && p.itemVariable ? p.itemVariable : "item";
        line(p.indexVariable ? `for (const [${p.indexVariable}, ${item}] of (${p.items}).entries()) {` : `for (const ${item} of ${p.items}) {`);
        sub(step.slots?.body);
        line("}");
        break;
      }
      case "core.while":
        line(`while (${p.condition || "false"}) {`);
        sub(step.slots?.body);
        line("}");
        break;
      case "core.tryCatch":
        line("try {");
        sub(step.slots?.try);
        line(`} catch (${typeof p.errorVariable === "string" && p.errorVariable ? p.errorVariable : "error"}) {`);
        sub(step.slots?.catch);
        if (step.slots?.finally?.length) {
          line("} finally {");
          sub(step.slots.finally);
        }
        line("}");
        break;
      case "core.break":
        line("break;");
        break;
      case "core.throw":
        line(`throw new Error(${js(p.message)});`);
        break;
      case "core.log": {
        const level = String(p.level ?? "info");
        line(`console.${level === "error" ? "error" : level === "warn" ? "warn" : "log"}(${js(p.message)});`);
        break;
      }
      case "core.assign":
        line(`${p.variable} = ${p.value};`);
        break;
      case "core.delay":
        line(`await page.waitForTimeout(${js(p.ms ?? 1000)});`);
        break;
      case "core.comment":
        for (const text of String(p.text ?? "").split("\n")) line(`//${text ? ` ${text}` : ""}`);
        break;
      case "core.getAsset": {
        const env = String(p.name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
        needsAsset = true;
        lines.push(`${inner}// The asset "${p.name}" comes from the environment variable ${env} (a credential as JSON: {"username": "...", "password": "..."}).`);
        output(`asset(${JSON.stringify(env)})`);
        break;
      }
      case "verify.condition":
        line(`expect(${p.condition || "false"}, ${js(p.message ?? `Expected ${p.condition}`)}).toBeTruthy();`);
        break;
      case "browser.open":
        if (p.browser && p.browser !== "chromium") line(`// ZamTech AI used ${p.browser}: run with --browser=${p.browser === "webkit" ? "webkit" : "firefox"}.`);
        line(`await page.goto(${js(p.url)});`);
        break;
      case "browser.navigate":
        line(`await page.goto(${js(p.url)});`);
        break;
      case "browser.click":
        line(`await ${loc(p)}.click(${timeout(p)});`);
        break;
      case "browser.type":
        line(p.clear === false ? `await ${loc(p)}.pressSequentially(${js(p.text)}${withTimeout(p)});` : `await ${loc(p)}.fill(${js(p.text)}${withTimeout(p)});`);
        if (p.pressEnter) line(`await ${loc(p)}.press("Enter");`);
        break;
      case "browser.select":
        line(`await ${loc(p)}.selectOption(${js(p.value)}${withTimeout(p)});`);
        break;
      case "browser.getText":
        output(`(await ${loc(p)}.innerText(${timeout(p)})).trim()`);
        break;
      case "browser.waitFor":
        line(`await ${loc(p)}.waitFor({ state: "visible", timeout: ${js(p.timeoutMs ?? 30000)} });`);
        break;
      case "browser.screenshot":
        line(`await page.screenshot({ path: ${js(p.path || "screenshot.png")}, fullPage: true });`);
        break;
      case "browser.close":
        line("// Close Browser: Playwright closes the page when the test ends.");
        break;
      case "browser.verifyText": {
        const match = String(p.match ?? "contains");
        const assertion = match === "contains" ? "toContainText" : "toHaveText";
        line(`await expect(${loc(p)}.first()).${assertion}(${expected(p.text, match, false)}${withTimeout(p, 5000)});`);
        break;
      }
      case "browser.verifyVisible":
        line(`await expect(${loc(p)}.first()).${p.visible === false ? "toBeHidden" : "toBeVisible"}(${timeout(p, 5000)});`);
        break;
      case "browser.verifyTitle":
      case "browser.verifyUrl": {
        if (String(p.match ?? "contains") === "contains" && typeof p.text === "string" && /\{\{/.test(p.text)) needsEscape = true;
        const assertion = step.type === "browser.verifyTitle" ? "toHaveTitle" : "toHaveURL";
        line(`await expect(page).${assertion}(${expected(p.text, p.match, true)}${withTimeout(p, 5000)});`);
        break;
      }
      default: {
        unsupported++;
        const settings = JSON.stringify(p);
        const what = step.label ? `${meta?.displayName ?? step.type} (${step.type})` : `"${name}" (${step.type})`;
        line(`// TODO: ${what} runs only on ZamTech AI bots. Its settings: ${settings.length > 300 ? `${settings.slice(0, 300)}...` : settings}`);
      }
    }
    if (step.continueOnError) {
      out("} catch (error) {");
      out(`  console.warn(${JSON.stringify(`"${name}" failed; going on:`)}, error);`);
      out("}");
    }
  };

  const body = workflow.root.type === "core.sequence" ? workflow.root.slots?.body : [workflow.root];
  emit(body, "  ");

  const head: string[] = [
    'import { test, expect } from "@playwright/test";',
    "",
    `// Exported from ZamTech AI: "${workflow.name.replace(/\n/g, " ")}". Run it with: npx playwright test`,
    ...(unsupported ? [`// ${unsupported} step${unsupported === 1 ? "" : "s"} only run${unsupported === 1 ? "s" : ""} on ZamTech AI bots: see the TODO comments.`] : []),
    ...(needsAsset
      ? [
          "",
          "/** An asset, from an environment variable: text, or JSON (a credential). */",
          "const asset = (name: string): any => {",
          "  const value = process.env[name];",
          "  try {",
          '    return JSON.parse(value ?? "null");',
          "  } catch {",
          "    return value;",
          "  }",
          "};",
        ]
      : []),
    ...(needsEscape ? ["", 'const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\\]\\\\/]/g, "\\\\$&");'] : []),
    "",
    `test(${JSON.stringify(workflow.name)}, async ({ page }) => {`,
  ];
  const vars: string[] = [];
  for (const v of workflow.variables) {
    const note = v.direction === "in" || v.direction === "inout" ? " // in-argument: its default" : "";
    vars.push(`  let ${v.name}${v.type !== "any" ? `: ${tsType(v.type)}` : ""} = ${v.default === undefined ? "undefined" : JSON.stringify(v.default)};${note}`);
  }
  for (const name of written) vars.push(`  let ${name}: any;`);
  if (vars.length) vars.push("");
  const code = [...head, ...vars, ...lines, "});", ""].join("\n");
  const slug = workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow";
  return { code, fileName: `${slug}.spec.ts`, unsupported };
}

function tsType(type: string): string {
  switch (type) {
    case "string":
    case "number":
    case "boolean":
      return `${type} | undefined`;
    case "array":
      return "any[] | undefined";
    default:
      return "any";
  }
}
