import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { desktop } from "../src/index.js";

const { describeChain, DesktopDriver, DRIVER_SCRIPT, formatSelector, parseSelector, selectorFromChain } = desktop;

describe("desktop selectors", () => {
  it("parses segments, attributes, operators and index", () => {
    expect(parseSelector('window[process="notepad"][name$=" - Notepad"] > menuitem[name="File"][index=2]')).toEqual([
      {
        type: "window",
        conditions: [
          { attr: "process", op: "=", value: "notepad" },
          { attr: "name", op: "$=", value: " - Notepad" },
        ],
      },
      { type: "menuitem", conditions: [{ attr: "name", op: "=", value: "File" }], index: 2 },
    ]);
    expect(parseSelector('*[id~="num"]')).toEqual([{ type: "*", conditions: [{ attr: "id", op: "~=", value: "num" }] }]);
    expect(parseSelector('Window[NAME="a > b [c]"] > Button')[0]!.conditions[0]!.value).toBe("a > b [c]");
    expect(parseSelector('edit[name="say \\"hi\\""]')[0]!.conditions[0]!.value).toBe('say "hi"');
  });

  it("round-trips through formatSelector", () => {
    const src = 'window[process="saplogon"] > edit[name="User \\"x\\""][index=2]';
    expect(parseSelector(formatSelector(parseSelector(src)))).toEqual(parseSelector(src));
  });

  it("rejects invalid selectors with a clear reason", () => {
    expect(() => parseSelector("")).toThrow(/empty/);
    expect(() => parseSelector("widget")).toThrow(/unknown control type/);
    expect(() => parseSelector('button[color="red"]')).toThrow(/unknown attribute/);
    expect(() => parseSelector('window > button[process="x"]')).toThrow(/first segment/);
    expect(() => parseSelector("button[index=0]")).toThrow(/positive/);
    expect(() => parseSelector('button[name="x"')).toThrow(/missing \]/);
    expect(() => parseSelector("css=#id")).toThrow();
  });

  it("builds robust selectors from recorded element chains", () => {
    const notepad = { type: "window", name: "report.txt - Notepad", process: "Notepad", class: "Notepad" };
    expect(selectorFromChain([notepad, { type: "menubar", name: "Application" }, { type: "menuitem", name: "File" }])).toBe(
      'window[process="notepad"][name$=" - Notepad"] > menuitem[name="File"]',
    );
    const calc = { type: "window", name: "Calculator", process: "ApplicationFrameHost" };
    expect(selectorFromChain([calc, { type: "button", name: "Seven", id: "num7Button" }])).toBe(
      'window[process="applicationframehost"] > button[id="num7Button"]',
    );
    // Generated ids are skipped; nameless targets are anchored on an ancestor with an id.
    expect(
      selectorFromChain([
        { type: "window", name: "Orders", process: "erp" },
        { type: "pane", id: "OrderGrid" },
        { type: "edit", id: "12345", class: "WindowsForms10.EDIT" },
      ]),
    ).toBe('window[process="erp"] > pane[id="OrderGrid"] > edit[class="WindowsForms10.EDIT"]');
    // Numeric ids are kept for classic Win32 controls (dialog control IDs) but not for others.
    expect(selectorFromChain([{ type: "window", name: "Calculator", process: "win32calc" }, { type: "button", id: "137", class: "Button" }])).toBe(
      'window[process="win32calc"] > button[id="137"]',
    );
    expect(selectorFromChain([{ type: "window", name: "App", process: "app" }, { type: "button", id: "137", name: "OK", class: "Xaml" }])).toBe(
      'window[process="app"] > button[name="OK"]',
    );
    expect(describeChain([notepad, { type: "menuitem", name: "File" }])).toBe('The "File" menu item in Notepad');
  });
});

/** PowerShell 7 (pwsh) lets Linux/macOS CI test the driver's protocol and syntax; the UI Automation parts need Windows. */
function findPwsh(): string | undefined {
  if (process.env.ZAMTEST_POWERSHELL) return process.env.ZAMTEST_POWERSHELL;
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return "pwsh";
  } catch {
    return undefined;
  }
}
const pwsh = findPwsh();

describe.skipIf(!pwsh)("desktop driver (PowerShell)", () => {
  it("passes static checks: PowerShell parses and the C# compiles as C# 5", () => {
    const out = execFileSync(
      pwsh!,
      [
        "-NoProfile",
        "-File",
        fileURLToPath(new URL("./fixtures/check-driver.ps1", import.meta.url)),
        "-Driver",
        DRIVER_SCRIPT,
        "-Stub",
        fileURLToPath(new URL("./fixtures/uia-stub.cs", import.meta.url)),
      ],
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("DONE");
  }, 60_000);

  it("speaks the JSON-lines protocol and survives failed operations", async () => {
    const previous = process.env.ZAMTEST_POWERSHELL;
    process.env.ZAMTEST_POWERSHELL = pwsh;
    const driver = DesktopDriver.start();
    try {
      const pong = await driver.call<{ pong: boolean; powershell: string }>("ping");
      expect(pong.pong).toBe(true);
      if (process.platform !== "win32") await expect(driver.call("windows")).rejects.toThrow();
      await expect(driver.call("click", { selector: "not a selector!" })).rejects.toThrow(/Invalid desktop selector/);
      const [a, b] = await Promise.all([driver.call("ping"), driver.call("ping")]);
      expect(a).toEqual(b);
    } finally {
      await driver.close();
      if (previous === undefined) delete process.env.ZAMTEST_POWERSHELL;
      else process.env.ZAMTEST_POWERSHELL = previous;
    }
  }, 60_000);
});

describe("desktop driver on other platforms", () => {
  it.skipIf(process.platform === "win32" || process.env.ZAMTEST_POWERSHELL)("explains that desktop actions need Windows", () => {
    expect(() => DesktopDriver.start()).toThrow(/Windows/);
  });
});

describe.skipIf(process.platform === "win32")("desktop actions with a fake driver", () => {
  it("runs handlers and self-heals a broken selector", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { parseWorkflow, runWorkflow } = await import("@zamtest/core");
    const { builtinHandlers } = await import("../src/index.js");

    const log = join(mkdtempSync(join(tmpdir(), "zamtech-desktop-")), "calls.jsonl");
    const env = { ...process.env };
    process.env.ZAMTEST_POWERSHELL = fileURLToPath(new URL("./fixtures/fake-desktop-driver.mjs", import.meta.url));
    process.env.FAKE_DESKTOP_LOG = log;
    process.env.FAKE_DESKTOP_ELEMENTS = JSON.stringify([
      'window[process="erp"]',
      'window[process="erp"] > button[id="saveButton"]',
      'window[process="erp"] > text[id="status"]',
      'window[process="erp"] > datagrid[id="lines"]',
    ]);
    const healRequests: Array<{ failedSelector: string; tree: string; description?: string }> = [];
    const ai = {
      healDesktopSelector: async (input: { failedSelector: string; tree: string; description?: string }) => {
        healRequests.push(input);
        return {
          candidates: [
            { selector: 'window[process="erp"] > button[name="Nope"]', confidence: 0.9, reason: "wrong" },
            { selector: "broken [[", confidence: 0.8, reason: "invalid" },
            { selector: 'window[process="erp"] > button[id="saveButton"]', confidence: 0.7, reason: "stable AutomationId" },
          ],
        };
      },
    };
    try {
      const events: Array<{ type: string; name?: string; data?: unknown }> = [];
      const result = await runWorkflow(
        parseWorkflow({
          id: "d",
          name: "d",
          variables: [{ name: "pid", direction: "out" }, { name: "status", direction: "out" }, { name: "lines", direction: "out" }],
          root: {
            id: "r",
            type: "core.sequence",
            props: {},
            slots: {
              body: [
                { id: "a", type: "desktop.launch", props: { path: "erp.exe", waitFor: 'window[process="erp"]', output: "pid" } },
                { id: "b", type: "desktop.click", props: { selector: 'window[process="erp"] > button[name="Save"]', description: "The Save button" } },
                { id: "c", type: "desktop.getText", props: { selector: 'window[process="erp"] > text[id="status"]', output: "status" } },
                { id: "d", type: "desktop.readTable", props: { selector: 'window[process="erp"] > datagrid[id="lines"]', output: "lines" } },
                { id: "e", type: "desktop.type", props: { selector: 'window[process="erp"] > edit[name="Gone"]', text: "x", aiHeal: false } },
              ],
            },
          },
        }),
        { handlers: builtinHandlers, services: { ai }, onEvent: (e) => events.push(e as never) },
      );
      // The last step fails on purpose: healing is switched off for it.
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/Element not found/);
      expect(result.outputs.pid).toBe(4242);
      expect(result.outputs.status).toBe("Saved");
      expect(result.outputs.lines).toEqual([
        { Item: "Paper", Qty: "2", column3: "x" },
        { Item: "Ink", Qty: "1", column3: "y" },
      ]);
      expect(healRequests).toHaveLength(1);
      expect(healRequests[0]!.description).toBe("The Save button");
      expect(healRequests[0]!.tree).toContain('id="saveButton"');
      const healed = events.find((e) => e.type === "custom" && e.name === "selectorHealed");
      expect(healed?.data).toMatchObject({ newSelector: 'window[process="erp"] > button[id="saveButton"]' });
      const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { op: string });
      expect(calls.map((c) => c.op)).toEqual(["launch", "waitFor", "click", "tree", "count", "count", "click", "getText", "readTable", "type"]);
    } finally {
      process.env = env;
    }
  }, 30_000);
});
