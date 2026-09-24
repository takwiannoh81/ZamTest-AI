import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";

/** A page that shows "Welcome, Ivo" after a short moment, like a real one loading. */
function fakePage() {
  const loadedAt = Date.now() + 150;
  const text = () => (Date.now() >= loadedAt ? "Welcome, Ivo" : "Loading...");
  return {
    locator: (selector: string) => ({
      first: () => ({
        innerText: async () => {
          if (selector === "#missing") throw new Error("not found");
          return text();
        },
        isVisible: async () => selector !== "#missing",
      }),
    }),
    title: async () => "Dashboard - ZamTech AI",
    url: () => "https://portal.example/#/dashboard",
    isClosed: () => false,
  };
}

const test = (steps: Array<{ type: string; props: Record<string, unknown> }>) =>
  parseWorkflow({
    id: "t",
    name: "t",
    variables: [{ name: "total", type: "number", direction: "in" }],
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: steps.map((s, i) => ({ id: `s${i}`, ...s })) } },
  });

async function run(steps: Array<{ type: string; props: Record<string, unknown> }>, inputs: Record<string, unknown> = {}) {
  const page = fakePage();
  // The page as "Open Browser" leaves it for the other browser steps.
  const open = { type: "test.usePage", props: {} };
  return runWorkflow(test([open, ...steps]), {
    handlers: { ...builtinHandlers, "test.usePage": (_p, ctx) => void ctx.resources.set("browser.session", { page, browser: {} }) },
    inputs,
  });
}

describe("Verify actions", () => {
  it("pass when the page matches, waiting for it to load", async () => {
    const result = await run([
      { type: "browser.verifyText", props: { selector: "#greeting", text: "welcome, ivo" } },
      { type: "browser.verifyText", props: { selector: "#greeting", text: "Welcome, Ivo", match: "equals" } },
      { type: "browser.verifyText", props: { selector: "#greeting", text: "^Welcome, \\w+$", match: "regex" } },
      { type: "browser.verifyVisible", props: { selector: "#logout" } },
      { type: "browser.verifyVisible", props: { selector: "#missing", visible: false } },
      { type: "browser.verifyTitle", props: { text: "Dashboard" } },
      { type: "browser.verifyUrl", props: { text: "/#/dashboard" } },
      { type: "verify.condition", props: { condition: "total > 0" } },
    ], { total: 3 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
  });

  it("fail with what was expected and what was found", async () => {
    const fail = async (step: { type: string; props: Record<string, unknown> }, inputs = {}) => (await run([step], inputs)).error;
    expect(await fail({ type: "browser.verifyText", props: { selector: "#greeting", text: "Goodbye", timeoutMs: 300 } })).toBe(
      'Expected the text of #greeting to contain "Goodbye", but found "Welcome, Ivo"',
    );
    expect(await fail({ type: "browser.verifyText", props: { selector: "#missing", text: "x", timeoutMs: 100 } })).toMatch(/but found nothing \(element not found\)/);
    expect(await fail({ type: "browser.verifyVisible", props: { selector: "#missing", timeoutMs: 100 } })).toBe("Expected #missing to be visible, but it is not on the page");
    expect(await fail({ type: "browser.verifyTitle", props: { text: "Invoices", match: "equals", timeoutMs: 100 } })).toBe(
      'Expected the page title to equal "Invoices", but it is "Dashboard - ZamTech AI"',
    );
    expect(await fail({ type: "verify.condition", props: { condition: "total > 0" } }, { total: 0 })).toBe("Expected total > 0 to be true, but it was not");
    expect(await fail({ type: "verify.condition", props: { condition: "total > 0", message: "The invoice total is empty" } }, { total: 0 })).toBe("The invoice total is empty");
  });
});
