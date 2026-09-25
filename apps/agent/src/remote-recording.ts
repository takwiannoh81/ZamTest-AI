/**
 * Recording asked for in the Designer: opens the browser (web) or starts the
 * program (desktop) on this PC, records clicks and typing, and reports the steps
 * so far about once a second until the Designer says to stop (or the browser
 * window is closed). "Indicate" lets the person click the application to record
 * instead of typing its path; "inspect" sends an application window's controls
 * and the screen, for AI to fix or build steps from what is really there; "pick"
 * lets the person indicate one element (on a web page or in an application) for a step.
 */
import { desktop } from "@zamtest/actions";
import { errorMessage } from "@zamtest/core";
import type { Step, VariableDef, Workflow } from "@zamtest/core";
import { desktopEventsToWorkflow, parseRawEvents, processOf } from "./desktop-recorder.js";
import type { RawDesktopEvent } from "./desktop-recorder.js";
import { eventsToWorkflow, startRecording } from "./recorder.js";
import { pickWebElement } from "./picker.js";
import type { PickedElement } from "./picker.js";

export interface RemoteRecordingRequest {
  id: string;
  kind: "web" | "desktop" | "indicate" | "inspect" | "pick";
  url?: string;
  program?: string;
  /** Desktop: the program is already open (it was indicated): record it without starting another one. */
  attach?: boolean;
  /** Indicate: the instruction shown on the screen, in the person's language. */
  hint?: string;
  /** Inspect: the window, as a desktop selector (e.g. window[process="erp"]). */
  selector?: string;
  /** Pick: an element on a web page (at url) or in a Windows application. */
  target?: "web" | "desktop";
}

/** Inspect: what is on the PC now. */
export interface Inspected {
  selector: string;
  /** The window was found (its controls are in tree); if not, tree lists the open windows. */
  found: boolean;
  tree: string;
  /** The screen, as a JPEG in base64. */
  screen?: string;
}

/** The application the person clicked. */
export interface IndicatedApp {
  path: string;
  process: string;
  title: string;
}

export interface RecordingProgress {
  steps: Step[];
  variables: VariableDef[];
  done?: boolean;
  error?: string;
  /** Indicate: the application clicked (unset: Esc, or no click in time). */
  picked?: IndicatedApp;
  inspected?: Inspected;
  /** Pick: the element indicated (unset: Esc, closed, or no click in time). */
  element?: PickedElement;
}

/** Sends the steps so far; answers whether the Designer asked to stop. */
export type ReportProgress = (progress: RecordingProgress) => Promise<{ stop: boolean }>;

const INTERVAL_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stepsOf = (workflow: Workflow) => workflow.root.slots?.body ?? [];

export async function runRemoteRecording(request: RemoteRecordingRequest, report: ReportProgress, log: (message: string) => void): Promise<void> {
  try {
    if (request.kind === "web") await recordWeb(request, report);
    else if (request.kind === "indicate") await indicate(request, report);
    else if (request.kind === "inspect") await inspect(request, report);
    else if (request.kind === "pick") await pick(request, report);
    else await recordDesktop(request, report);
    log(`Recording ${request.id} finished`);
  } catch (err) {
    log(`Recording ${request.id} failed: ${errorMessage(err)}`);
    await report({ steps: [], variables: [], error: errorMessage(err) }).catch(() => undefined);
  }
}

async function recordWeb(request: RemoteRecordingRequest, report: ReportProgress) {
  const url = request.url ?? "about:blank";
  // ZAMTEST_RECORD_HEADLESS=1: for automated tests only (nobody could click in it).
  const recording = await startRecording(url, { headless: process.env.ZAMTEST_RECORD_HEADLESS === "1" });
  // The steps without the final "Close Browser": steps added after the recording (checks) need the page.
  const current = (workflow: Workflow) => {
    const steps = stepsOf(workflow);
    return { steps: steps.at(-1)?.type === "browser.close" ? steps.slice(0, -1) : steps, variables: workflow.variables };
  };
  for (;;) {
    await sleep(INTERVAL_MS);
    // Closing the browser window ends the recording too.
    if (recording.page.isClosed()) break;
    const { stop } = await report(current(eventsToWorkflow(url, recording.events)));
    if (stop) break;
  }
  const workflow = await recording.stop();
  await report({ ...current(workflow), done: true });
}

/** How long the person has to click the application. */
const INDICATE_TIMEOUT_MS = 60_000;

async function indicate(request: RemoteRecordingRequest, report: ReportProgress) {
  const driver = desktop.DesktopDriver.start();
  try {
    const picked = await driver.call<IndicatedApp | null>("indicateWindow", { timeoutMs: INDICATE_TIMEOUT_MS, hint: request.hint });
    await report({ steps: [], variables: [], done: true, picked: picked ?? undefined });
  } finally {
    await driver.close();
  }
}

/** Enough of a window's controls for AI, without sending thousands of lines. */
const INSPECT_MAX_NODES = 1200;

async function inspect(request: RemoteRecordingRequest, report: ReportProgress) {
  const driver = desktop.DesktopDriver.start();
  try {
    const selector = request.selector ?? "";
    let found = false;
    let tree = "";
    if (selector) {
      try {
        tree = (await driver.call<{ tree: string }>("tree", { selector, depth: 30, maxNodes: INSPECT_MAX_NODES, timeoutMs: 5000 })).tree;
        found = true;
      } catch {
        // Not open (or not found): the open windows instead.
      }
    }
    if (!found) tree = (await driver.call<{ tree: string }>("tree", { maxNodes: 300 })).tree;
    const screen = await driver
      .call<{ data: string }>("snapshot", { maxWidth: 1400, quality: 60 })
      .then((r) => r.data)
      .catch(() => undefined);
    await report({ steps: [], variables: [], done: true, inspected: { selector, found, tree, screen } });
  } finally {
    await driver.close();
  }
}

/** How long the person has to indicate an element in an application. */
const PICK_DESKTOP_TIMEOUT_MS = 2 * 60_000;

async function pick(request: RemoteRecordingRequest, report: ReportProgress) {
  let element: PickedElement | undefined;
  if (request.target === "web") {
    // Asks every 2 s whether the Designer cancelled, so the browser closes then.
    let stopped = false;
    const timer = setInterval(() => {
      void report({ steps: [], variables: [] }).then((r) => (stopped ||= r.stop), () => undefined);
    }, 2000);
    try {
      element = (await pickWebElement(request.url ?? "about:blank", request.hint ?? "", () => stopped)) ?? undefined;
    } finally {
      clearInterval(timer);
    }
  } else {
    const driver = desktop.DesktopDriver.start();
    try {
      const picked = await driver.call<{ chain: string } | null>("indicateElement", { timeoutMs: PICK_DESKTOP_TIMEOUT_MS, hint: request.hint });
      const chain = picked ? (JSON.parse(picked.chain) as desktop.ElementInfo[]) : [];
      if (chain.length) element = { selector: desktop.selectorFromChain(chain), description: desktop.describeChain(chain) };
    } finally {
      await driver.close();
    }
  }
  await report({ steps: [], variables: [], done: true, element });
}

async function recordDesktop(request: RemoteRecordingRequest, report: ReportProgress) {
  const driver = desktop.DesktopDriver.start();
  // With a program, only its windows are recorded (not the browser with the Designer, ...).
  const processes = request.program ? [processOf(request.program)] : undefined;
  const events: RawDesktopEvent[] = [];
  const current = () => {
    let workflow = desktopEventsToWorkflow(events, { program: request.program, processes });
    // The program runs under another process name (e.g. calc.exe -> CalculatorApp): keep everything.
    const recorded = stepsOf(workflow).length - (request.program ? 1 : 0);
    if (processes && recorded === 0 && events.some((e) => e.chain?.length)) workflow = desktopEventsToWorkflow(events, { program: request.program });
    return { steps: stepsOf(workflow), variables: workflow.variables };
  };
  try {
    if (request.program && !request.attach) await driver.call("launch", { path: request.program });
    await driver.call("recordStart");
    for (;;) {
      await sleep(INTERVAL_MS);
      events.push(...parseRawEvents(await driver.call("recordPoll")));
      const { stop } = await report(current());
      if (stop) break;
    }
    events.push(...parseRawEvents(await driver.call("recordStop")));
    await report({ ...current(), done: true });
  } finally {
    await driver.close();
  }
}
