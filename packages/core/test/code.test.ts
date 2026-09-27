import { describe, expect, it } from "vitest";
import { codeToWorkflow, parseWorkflow, TEMPLATES, workflowFromTemplate, workflowToCode, workflowToPlaywright } from "../src/index.js";
import type { Step, Workflow } from "../src/index.js";

const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
/** Steps without ids, props in one order. */
const shape = (s: Step): unknown => ({
  ...s,
  id: undefined,
  props: sorted(s.props),
  slots: s.slots && Object.fromEntries(Object.entries(s.slots).map(([k, v]) => [k, v.map(shape)])),
});
const ids = (s: Step): string[] => [s.id, ...Object.values(s.slots ?? {}).flat().flatMap(ids)];

const wf = (body: Step[], variables: Workflow["variables"] = []): Workflow =>
  parseWorkflow({ id: "wf", name: "Test", variables, root: { id: "root", type: "core.sequence", props: {}, slots: { body } } });
let n = 0;
const st = (type: string, props: Record<string, unknown> = {}, extra: Partial<Step> = {}): Step => ({ id: `s${++n}`, type, props, ...extra });

function roundTrip(workflow: Workflow) {
  const code = workflowToCode(workflow);
  const back = codeToWorkflow(code, workflow);
  expect(back.diagnostics.filter((d) => d.severity === "error"), code).toEqual([]);
  expect(shape(back.workflow!.root), code).toEqual(shape(workflow.root));
  expect(back.workflow!.variables).toEqual(workflow.variables);
  expect(ids(back.workflow!.root)).toEqual(ids(workflow.root));
  return code;
}

describe("the code view", () => {
  it("turns every template into code and back without changing a step", () => {
    for (const t of TEMPLATES) roundTrip(parseWorkflow(workflowFromTemplate(t, t.id)));
  });

  it("writes readable code: arguments, results, labels, settings and comments", () => {
    const workflow = wf(
      [
        st("core.comment", { text: "Sign in first\nwith the test user" }),
        st("browser.open", { url: "https://shop.example.com/login" }, { label: "Open the login page" }),
        st("browser.type", { selector: "#email", text: "{{ user }}", pressEnter: true }),
        st("browser.getText", { selector: "h1", output: "title" }),
        st("browser.click", { selector: "button[type=submit]" }, { continueOnError: true, retry: { count: 2, delayMs: 500 } }),
        st("core.log", { message: "off" }, { disabled: true }),
      ],
      [{ name: "user", type: "string", direction: "in", default: "anna@example.com", description: "Who signs in" }],
    );
    const code = roundTrip(workflow);
    expect(code).toBe(
      [
        'input("user", "string", "anna@example.com") // Who signs in',
        "",
        "// Sign in first",
        "// with the test user",
        'browser.open("https://shop.example.com/login") // Open the login page',
        'browser.type("#email", user, { pressEnter: true })',
        'title = browser.getText("h1")',
        "// @step { continueOnError: true, retry: { count: 2, delayMs: 500 } }",
        'browser.click("button[type=submit]")',
        "// @step { disabled: true }",
        'log("off")',
        "",
      ].join("\n"),
    );
  });

  it("keeps control flow, and what the code cannot show directly", () => {
    roundTrip(
      wf([
        st("core.sequence", {}, { label: "Group", slots: { body: [st("core.log", { message: "in a group" })] } }),
        st("core.if", { condition: "a > 1" }, {
          label: "Big?",
          slots: {
            then: [st("core.log", { message: "big" })],
            else: [st("core.if", { condition: "a > 0" }, { slots: { then: [st("core.log", { message: "small" })], else: [st("core.log", { message: "none" })] } })],
          },
        }),
        st("core.forEach", { items: "rows", itemVariable: "row", indexVariable: "i" }, { slots: { body: [st("core.break")] } }),
        st("core.while", { condition: "count < 3", maxIterations: 5 }, { slots: { body: [st("core.assign", { variable: "count", value: "count + 1" })] } }),
        st("core.tryCatch", { errorVariable: "err" }, {
          slots: { try: [st("core.throw", { message: "Failed: {{ reason }}" })], catch: [st("core.log", { message: "{{ err.message }}" })], finally: [st("core.delay", { ms: 100 })] },
        }),
        st("core.break"),
        st("core.assign", { variable: "x", value: 'log("looks like an action")' }),
        st("core.if", { condition: "" }, { slots: { then: [], else: [] } }),
        st("core.runScript", { code: "const a = 1;\nreturn a + 1;", output: "two" }),
        st("browser.click", { selector: "#a", list: { items: "li", which: "next" } }),
        st("core.comment", { text: "one" }),
        st("core.comment", { text: "two" }),
        st("browser.type", { text: "only the text", clear: false }),
        st("core.log", { message: "{{ file }} was rejected: {{ reason }}" }),
      ]),
    );
  });

  it("reads hand-written code: templates from expressions, shortcuts and new steps", () => {
    const base = wf([], []);
    const lines = [
      'variable("count", "number", 0)',
      "browser.type(\"#name\", `Hi ${who}!`)",
      "count += 2",
      "count++",
      "for (const row of rows) log(row.name)",
      'browser.click({ selector: "#go", aiHeal: false })',
    ];
    const bad = codeToWorkflow([...lines, "let x = 1"].join("\n"), base);
    expect(bad.diagnostics).toMatchObject([{ line: 7, severity: "error", message: expect.stringContaining("Declare variables at the top") }]);
    expect(bad.workflow).toBeUndefined();

    const ok = codeToWorkflow(lines.join("\n"), base);
    const body = ok.workflow!.root.slots!.body!;
    expect(ok.workflow!.variables).toEqual([{ name: "count", type: "number", direction: "local", default: 0 }]);
    expect(body.map((s) => [s.type, s.props])).toEqual([
      ["browser.type", { selector: "#name", text: "Hi {{ who }}!" }],
      ["core.assign", { variable: "count", value: "count + (2)" }],
      ["core.assign", { variable: "count", value: "count + 1" }],
      ["core.forEach", { items: "rows", itemVariable: "row" }],
      ["browser.click", { selector: "#go", aiHeal: false }],
    ]);
    expect(body[3]!.slots!.body![0]!.props).toEqual({ message: "{{ row.name }}" });
    expect(new Set(ids(ok.workflow!.root)).size).toBe(ids(ok.workflow!.root).length);
  });

  it("keeps the ids of steps that are still there when lines are added", () => {
    const workflow = wf([st("browser.open", { url: "https://a.example" }), st("browser.click", { selector: "#b" })]);
    const [open, click] = workflow.root.slots!.body!;
    const code = `log("new first step")\n${workflowToCode(workflow)}browser.click("#b", { aiHeal: false })\n`;
    const body = codeToWorkflow(code, workflow).workflow!.root.slots!.body!;
    expect(body.map((s) => s.type)).toEqual(["core.log", "browser.open", "browser.click", "browser.click"]);
    expect([body[1]!.id, body[2]!.id]).toEqual([open!.id, click!.id]);
    expect(new Set(body.map((s) => s.id)).size).toBe(4);
  });

  it("points at mistakes with their line", () => {
    const base = wf([]);
    const check = (code: string) => codeToWorkflow(code, base).diagnostics[0];
    expect(check('log("a")\nbrowser.clik("#x")')).toMatchObject({ line: 2, message: "Unknown action browser.clik (did you mean browser.click?)" });
    expect(check('log("a"\n')).toMatchObject({ line: 2, severity: "error" });
    expect(check("function f() {}")).toMatchObject({ message: expect.stringContaining("not supported in the code view") });
    expect(check("break")).toMatchObject({ message: "break only works inside a loop (for or while)" });
    expect(check('browser.click("#x", { colour: "red" })')).toMatchObject({ severity: "warning", message: expect.stringContaining('no setting "colour"') });
    expect(check('x = browser.click("#x")')).toMatchObject({ message: "browser.click gives no result to put in x" });
    expect(check("a + 1")).toMatchObject({ message: expect.stringContaining("does nothing") });
    expect(check('// @step { retry: count }\nlog("a")')).toMatchObject({ message: expect.stringContaining("plain value") });
  });
});

describe("Playwright export", () => {
  it("translates browser steps and checks, and leaves the rest as TODO comments", () => {
    const workflow = wf(
      [
        st("browser.open", { url: "https://shop.example.com/login", browser: "firefox" }),
        st("browser.type", { selector: "#email", text: "{{ user }}" }, { label: "Email" }),
        st("browser.type", { selector: "#q", text: "Hi {{ user }}", clear: false, pressEnter: true }),
        st("browser.click", { selector: "button[type=submit]" }),
        st("browser.getText", { selector: "h1", output: "title" }),
        st("browser.verifyText", { selector: "h1", text: "Welcome", match: "contains" }),
        st("browser.verifyVisible", { selector: ".error", visible: false }),
        st("browser.verifyTitle", { text: "Shop (home)", match: "contains" }),
        st("browser.verifyUrl", { text: "/dashboard", match: "equals", timeoutMs: 8000 }),
        st("core.if", { condition: "title.length > 0" }, { slots: { then: [st("core.log", { message: "{{ title }}" })], else: [] } }),
        st("excel.write", { path: "out.xlsx", rows: "[]" }, { continueOnError: true }),
        st("core.log", { message: "{{ file }} was rejected: {{ reason }}", level: "warn" }),
        st("core.getAsset", { name: "Login/example.com", output: "signIn" }),
      ],
      [{ name: "user", type: "string", direction: "in", default: "anna@example.com" }],
    );
    const { code, fileName, unsupported } = workflowToPlaywright(workflow);
    expect(fileName).toBe("test.spec.ts");
    expect(unsupported).toBe(1);
    for (const line of [
      'import { test, expect } from "@playwright/test";',
      'test("Test", async ({ page }) => {',
      '  let user: string | undefined = "anna@example.com"; // in-argument: its default',
      "  let title: any;",
      "  // ZamTech AI used firefox: run with --browser=firefox.",
      '  await page.goto("https://shop.example.com/login");',
      "  // Email",
      '  await page.locator("#email").fill(user);',
      '  await page.locator("#q").pressSequentially(`Hi ${user}`);',
      '  await page.locator("#q").press("Enter");',
      '  await page.locator("button[type=submit]").click();',
      '  title = (await page.locator("h1").innerText()).trim();',
      '  await expect(page.locator("h1").first()).toContainText("Welcome", { timeout: 5000 });',
      '  await expect(page.locator(".error").first()).toBeHidden({ timeout: 5000 });',
      "  await expect(page).toHaveTitle(/Shop \\(home\\)/, { timeout: 5000 });",
      '  await expect(page).toHaveURL("/dashboard", { timeout: 8000 });',
      "  if (title.length > 0) {",
      "    console.log(title);",
      "  try {",
      '    // TODO: "Write Excel" (excel.write) runs only on ZamTech AI bots.',
      "  console.warn(`${file} was rejected: ${reason}`);",
      '  signIn = asset("LOGIN_EXAMPLE_COM");',
      "const asset = (name: string): any => {",
    ]) {
      expect(code).toContain(line);
    }
  });
});
