import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinHandlers, keepBrowsersOpen, takeLingeringBrowser } from "@zamtest/actions";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import { eventsToWorkflow, startRecording } from "../src/recorder.js";
import { PICK_SCRIPT, pickWebElement } from "../src/picker.js";

const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));
const page = `file://${fileURLToPath(new URL("../../../examples/site/login.html", import.meta.url))}`;

describe("the picker's page script", () => {
  it("is valid JavaScript (an error there would silently stop Indicate on every page)", () => {
    expect(() => new Function(PICK_SCRIPT({ pick: "a", paused: "b", pause: "c", resume: "d", cancel: "e" }))).not.toThrow();
  });
});

describe("eventsToWorkflow", () => {
  it("merges repeated typing, keeps Enter and never stores passwords", () => {
    const wf = eventsToWorkflow("https://example.com", [
      { kind: "type", selector: "css=#user", description: "The Username field", value: "ada" },
      { kind: "type", selector: "css=#pass", description: "The Password field", value: "hunter2hunter2", secret: true },
      { kind: "type", selector: "css=#pass", description: "The Password field", value: "hunter2hunter2", secret: true },
      { kind: "enter", selector: "css=#pass", description: "The Password field" },
    ]);
    const body = wf.root.slots!.body!;
    expect(body.map((s) => s.type)).toEqual(["browser.open", "browser.type", "browser.type", "browser.close"]);
    expect(body[2]!.props).toMatchObject({ text: "{{ password }}", pressEnter: true });
    expect(wf.variables).toEqual([expect.objectContaining({ name: "password", direction: "in" })]);
    expect(JSON.stringify(wf)).not.toContain("hunter2");
  });
});

describe.skipIf(!canRun)("recorder in a real browser", () => {
  it("records a login and the recording replays successfully", async () => {
    const rec = await startRecording(page, { headless: true });
    await rec.page.fill("#user", "grace");
    await rec.page.fill("#pass", "s3cret-password");
    await rec.page.selectOption("#company", "globex");
    await rec.page.getByRole("button", { name: "Sign in" }).click();
    const workflow = await rec.stop();

    const steps = workflow.root.slots!.body!;
    expect(steps.map((s) => s.type)).toEqual([
      "browser.open",
      "browser.type",
      "browser.type",
      "browser.select",
      "browser.click",
      "browser.close",
    ]);
    // Stable test ids win over everything else; labels come with descriptions for AI healing.
    expect(steps[1]!.props.selector).toBe('css=[data-testid="username"]');
    expect(steps[4]!.props.selector).toBe('css=[data-testid="sign-in"]');
    expect(steps[3]!.props).toMatchObject({ selector: "css=#company", value: "globex" });
    expect(steps[4]!.props.description).toMatch(/Sign in/);
    expect(JSON.stringify(workflow)).not.toContain("s3cret-password");

    // Replay: add a step that reads the result, then run it with the password as an input.
    steps.splice(steps.length - 1, 0, { id: "read", type: "browser.getText", props: { selector: "css=#welcome", output: "welcome" } });
    workflow.variables.push({ name: "welcome", type: "string", direction: "out" });
    (steps[0]!.props as Record<string, unknown>).headless = true;
    const result = await runWorkflow(workflow, { handlers: builtinHandlers, inputs: { password: "anything" } });
    expect(result.error).toBeUndefined();
    expect(result.outputs.welcome).toBe("Welcome, grace (globex)!");
  }, 60_000);
});

describe.skipIf(!canRun)("indicating an element on a web page", () => {
  it("picks the clicked element's selector without the page getting the click; Esc cancels", async () => {
    let navigated = false;
    const picked = await pickWebElement(page, "Click the element", () => false, {
      headless: true,
      timeoutMs: 20_000,
      onPage: (p) => {
        p.on("framenavigated", () => (navigated = true));
        void p.getByRole("button", { name: "Sign in" }).click();
      },
    });
    expect(picked).toEqual({ selector: 'css=[data-testid="sign-in"]', description: "The Sign in button" });
    expect(navigated).toBe(false);
    const cancelled = await pickWebElement(page, "x", () => false, { headless: true, timeoutMs: 20_000, onPage: (p) => void p.keyboard.press("Escape") });
    expect(cancelled).toBeNull();
  });
});

describe.skipIf(!canRun)("indicating after the steps before", () => {
  it("picks on the page the steps before left open (signed in)", async () => {
    process.env.ZAMTEST_RECORD_HEADLESS = "1";
    try {
      const before = parseWorkflow({
        id: "before",
        name: "before",
        variables: [],
        root: {
          id: "root",
          type: "core.sequence",
          props: {},
          slots: {
            body: [
              { id: "open", type: "browser.open", props: { url: page } },
              { id: "user", type: "browser.type", props: { selector: "css=#user", text: "ada", aiHeal: false } },
              { id: "go", type: "browser.click", props: { selector: 'css=[data-testid="sign-in"]', aiHeal: false } },
            ],
          },
        },
      });
      keepBrowsersOpen(true, true);
      const run = await runWorkflow(before, { handlers: builtinHandlers });
      expect(run.status, run.error).toBe("succeeded");
      const browser = takeLingeringBrowser();
      expect(browser).toBeDefined();
      let welcome = "";
      const picked = await pickWebElement("about:blank", undefined, () => false, {
        attachTo: browser,
        timeoutMs: 20_000,
        onPage: (p) => {
          void (async () => {
            welcome = await p.locator("#welcome").innerText();
            await p.locator("#welcome").click();
          })();
        },
      });
      expect(welcome).toContain("Welcome, ada");
      expect(picked).toMatchObject({ selector: "css=#welcome" });
    } finally {
      keepBrowsersOpen(false);
      delete process.env.ZAMTEST_RECORD_HEADLESS;
    }
  });
});

describe.skipIf(!canRun)("pausing to use the page before indicating", () => {
  it("lets the page get clicks while paused (to log in), then picks after Indicate", async () => {
    let welcome = "";
    const picked = await pickWebElement(page, undefined, () => false, {
      headless: true,
      timeoutMs: 20_000,
      onPage: (p) => {
        void (async () => {
          await p.getByRole("button", { name: /Pause/ }).click();
          await p.fill("#user", "ada");
          await p.getByRole("button", { name: "Sign in" }).click();
          welcome = await p.locator("#welcome").innerText();
          await p.getByRole("button", { name: /Indicate/ }).click();
          await p.locator("#welcome").click();
        })();
      },
    });
    expect(welcome).toContain("Welcome, ada");
    expect(picked).toMatchObject({ selector: "css=#welcome" });
  });
});

