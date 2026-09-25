import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import type { EngineEvent, Step, TargetList } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";

// Needs a Chromium binary: set ZAMTEST_BROWSER_EXECUTABLE to run this suite.
const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));

// A camera list: two offline, two online (the third has no name part); a click shows which camera was clicked.
export const CAMERAS = `data:text/html,${encodeURIComponent(`<div id="cams">
  <div class="cam"><span class="icon offline">x</span><span class="name">Cam 1</span></div>
  <div class="cam"><span class="icon offline">x</span><span class="name">Cam 2</span></div>
  <div class="cam"><span class="icon online">o</span><span class="label">Cam 3</span></div>
  <div class="cam"><span class="icon online">o</span><span class="name">Cam 4 (lobby)</span></div>
</div>
<p id="out"></p>
<script>
  document.querySelectorAll(".cam").forEach((c) => c.addEventListener("click", () => (out.textContent = c.innerText.replace(/[xo]/, "").trim())));
</script>`)}`;

const run = async (list: TargetList, extra: Partial<Step["props"]> = {}) => {
  const events: EngineEvent[] = [];
  const body: Step[] = [
    { id: "open", type: "browser.open", props: { url: CAMERAS, headless: true } },
    { id: "click", type: "browser.click", props: { selector: 'text="Cam 1"', list, aiHeal: false, ...extra } },
    { id: "read", type: "browser.getText", props: { selector: "css=#out", output: "clicked", aiHeal: false } },
  ];
  const workflow = parseWorkflow({ id: "w", name: "w", variables: [{ name: "clicked", direction: "out" }], root: { id: "root", type: "core.sequence", props: {}, slots: { body } } });
  const result = await runWorkflow(workflow, { handlers: builtinHandlers, onEvent: (e) => events.push(e) });
  const logs = events.flatMap((e) => (e.type === "log" ? [e.message] : []));
  return { result, clicked: result.outputs?.clicked, logs };
};

const items = "css=#cams > div.cam";

describe.skipIf(!canRun)("steps on an item of a list", () => {
  it("picks the first item that the rules keep (not offline)", async () => {
    const { clicked, logs } = await run({ items, skipIfHas: "css=span.icon.offline", which: "first" });
    expect(clicked).toBe("Cam 3");
    expect(logs).toContain("Used item 3 of 4");
  });

  it("the last one, or by its text", async () => {
    expect((await run({ items, which: "last" })).clicked).toBe("Cam 4 (lobby)");
    expect((await run({ items, onlyText: "LOBBY", which: "first" })).clicked).toBe("Cam 4 (lobby)");
    expect((await run({ items, skipText: "cam 1", which: "first" })).clicked).toBe("Cam 2");
  });

  it("tries the next item when the step does not work on one", async () => {
    // Cam 3 has no name part: clicking its name fails, so the step moves on to Cam 4.
    const { clicked, logs } = await run({ items, inner: "css=span.name", skipIfHas: "css=span.offline", which: "next" }, { timeoutMs: 800 });
    expect(clicked).toBe("Cam 4 (lobby)");
    expect(logs.some((l) => l.startsWith("Item 3 of 4 did not work"))).toBe(true);
  });

  it("says so when the rules leave no item", async () => {
    const { result } = await run({ items, onlyText: "parking", which: "first" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("All 4 items of the list were skipped");
  });
});
