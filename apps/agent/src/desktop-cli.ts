import { writeFile } from "node:fs/promises";
import { release } from "node:os";
import { createInterface } from "node:readline";
import { desktop } from "@zamtest/actions";
import { errorMessage } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { desktopEventsToWorkflow, isIgnored, parseRawEvents } from "./desktop-recorder.js";
import type { RawDesktopEvent } from "./desktop-recorder.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `record-desktop`: records clicks and typing in Windows applications until Enter is pressed. */
export async function recordDesktop(options: { program?: string; name: string }): Promise<Workflow> {
  const driver = desktop.DesktopDriver.start();
  const events: RawDesktopEvent[] = [];
  const show = (batch: RawDesktopEvent[]) => {
    for (const e of batch) {
      events.push(e);
      if (e.kind === "error") console.log(`  (recorder warning: ${e.message})`);
      else if (e.chain?.length && !isIgnored(e.chain)) {
        console.log(`  recorded ${e.kind.padEnd(10)} ${desktop.describeChain(e.chain)}${e.secret ? " (password, not stored)" : ""}`);
      }
    }
  };
  try {
    if (options.program) {
      await driver.call("launch", { path: options.program });
      console.log(`Started ${options.program}`);
    }
    await driver.call("recordStart");
    console.log("Recording. Work in your Windows applications, then come back here and press Enter to finish.\n");
    let done = false;
    const rl = createInterface({ input: process.stdin });
    rl.once("line", () => {
      done = true;
      rl.close();
    });
    process.once("SIGINT", () => {
      done = true;
    });
    while (!done) {
      show(parseRawEvents(await driver.call("recordPoll")));
      await sleep(300);
    }
    show(parseRawEvents(await driver.call("recordStop")));
  } finally {
    await driver.close();
  }
  return desktopEventsToWorkflow(events, { name: options.name, program: options.program });
}

/**
 * `desktop-test`: exercises the driver against Notepad and Calculator and
 * writes a report the user can send to support.
 */
export async function desktopSelfTest(): Promise<boolean> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  let failures = 0;
  const check = async (label: string, fn: () => Promise<string | void>, optional = false) => {
    try {
      const detail = await fn();
      log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
      return true;
    } catch (err) {
      if (!optional) failures++;
      log(`${optional ? "SKIP" : "FAIL"}  ${label}: ${errorMessage(err)}`);
      return false;
    }
  };

  log(`ZamTech AI desktop self-test, ${new Date().toISOString()}`);
  log(`Node ${process.version}, ${process.platform} ${release()}`);
  let driver: desktop.DesktopDriver;
  try {
    driver = desktop.DesktopDriver.start();
  } catch (err) {
    log(`FAIL  start driver: ${errorMessage(err)}`);
    return false;
  }

  try {
    await check("PowerShell driver", async () => {
      const r = await driver.call<{ powershell: string }>("ping");
      return `PowerShell ${r.powershell}`;
    });
    await check("UI Automation (list windows)", async () => {
      const list = await driver.call<Array<{ name: string; process: string }>>("windows");
      return `${list.length} windows, e.g. ${list.slice(0, 3).map((w) => `${w.name} [${w.process}]`).join(", ")}`;
    });

    // Notepad: launch, type, read back, close without saving.
    const win = 'window[process="notepad"]';
    const text = `ZamTech AI test ${Date.now()}`;
    let field = "";
    const notepadOk = await check("Start Notepad", async () => {
      await driver.call("launch", { path: "notepad.exe" });
      await driver.call("waitFor", { selector: win, timeoutMs: 15000 });
    });
    if (notepadOk) {
      await check("Find the text area", async () => {
        for (const candidate of [`${win} > document`, `${win} > edit`]) {
          const { count } = await driver.call<{ count: number }>("count", { selector: candidate });
          if (count >= 1) {
            field = count === 1 ? candidate : `${candidate}[index=1]`;
            return field;
          }
        }
        throw new Error("no document or edit control found");
      });
      if (field) {
        await check("Type into Notepad", async () => {
          const r = await driver.call<{ method: string }>("type", { selector: field, text });
          return `method ${r.method}`;
        });
        await check("Read the text back", async () => {
          const r = await driver.call<{ text: string }>("getText", { selector: field });
          if (!r.text.includes(text)) throw new Error(`expected "${text}", got "${r.text.slice(0, 80)}"`);
          return "matches";
        });
      }
      await check("Menu bar is visible to UI Automation", async () => {
        const r = await driver.call<{ count: number }>("count", { selector: `${win} > menuitem` });
        if (!r.count) throw new Error("no menu items found");
        return `${r.count} menu items`;
      });
      const tree = await driver.call<{ tree: string }>("tree", { selector: win, maxNodes: 40 }).catch(() => ({ tree: "" }));
      log("      Notepad UI tree (first 40 nodes):");
      for (const l of tree.tree.split("\n")) log(`        ${l}`);
      await check("Close Notepad without saving", async () => {
        if (field) await driver.call("type", { selector: field, text: "" }).catch(() => undefined);
        await driver.call("close", { selector: win });
        await sleep(800);
        const { count } = await driver.call<{ count: number }>("count", { selector: `${win} > button[name^="Don"]` });
        if (count > 0) await driver.call("click", { selector: `${win} > button[name^="Don"][index=1]` });
        await driver.call("waitFor", { selector: win, state: "gone", timeoutMs: 5000 });
      });
    }

    // Calculator (optional: the app is not installed on every Windows edition).
    const calc = 'window[name="Calculator"]';
    const calcStarted = await check(
      "Start Calculator",
      async () => {
        await driver.call("launch", { path: "calc.exe" });
        await driver.call("waitFor", { selector: calc, timeoutMs: 15000 });
      },
      true,
    );
    if (calcStarted) {
      await check("Calculate 7 + 8 with button clicks", async () => {
        for (const id of ["clearButton", "num7Button", "plusButton", "num8Button", "equalButton"]) {
          const selector = `${calc} > button[id="${id}"]`;
          if (id === "clearButton" && !(await driver.call<{ count: number }>("count", { selector })).count) continue;
          await driver.call("click", { selector });
        }
        const r = await driver.call<{ text: string }>("getText", { selector: `${calc} > text[id="CalculatorResults"]` });
        if (!/15\b/.test(r.text)) throw new Error(`display shows "${r.text}"`);
        return r.text;
      });
      await check("Close Calculator", async () => {
        await driver.call("close", { selector: calc });
      });
    } else {
      log("      (Calculator is optional: Windows Server has none, and on non-English Windows its window has another name.)");
    }
  } finally {
    await driver.close();
  }

  log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. Desktop automation works on this machine.");
  await writeFile("desktop-test-report.txt", `${lines.join("\n")}\n`);
  console.log("Report saved to desktop-test-report.txt");
  return failures === 0;
}
