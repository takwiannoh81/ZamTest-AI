import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import type { EngineEvent } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";

// Needs a Chromium binary: set ZAMTEST_BROWSER_EXECUTABLE to run this suite.
const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));

// A login form that clears the user name once, just after it is typed (as pages do that draw
// their form again while the app finishes loading); the button shows what the fields hold.
const page = `data:text/html,${encodeURIComponent(`<input id="user"><input id="pass" type="password"><button id="go">Log in</button>
<script>
  let wiped = false;
  user.addEventListener("input", () => { if (!wiped) { wiped = true; setTimeout(() => (user.value = ""), 100); } });
  go.addEventListener("click", () => (document.title = user.value + "|" + pass.value));
</script>`)}`;

describe.skipIf(!canRun)("typing into pages that clear fields", () => {
  it("types again when the page wiped the text, and never logs what was typed", async () => {
    const events: EngineEvent[] = [];
    const workflow = parseWorkflow({
      id: "type",
      name: "type",
      variables: [],
      root: {
        id: "root",
        type: "core.sequence",
        props: {},
        slots: {
          body: [
            { id: "open", type: "browser.open", props: { url: page, headless: true } },
            { id: "u", type: "browser.type", props: { selector: "css=#user", text: "ada", aiHeal: false } },
            { id: "p", type: "browser.type", props: { selector: "css=#pass", text: "s3cret-pw", aiHeal: false } },
            { id: "go", type: "browser.click", props: { selector: "css=#go", aiHeal: false } },
            { id: "check", type: "browser.verifyTitle", props: { text: "ada|s3cret-pw" } },
          ],
        },
      },
    });
    const result = await runWorkflow(workflow, { handlers: builtinHandlers, onEvent: (e) => events.push(e) });
    expect(result.status, result.error).toBe("succeeded");
    const logs = events.filter((e): e is Extract<EngineEvent, { type: "log" }> => e.type === "log");
    expect(logs.some((l) => l.message.includes("cleared the field right after typing (css=#user)"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("s3cret-pw");
  });
});
