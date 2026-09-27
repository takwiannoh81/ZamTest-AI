import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import type { EngineEvent, Step } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";
import type { VisionService } from "../src/index.js";

// Needs a Chromium binary: set ZAMTEST_BROWSER_EXECUTABLE to run this suite.
const executable = process.env.ZAMTEST_BROWSER_EXECUTABLE;
const canRun = Boolean(executable && existsSync(executable));

// Things at known places (the page is 1280 x 720, so the screenshot is too).
const page = `data:text/html,${encodeURIComponent(`<body style="margin:0">
<input id="amount" style="position:absolute;left:100px;top:100px;width:200px;height:30px">
<button id="go" style="position:absolute;left:600px;top:400px;width:120px;height:40px">Submit</button>
<div style="position:absolute;left:900px;top:600px">Total 1,180.00</div>
<script>go.addEventListener("click", () => (document.title = "sent " + amount.value));</script></body>`)}`;

/** Sees like AI would: where things are on the test page. */
function fakeVision(seen: Array<{ task: string; target: string; width: number; height: number; jpeg: boolean }>): VisionService {
  const places: Record<string, { x: number; y: number }> = { "the Amount field": { x: 200, y: 115 }, "the Submit button": { x: 660, y: 420 } };
  return {
    look: async ({ task, target, image, width, height }) => {
      const bytes = Buffer.from(image, "base64");
      seen.push({ task, target, width, height, jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 });
      if (task === "read") return target === "the total" ? { found: true, value: "1,180.00", confidence: 0.97, reason: "At the bottom right" } : { found: false, confidence: 0.9, reason: "Not there" };
      if (task === "check") return { found: target.includes("Submit"), confidence: 0.9, reason: target.includes("Submit") ? "A Submit button is shown" : "No confirmation is shown" };
      const place = places[target];
      return place ? { found: true, ...place, confidence: 0.95, reason: `Found ${target}` } : { found: false, confidence: 0.9, reason: `No ${target} on the screen` };
    },
  };
}

const run = async (body: Step[], vision: VisionService) => {
  const events: EngineEvent[] = [];
  const workflow = parseWorkflow({
    id: "vision",
    name: "vision",
    variables: [{ name: "total", type: "string" }],
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "open", type: "browser.open", props: { url: page, headless: true } }, ...body] } },
  });
  const result = await runWorkflow(workflow, { handlers: builtinHandlers, services: { vision }, onEvent: (e) => events.push(e) });
  const logs = events.filter((e): e is Extract<EngineEvent, { type: "log" }> => e.type === "log").map((e) => e.message);
  return { result, logs };
};

describe.skipIf(!canRun)("AI Vision on web pages", () => {
  process.env.ZAMTEST_BROWSER_EXECUTABLE = executable;

  it("types, clicks, reads and checks by what is on the page", async () => {
    const seen: Parameters<typeof fakeVision>[0] = [];
    const { result, logs } = await run(
      [
        { id: "t", type: "vision.type", props: { target: "the Amount field", text: "42" } },
        { id: "c", type: "vision.click", props: { target: "the Submit button" } },
        { id: "v", type: "browser.verifyTitle", props: { text: "sent 42", match: "equals" } },
        { id: "r", type: "vision.read", props: { target: "the total", output: "total" } },
        { id: "k", type: "vision.verify", props: { expectation: "a Submit button" } },
      ],
      fakeVision(seen),
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(seen[0]).toEqual({ task: "locate", target: "the Amount field", width: 1280, height: 720, jpeg: true });
    expect(logs.some((l) => l.startsWith('AI Vision clicked "the Submit button" at (660, 420)'))).toBe(true);
    expect(logs).toContain('AI Vision read "the total": "1,180.00" (97% sure)');
  }, 60_000);

  it("fails a check with what AI saw, and says what it could not find", async () => {
    const seen: Parameters<typeof fakeVision>[0] = [];
    const check = await run([{ id: "k", type: "vision.verify", props: { expectation: "an order confirmation", timeoutMs: 0 } }], fakeVision(seen));
    expect(check.result).toMatchObject({ status: "failed", error: expect.stringContaining('Expected the page to show "an order confirmation", but it does not: No confirmation is shown') });
    const click = await run([{ id: "c", type: "vision.click", props: { target: "the Cancel link" } }], fakeVision(seen));
    expect(click.result.error).toContain('AI Vision did not find "the Cancel link" on the page: No the Cancel link on the screen');
  }, 60_000);

  it("clicks with AI Vision when a step's selector does not work", async () => {
    const seen: Parameters<typeof fakeVision>[0] = [];
    const { result, logs } = await run(
      [
        { id: "t", type: "browser.type", props: { selector: "#amount", text: "7" } },
        { id: "c", type: "browser.click", props: { selector: "#gone", description: "the Submit button", timeoutMs: 500 } },
        { id: "v", type: "browser.verifyTitle", props: { text: "sent 7", match: "equals" } },
        // Off with AI self-healing.
        { id: "off", type: "browser.click", props: { selector: "#gone", description: "the Submit button", timeoutMs: 300, aiHeal: false } },
      ],
      fakeVision(seen),
    );
    expect(logs.some((l) => l.startsWith("The selector did not work") && l.endsWith('AI Vision looks for "the Submit button" on the page'))).toBe(true);
    expect(logs).toContain("AI Vision did the step. Update its selector (Indicate) so the next run does not need AI Vision.");
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain("AI Vision");
    expect(seen.filter((s) => s.task === "locate")).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!canRun)("AI Vision screenshots of large pages", () => {
  it("shrinks the screenshot to what AI sees as it is, and clicks at the right place of the page", async () => {
    const { chromium } = await import("playwright");
    const { pageShot } = await import("../src/vision.js");
    const browser = await chromium.launch({ executablePath: executable, headless: true });
    try {
      const p = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      await p.setContent(`<body style="margin:0;height:3000px"><button id="b" style="position:absolute;left:1500px;top:1700px;width:100px;height:40px">Here</button>
        <script>b.addEventListener("click", (e) => (document.title = e.clientX + "," + e.clientY))</script></body>`);
      await p.evaluate(() => window.scrollTo(0, 1000));
      const shot = await pageShot(p);
      expect([shot.width, shot.height]).toEqual([1451, 816]);
      expect(shot.image[0]).toBe(0xff);
      // The button's center on the page (1550, 720 after scrolling) is (1171.6, 544) on the image.
      await shot.click(1172, 544, "left");
      const [x, y] = (await p.title()).split(",").map(Number);
      expect(Math.abs(x! - 1550)).toBeLessThan(3);
      expect(Math.abs(y! - 720)).toBeLessThan(3);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
