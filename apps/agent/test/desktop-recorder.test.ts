import { describe, expect, it } from "vitest";
import { BUILTIN_ACTIONS, parseWorkflow } from "@zamtest/core";
import { desktopEventsToWorkflow, parseRawEvents } from "../src/desktop-recorder.js";
import type { RawDesktopEvent } from "../src/desktop-recorder.js";

const win = { type: "window", name: "Sign in - ERP", process: "erp", class: "WinForm" };
const user = { type: "edit", id: "txtUser", name: "User" };
const pass = { type: "edit", id: "txtPass", name: "Password", isPassword: true };
const ok = { type: "button", id: "btnOk", name: "OK" };
const terminal = { type: "window", name: "Windows PowerShell", process: "WindowsTerminal" };

describe("desktop recorder", () => {
  it("turns recorded events into a clean workflow", () => {
    const raw = [
      JSON.stringify({ kind: "click", chain: [win, user] }), // focus click on a field: dropped
      JSON.stringify({ kind: "type", value: "gr", chain: [win, user] }),
      JSON.stringify({ kind: "type", value: "grace", chain: [win, user] }), // same field: merged
      JSON.stringify({ kind: "type", value: "", secret: true, chain: [win, pass] }),
      JSON.stringify({ kind: "enter", chain: [win, pass] }),
      JSON.stringify({ kind: "rightclick", chain: [win, ok] }),
      JSON.stringify({ kind: "click", chain: [terminal, { type: "pane" }] }), // the recorder's own terminal: dropped
      JSON.stringify({ kind: "error", message: "hook failed" }),
      "not json",
    ];
    const events: RawDesktopEvent[] = parseRawEvents(raw);
    expect(events).toHaveLength(8);
    const wf = desktopEventsToWorkflow(events, { name: "ERP login", program: "C:\\ERP\\erp.exe" });
    expect(() => parseWorkflow(wf)).not.toThrow();
    const steps = wf.root.slots!.body!;
    expect(steps.map((s) => s.type)).toEqual(["desktop.launch", "desktop.type", "desktop.type", "desktop.click"]);
    expect(steps[0]!.props).toEqual({ path: "C:\\ERP\\erp.exe", waitFor: 'window[process="erp"][name$=" - ERP"]' });
    expect(steps[1]!.props).toMatchObject({ selector: 'window[process="erp"][name$=" - ERP"] > edit[id="txtUser"]', text: "grace" });
    expect(steps[2]!.props).toMatchObject({ text: "{{ password }}", pressEnter: true });
    expect(steps[3]!.props).toMatchObject({ selector: 'window[process="erp"][name$=" - ERP"] > button[id="btnOk"]', button: "right" });
    expect(steps[3]!.props.description).toBe('The "OK" button in ERP');
    expect(wf.variables).toEqual([expect.objectContaining({ name: "password", direction: "in" })]);
    // Every step type exists in the catalog.
    for (const s of steps) expect(BUILTIN_ACTIONS.some((a) => a.type === s.type)).toBe(true);
  });

  it("sends Enter as a key press when nothing was typed first", () => {
    const wf = desktopEventsToWorkflow([{ kind: "enter", chain: [win, user] }]);
    expect(wf.root.slots!.body![0]).toMatchObject({ type: "desktop.sendKeys", props: { keys: "{ENTER}" } });
  });
});
