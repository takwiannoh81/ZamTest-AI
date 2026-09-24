/**
 * Recording asked for in the Designer: opens the browser (web) or starts the
 * program (desktop) on this PC, records clicks and typing, and reports the steps
 * so far about once a second until the Designer says to stop (or the browser
 * window is closed).
 */
import { desktop } from "@zamtest/actions";
import { errorMessage } from "@zamtest/core";
import type { Step, VariableDef, Workflow } from "@zamtest/core";
import { desktopEventsToWorkflow, parseRawEvents, processOf } from "./desktop-recorder.js";
import type { RawDesktopEvent } from "./desktop-recorder.js";
import { eventsToWorkflow, startRecording } from "./recorder.js";

export interface RemoteRecordingRequest {
  id: string;
  kind: "web" | "desktop";
  url?: string;
  program?: string;
}

export interface RecordingProgress {
  steps: Step[];
  variables: VariableDef[];
  done?: boolean;
  error?: string;
}

/** Sends the steps so far; answers whether the Designer asked to stop. */
export type ReportProgress = (progress: RecordingProgress) => Promise<{ stop: boolean }>;

const INTERVAL_MS = 800;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stepsOf = (workflow: Workflow) => workflow.root.slots?.body ?? [];

export async function runRemoteRecording(request: RemoteRecordingRequest, report: ReportProgress, log: (message: string) => void): Promise<void> {
  try {
    if (request.kind === "web") await recordWeb(request, report);
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
    if (request.program) await driver.call("launch", { path: request.program });
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
