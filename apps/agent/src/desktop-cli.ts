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
      const info = await driver.call<{ providers: string }>("info");
      return `${list.length} windows, e.g. ${list.slice(0, 3).map((w) => `${w.name} [${w.process}]`).join(", ")}; Win32 helper: ${info.providers}`;
    });
    const count = async (selector: string) => (await driver.call<{ count: number }>("count", { selector })).count;

    // Notepad: launch, type, read back, close without saving. Everything after typing is scoped
    // to the window titled with the typed text, so other open Notepad windows are left alone.
    const anyNotepad = 'window[process="notepad"]';
    const text = `ZamTech AI test ${Date.now()}`;
    const before = await count(anyNotepad).catch(() => 0);
    if (before) log(`      (${before} Notepad window(s) already open; the test uses only the one it opens)`);
    let win = anyNotepad;
    let field = "";
    const notepadOk = await check("Start Notepad", async () => {
      await driver.call("launch", { path: "notepad.exe" });
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && (await count(anyNotepad)) <= before) await sleep(300);
      const fresh = `${anyNotepad}[name^="Untitled"]`;
      if ((await count(fresh)) === 1) win = fresh;
      await driver.call("waitFor", { selector: win, timeoutMs: 5000 });
    });
    if (notepadOk) {
      await check("Find the text area", async () => {
        for (const kind of ["document", "edit"]) {
          const n = await count(`${win} > ${kind}`);
          if (n >= 1) {
            field = n === 1 ? `${win} > ${kind}` : `${win} > ${kind}[index=1]`;
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
        // Windows 11 Notepad names the window after the text; classic Notepad shows "*Untitled".
        for (const titled of [`${anyNotepad}[name~="${text}"]`, `${anyNotepad}[name^="*Untitled"]`]) {
          if ((await count(titled)) === 1) {
            win = titled;
            break;
          }
        }
      }
      await check(
        "Menu bar is visible to UI Automation",
        async () => {
          const n = await count(`${win} > menuitem`);
          if (!n) throw new Error("no menu items found (classic Win32 menus: use Send Keys, e.g. %f for Alt+F)");
          return `${n} menu items`;
        },
        true,
      );
      const tree = await driver.call<{ tree: string }>("tree", { selector: win, maxNodes: 25 }).catch(() => ({ tree: "" }));
      log("      Notepad UI tree (first 25 nodes):");
      for (const l of tree.tree.split("\n")) log(`        ${l}`);
      await check("Close Notepad without saving", async () => {
        await driver.call("close", { selector: win });
        // Notepad may ask "Save changes?" (inside the window or as its own dialog): answer "Don't save".
        const dontSave = `${anyNotepad} > button[name^="Don"]`;
        const deadline = Date.now() + 10_000;
        let answered = false;
        while (Date.now() < deadline) {
          if (!(await count(win))) return answered ? "answered the save prompt" : undefined;
          if (await count(dontSave)) {
            await driver.call("click", { selector: `${dontSave}[index=1]` });
            answered = true;
          }
          await sleep(400);
        }
        throw new Error(`Notepad is still open (${win})`);
      });
    }

    // Calculator (optional: not installed on every Windows edition). Windows 10/11 have the modern
    // app; Windows Server has the classic one, whose buttons are Win32 controls with fixed IDs.
    const modern = 'window[name="Calculator"]';
    const classic = 'window[process="win32calc"]';
    let calc = modern;
    const calcStarted = await check(
      "Start Calculator",
      async () => {
        await driver.call("launch", { path: "calc.exe" });
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (await count(classic)) {
            calc = classic;
            return "classic Calculator";
          }
          if (await count(modern)) return "Calculator app";
          await sleep(300);
        }
        throw new Error("no Calculator window appeared");
      },
      true,
    );
    if (calcStarted) {
      const steps =
        calc === classic
          ? { buttons: ["81", "137", "93", "138", "121"], display: `${classic} > text[id="150"]`, clear: "81" }
          : {
              buttons: ["clearButton", "num7Button", "plusButton", "num8Button", "equalButton"],
              display: `${modern} > text[id="CalculatorResults"]`,
              clear: "clearButton",
            };
      const calcOk = await check(
        "Calculate 7 + 8 with button clicks",
        async () => {
          for (const id of steps.buttons) {
            const selector = `${calc} > button[id="${id}"]`;
            if (id === steps.clear && !(await count(selector))) continue;
            await driver.call("click", { selector });
          }
          const r = await driver.call<{ text: string }>("getText", { selector: steps.display });
          if (!/15\b/.test(r.text)) throw new Error(`display shows "${r.text}"`);
          return r.text;
        },
        true,
      );
      if (!calcOk) {
        const tree = await driver.call<{ tree: string }>("tree", { selector: calc, maxNodes: 60 }).catch(() => ({ tree: "" }));
        log("      Calculator UI tree (first 60 nodes):");
        for (const l of tree.tree.split("\n")) log(`        ${l}`);
      }
      await check("Close Calculator", async () => void (await driver.call("close", { selector: calc })), true);
    }
  } finally {
    await driver.close();
  }

  log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed. Desktop automation works on this machine.");
  await writeFile("desktop-test-report.txt", `${lines.join("\n")}\n`);
  console.log("Report saved to desktop-test-report.txt");
  return failures === 0;
}
