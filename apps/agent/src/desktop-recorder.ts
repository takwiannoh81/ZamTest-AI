import { desktop } from "@zamtest/actions";
import type { desktop as Desktop } from "@zamtest/actions";
import { newStepId } from "@zamtest/core";
import type { Step, VariableDef, Workflow } from "@zamtest/core";

type ElementInfo = Desktop.ElementInfo;

/** One raw event from the Windows recorder in driver.ps1. */
export interface RawDesktopEvent {
  kind: "click" | "rightclick" | "type" | "enter" | "error";
  chain?: ElementInfo[];
  value?: string;
  secret?: boolean;
  message?: string;
}

/** Processes whose windows are never part of the recorded process (the terminal running the recorder, the taskbar). */
const IGNORED_PROCESSES = new Set(["windowsterminal", "conhost", "openconsole", "cmd", "powershell", "pwsh", "node", "searchhost", "startmenuexperiencehost", "shellexperiencehost"]);
const IGNORED_WINDOW_CLASSES = new Set(["Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "Progman", "WorkerW"]);
/** Clicking into these only moves the focus; the typing that follows is recorded instead. */
const FIELD_TYPES = new Set(["edit", "document"]);

/** Containers: a click that lands on one of these (without a name or id) does nothing useful. */
const CONTAINER_TYPES = new Set(["pane", "group", "custom", "window"]);

/** Process name a program path runs as, e.g. "C:\\Apps\\Erp.exe" -> "erp". */
export function processOf(program: string): string {
  return (program.split(/[\\/]/).pop() ?? program).replace(/\.exe$/i, "").toLowerCase();
}

export function isIgnored(chain: ElementInfo[] | undefined, processes?: string[]): boolean {
  const win = chain?.[0];
  if (!win) return true;
  const proc = (win.process ?? "").toLowerCase();
  if (processes?.length && !processes.includes(proc)) return true;
  return IGNORED_PROCESSES.has(proc) || IGNORED_WINDOW_CLASSES.has(win.class ?? "");
}

/** Clicks on the window itself or on an anonymous container (e.g. a WinUI island bridge). */
function isContainerClick(chain: ElementInfo[]): boolean {
  if (chain.length === 1) return true;
  const target = chain.at(-1)!;
  return CONTAINER_TYPES.has(target.type) && !target.name && !target.id;
}

/** Collapses recorded desktop events into workflow steps. */
export function desktopEventsToWorkflow(
  events: RawDesktopEvent[],
  options: {
    name?: string;
    program?: string;
    /** Only record these processes (lower-case names without .exe). Empty = every application. */
    processes?: string[];
  } = {},
): Workflow {
  const steps: Step[] = [];
  const variables: VariableDef[] = [];
  let secretCount = 0;
  let launch: Step | undefined;
  if (options.program) {
    launch = { id: newStepId(), type: "desktop.launch", label: `Start ${options.program.split(/[\\/]/).pop() || options.program}`, props: { path: options.program } };
    steps.push(launch);
  }

  for (const e of events) {
    if (e.kind === "error" || !e.chain?.length || isIgnored(e.chain, options.processes)) continue;
    if ((e.kind === "click" || e.kind === "rightclick") && isContainerClick(e.chain)) continue;
    const selector = desktop.selectorFromChain(e.chain);
    const description = desktop.describeChain(e.chain);
    if (launch && launch.props.waitFor === undefined) {
      launch.props.waitFor = desktop.selectorFromChain(e.chain.slice(0, 1));
    }
    const last = steps.at(-1);
    const target = e.chain.at(-1)!;

    if (e.kind === "type") {
      const sameField = last?.type === "desktop.type" && last.props.selector === selector;
      let text = e.value ?? "";
      if (e.secret && sameField) {
        text = String(last.props.text);
      } else if (e.secret || target.isPassword) {
        const varName = secretCount === 0 ? "password" : `password${secretCount + 1}`;
        secretCount++;
        variables.push({ name: varName, type: "string", direction: "in", description: `Recorded from ${description}. Use a credential asset in production.` });
        text = `{{ ${varName} }}`;
      }
      if (sameField) last.props.text = text;
      else steps.push({ id: newStepId(), type: "desktop.type", props: { selector, text, description } });
    } else if (e.kind === "enter") {
      if (last?.type === "desktop.type" && last.props.selector === selector) last.props.pressEnter = true;
      else steps.push({ id: newStepId(), type: "desktop.sendKeys", props: { keys: "{ENTER}", selector, description } });
    } else {
      if (e.kind === "click" && FIELD_TYPES.has(target.type)) continue;
      const props: Record<string, unknown> = { selector, description };
      if (e.kind === "rightclick") props.button = "right";
      steps.push({ id: newStepId(), type: "desktop.click", props });
    }
  }

  return {
    schemaVersion: 1,
    id: `desktop-recording-${Date.now().toString(36)}`,
    name: options.name ?? "Desktop recording",
    description: `Recorded on ${new Date().toISOString().slice(0, 10)} on Windows`,
    variables,
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: steps } },
  };
}

/** Parses the JSON strings the driver returns from recordPoll/recordStop. */
export function parseRawEvents(lines: unknown): RawDesktopEvent[] {
  if (!Array.isArray(lines)) return [];
  const out: RawDesktopEvent[] = [];
  for (const line of lines) {
    try {
      out.push(typeof line === "string" ? JSON.parse(line) : (line as RawDesktopEvent));
    } catch {
      // skip malformed events
    }
  }
  return out;
}
