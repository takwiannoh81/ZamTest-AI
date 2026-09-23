import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import type { EngineEvent } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";

// Needs a Chromium binary: set ZAMTEST_BROWSER_EXECUTABLE to run this suite.
const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));
const page = fileURLToPath(new URL("../../../examples/site/login.html", import.meta.url));

describe.skipIf(!canRun)("browser activities", () => {
  it("self-heals a broken selector using the AI service", async () => {
    const healRequests: Array<{ failedSelector: string; description?: string; html: string }> = [];
    const fakeAi = {
      healSelector: async (input: { failedSelector: string; description?: string; html: string }) => {
        healRequests.push(input);
        return {
          candidates: [
            { selector: "css=#does-not-exist", strategy: "css", confidence: 0.9, reason: "wrong" },
            { selector: 'css=[data-testid="sign-in"]', strategy: "testid", confidence: 0.8, reason: "stable test id" },
          ],
        };
      },
    };
    const workflow = parseWorkflow({
      id: "heal",
      name: "heal",
      variables: [{ name: "welcome", direction: "out" }],
      root: {
        id: "root",
        type: "core.sequence",
        props: {},
        slots: {
          body: [
            { id: "open", type: "browser.open", props: { url: `file://${page}`, headless: true } },
            { id: "user", type: "browser.type", props: { selector: "css=#user", text: "grace" } },
            {
              id: "click",
              type: "browser.click",
              props: { selector: "css=#old-login-button", description: "The Sign in button", timeoutMs: 1000 },
            },
            { id: "read", type: "browser.getText", props: { selector: "css=#welcome", output: "welcome" } },
          ],
        },
      },
    });
    const events: EngineEvent[] = [];
    const result = await runWorkflow(workflow, {
      handlers: builtinHandlers,
      services: { ai: fakeAi },
      onEvent: (e) => events.push(e),
    });
    expect(result.error).toBeUndefined();
    expect(result.outputs.welcome).toBe("Welcome, grace!");
    expect(healRequests[0]?.failedSelector).toBe("css=#old-login-button");
    expect(healRequests[0]?.html).toContain('data-testid="sign-in"');
    expect(healRequests[0]?.html).not.toContain("<script");
    const healed = events.find((e) => e.type === "custom" && e.name === "selectorHealed");
    expect(healed).toMatchObject({ stepId: "click", data: { newSelector: 'css=[data-testid="sign-in"]' } });
  }, 30_000);
});
