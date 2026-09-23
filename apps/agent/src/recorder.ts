import { newStepId } from "@zamtest/core";
import type { Step, VariableDef, Workflow } from "@zamtest/core";
import type { Browser, Page } from "playwright";

/** One user action captured in the page. */
export interface RecordedEvent {
  kind: "click" | "type" | "select" | "enter";
  selector: string;
  description: string;
  value?: string;
  secret?: boolean;
}

export interface Recording {
  page: Page;
  /** Stops recording, closes the browser and returns the workflow. */
  stop(): Promise<Workflow>;
  readonly events: RecordedEvent[];
}

/**
 * Runs inside the recorded page. Picks the most robust selector for an
 * element, in the same order the AI selector assistant prefers:
 * test ids, stable ids, accessible role + name, labels, placeholders,
 * name attributes, text, and finally a short CSS path.
 */
const PAGE_SCRIPT = String.raw`(() => {
  if (window.__zamtechRecorder) return;
  window.__zamtechRecorder = true;
  const send = (e) => window.__zamtechRecord && window.__zamtechRecord(e);
  const css = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  const quote = (v) => JSON.stringify(v);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };
  const generated = (v) => /\d{4,}|[a-f0-9]{8,}|^[0-9]|:|__|--[a-z0-9]{5,}/i.test(v);
  const text = (el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const labelOf = (el) => {
    if (el.labels && el.labels[0]) return text(el.labels[0]);
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) { const l = document.getElementById(by); if (l) return text(l); }
    return "";
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "button" || (tag === "input" && ["button", "submit", "reset"].includes(el.type))) return "button";
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "input" && el.type === "checkbox") return "checkbox";
    if (tag === "input" && el.type === "radio") return "radio";
    if (tag === "select") return "combobox";
    return "";
  };
  const nameOf = (el) => labelOf(el) || (el.tagName === "INPUT" ? el.value : text(el)).slice(0, 80);
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id && !generated(n.id)) { parts.unshift("#" + css(n.id)); break; }
      const siblings = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(n) + 1) + ")";
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  const selectorFor = (el) => {
    for (const attr of ["data-testid", "data-test", "data-qa", "data-cy"]) {
      const v = el.getAttribute(attr);
      if (v && unique("[" + attr + "=" + quote(v) + "]")) return "css=[" + attr + "=" + quote(v) + "]";
    }
    if (el.id && !generated(el.id) && unique("#" + css(el.id))) return "css=#" + css(el.id);
    const role = roleOf(el), name = nameOf(el);
    if (role && name) return "role=" + role + "[name=" + quote(name) + "]";
    const label = labelOf(el);
    if (label) return "internal:label=" + quote(label);
    const ph = el.getAttribute("placeholder");
    if (ph && unique("[placeholder=" + quote(ph) + "]")) return "css=[placeholder=" + quote(ph) + "]";
    const nm = el.getAttribute("name");
    if (nm && unique(el.tagName.toLowerCase() + "[name=" + quote(nm) + "]")) return "css=" + el.tagName.toLowerCase() + "[name=" + quote(nm) + "]";
    const t = text(el);
    if (t && t.length <= 60) return "text=" + quote(t);
    return "css=" + cssPath(el);
  };
  const describe = (el) => {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = labelOf(el) || el.getAttribute("placeholder") || el.getAttribute("name") || text(el).slice(0, 60);
    const kind = { button: "button", link: "link", checkbox: "checkbox", radio: "option", combobox: "dropdown", input: "field", textarea: "text box" }[role] || role;
    return name ? "The " + quote(name).slice(1, -1) + " " + kind : "The " + kind;
  };
  const target = (el) => el.closest("button, a, [role=button], [role=link], [role=menuitem], [role=tab], input, select, textarea, label, summary") || el;
  const isField = (el) => (el.tagName === "INPUT" && !["button", "submit", "reset", "checkbox", "radio", "file", "image"].includes(el.type)) || el.tagName === "TEXTAREA";
  document.addEventListener("click", (ev) => {
    const el = target(ev.target);
    if (isField(el) || el.tagName === "SELECT") return;
    send({ kind: "click", selector: selectorFor(el), description: describe(el) });
  }, true);
  // Typing is captured as it happens (consecutive keystrokes in one field are merged later),
  // so steps keep the order the user actually worked in.
  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (isField(el)) send({ kind: "type", selector: selectorFor(el), description: describe(el), value: el.value, secret: el.type === "password" });
  }, true);
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.tagName === "SELECT") send({ kind: "select", selector: selectorFor(el), description: describe(el), value: el.value });
  }, true);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && isField(ev.target) && ev.target.tagName !== "TEXTAREA") {
      const el = ev.target;
      send({ kind: "type", selector: selectorFor(el), description: describe(el), value: el.value, secret: el.type === "password" });
      send({ kind: "enter", selector: selectorFor(el), description: describe(el) });
    }
  }, true);
})();`;

/** Collapses the raw event stream into workflow steps. */
export function eventsToWorkflow(url: string, events: RecordedEvent[], name = "Recorded workflow"): Workflow {
  const steps: Step[] = [{ id: newStepId(), type: "browser.open", label: "Open the site", props: { url } }];
  const variables: VariableDef[] = [];
  let secretCount = 0;
  for (const e of events) {
    const last = steps[steps.length - 1]!;
    if (e.kind === "type") {
      const sameField = last.type === "browser.type" && last.props.selector === e.selector;
      let text = e.value ?? "";
      if (e.secret && sameField) {
        text = String(last.props.text); // already mapped to a password input
      } else if (e.secret) {
        // Never store passwords in the workflow; ask for them as an input instead.
        const varName = secretCount === 0 ? "password" : `password${secretCount + 1}`;
        secretCount++;
        variables.push({ name: varName, type: "string", direction: "in", description: `Recorded from ${e.description}. Use a credential asset in production.` });
        text = `{{ ${varName} }}`;
      }
      // Typing into the same field twice in a row (change + Enter) keeps the latest value.
      if (sameField) last.props.text = text;
      else steps.push({ id: newStepId(), type: "browser.type", props: { selector: e.selector, text, description: e.description } });
    } else if (e.kind === "enter") {
      if (last.type === "browser.type" && last.props.selector === e.selector) last.props.pressEnter = true;
    } else if (e.kind === "select") {
      steps.push({ id: newStepId(), type: "browser.select", props: { selector: e.selector, value: e.value ?? "", description: e.description } });
    } else {
      steps.push({ id: newStepId(), type: "browser.click", props: { selector: e.selector, description: e.description } });
    }
  }
  steps.push({ id: newStepId(), type: "browser.close", props: {} });
  return {
    schemaVersion: 1,
    id: `recording-${Date.now().toString(36)}`,
    name,
    description: `Recorded on ${new Date().toISOString().slice(0, 10)} from ${url}`,
    variables,
    root: { id: "root", type: "core.sequence", props: {}, slots: { body: steps } },
  };
}

export async function startRecording(
  url: string,
  options: { headless?: boolean; name?: string; executablePath?: string; onEvent?: (e: RecordedEvent) => void } = {},
): Promise<Recording> {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    throw new Error("The recorder needs Playwright: pnpm --filter @zamtest/agent exec playwright install chromium");
  }
  const browser: Browser = await pw.chromium.launch({
    headless: options.headless ?? false,
    executablePath: options.executablePath ?? (process.env.ZAMTEST_BROWSER_EXECUTABLE || undefined),
  });
  const context = await browser.newContext({ viewport: null });
  const events: RecordedEvent[] = [];
  await context.exposeBinding("__zamtechRecord", (_source, event: RecordedEvent) => {
    events.push(event);
    options.onEvent?.(event);
  });
  await context.addInitScript(PAGE_SCRIPT);
  const page = await context.newPage();
  await page.goto(url);
  let stopped = false;
  return {
    page,
    events,
    async stop() {
      if (!stopped) {
        stopped = true;
        await page.waitForTimeout(150).catch(() => undefined); // let the last events arrive
        await browser.close().catch(() => undefined);
      }
      return eventsToWorkflow(url, events, options.name);
    },
  };
}
