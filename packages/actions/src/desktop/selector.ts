/**
 * Desktop selectors address elements of Windows applications through
 * Microsoft UI Automation. They read like CSS:
 *
 *   window[process="notepad"] > menuitem[name="File"]
 *   window[name$=" - Notepad"] > document
 *   window[name="Calculator"] > button[id="num7Button"]
 *   window[process="saplogon"] > edit[name="User"][index=2]
 *
 * - Segments are separated by `>` and each one is searched among all
 *   descendants of the previous match. The first segment is matched against
 *   top-level windows.
 * - A segment starts with a UI Automation control type (window, button,
 *   edit, document, menuitem, listitem, combobox, datagrid, ...) or `*`.
 * - Attributes: name, id (AutomationId), class (ClassName), process (the
 *   process name, top-level segment only) and index (1-based, picks the
 *   n-th match).
 * - Operators: `=` exact, `~=` contains, `^=` starts with, `$=` ends with.
 *   Matching is case-insensitive.
 */

export type Operator = "=" | "~=" | "^=" | "$=";
export type Attribute = "name" | "id" | "class" | "process";

export interface Condition {
  attr: Attribute;
  op: Operator;
  value: string;
}

export interface Segment {
  /** Lower-case UI Automation control type name, or "*" for any. */
  type: string;
  conditions: Condition[];
  /** 1-based index among matches. */
  index?: number;
}

export const CONTROL_TYPES = [
  "window", "pane", "button", "edit", "document", "text", "checkbox", "radiobutton", "combobox", "list", "listitem",
  "menu", "menubar", "menuitem", "tab", "tabitem", "tree", "treeitem", "datagrid", "dataitem", "table", "header",
  "headeritem", "hyperlink", "image", "group", "toolbar", "statusbar", "titlebar", "scrollbar", "slider", "spinner",
  "splitbutton", "progressbar", "calendar", "tooltip", "custom", "separator", "thumb", "appbar", "semanticzoom",
] as const;

const ATTRIBUTES = new Set<Attribute>(["name", "id", "class", "process"]);

export class SelectorError extends Error {
  constructor(selector: string, reason: string) {
    super(`Invalid desktop selector "${selector}": ${reason}`);
    this.name = "SelectorError";
  }
}

export function parseSelector(selector: string): Segment[] {
  const src = selector.trim();
  if (!src) throw new SelectorError(selector, "it is empty");
  const segments: Segment[] = [];
  let i = 0;
  const skipSpace = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };

  while (i < src.length) {
    skipSpace();
    const typeMatch = /^(\*|[a-zA-Z]+)/.exec(src.slice(i));
    const type = typeMatch ? typeMatch[1]!.toLowerCase() : "*";
    if (typeMatch) i += typeMatch[1]!.length;
    if (type !== "*" && !(CONTROL_TYPES as readonly string[]).includes(type)) {
      throw new SelectorError(selector, `unknown control type "${type}"`);
    }
    const segment: Segment = { type, conditions: [] };
    while (src[i] === "[") {
      const close = findClose(src, i);
      if (close < 0) throw new SelectorError(selector, "missing ]");
      const body = src.slice(i + 1, close).trim();
      const m = /^([a-zA-Z]+)\s*(=|~=|\^=|\$=)\s*(.+)$/.exec(body);
      if (!m) throw new SelectorError(selector, `cannot read [${body}]`);
      const attr = m[1]!.toLowerCase();
      const op = m[2] as Operator;
      const raw = m[3]!.trim();
      if (attr === "index") {
        const n = Number(raw.replace(/^"|"$/g, ""));
        if (!Number.isInteger(n) || n < 1 || op !== "=") throw new SelectorError(selector, "index must be a positive number, e.g. [index=2]");
        segment.index = n;
      } else {
        if (!ATTRIBUTES.has(attr as Attribute)) throw new SelectorError(selector, `unknown attribute "${attr}" (use name, id, class, process or index)`);
        if (attr === "process" && segments.length > 0) throw new SelectorError(selector, "process can only be used on the first segment");
        segment.conditions.push({ attr: attr as Attribute, op, value: unquote(raw, selector) });
      }
      i = close + 1;
    }
    if (segment.type === "*" && segment.conditions.length === 0 && segment.index === undefined) {
      throw new SelectorError(selector, "each segment needs a control type or an attribute");
    }
    segments.push(segment);
    skipSpace();
    if (i < src.length) {
      if (src[i] !== ">") throw new SelectorError(selector, `unexpected "${src[i]}"`);
      i++;
    }
  }
  return segments;
}

function findClose(src: string, open: number): number {
  let inQuote = false;
  for (let i = open + 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && inQuote) {
      i++;
      continue;
    }
    if (c === '"') inQuote = !inQuote;
    else if (c === "]" && !inQuote) return i;
  }
  return -1;
}

function unquote(raw: string, selector: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) throw new SelectorError(selector, `unterminated quote in ${raw}`);
  return raw.slice(1, -1).replace(/\\(.)/g, "$1");
}

const quote = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function formatSelector(segments: Segment[]): string {
  return segments
    .map((s) => s.type + s.conditions.map((c) => `[${c.attr}${c.op}${quote(c.value)}]`).join("") + (s.index ? `[index=${s.index}]` : ""))
    .join(" > ");
}

/* ------------------------------------------------------------------ */
/* Selector generation for the recorder                                */
/* ------------------------------------------------------------------ */

/** One element as reported by UI Automation (target last, top-level window first). */
export interface ElementInfo {
  type: string;
  name?: string;
  id?: string;
  class?: string;
  process?: string;
  isPassword?: boolean;
}

/** AutomationIds that are generated at run time and change between sessions. */
function stableId(id?: string): id is string {
  if (!id || id.length >= 80) return false;
  if (/^\d+$/.test(id) || /[0-9a-f]{8}-[0-9a-f]{4}/i.test(id)) return false;
  // Counters handed out per session, e.g. Chromium's "view_20" or "item_1734".
  return !/^[a-z]+_\d+$/i.test(id) && !/\d{4,}$/.test(id);
}

function stableName(name?: string): name is string {
  return Boolean(name) && name!.length <= 80 && !/\r|\n/.test(name!);
}

function windowSegment(win: ElementInfo): Segment {
  const conditions: Condition[] = [];
  if (win.process) conditions.push({ attr: "process", op: "=", value: win.process.toLowerCase() });
  // Titles often start with the document name ("report.txt - Notepad"); keep the stable app part.
  if (win.name) {
    const dash = win.name.lastIndexOf(" - ");
    if (dash > 0) conditions.push({ attr: "name", op: "$=", value: win.name.slice(dash) });
    else if (!win.process && stableName(win.name)) conditions.push({ attr: "name", op: "=", value: win.name });
  }
  if (conditions.length === 0 && win.class) conditions.push({ attr: "class", op: "=", value: win.class });
  return { type: "window", conditions };
}

/** Classic Win32 controls: their numeric AutomationId is the dialog control ID, which is fixed in the program. */
const WIN32_CLASS = /^(Edit|Button|ComboBox|ComboBoxEx32|ListBox|SysListView32|SysTreeView32|Static|SysTabControl32|ToolbarWindow32|msctls_\w+|RichEdit\w*)$/i;

function usableId(el: ElementInfo): el is ElementInfo & { id: string } {
  if (stableId(el.id)) return true;
  return Boolean(el.id) && /^\d{1,6}$/.test(el.id!) && WIN32_CLASS.test(el.class ?? "");
}

function targetSegment(el: ElementInfo): Segment {
  const type = (CONTROL_TYPES as readonly string[]).includes(el.type) ? el.type : "*";
  if (usableId(el)) return { type, conditions: [{ attr: "id", op: "=", value: el.id }] };
  if (stableName(el.name)) return { type, conditions: [{ attr: "name", op: "=", value: el.name }] };
  if (el.class) return { type, conditions: [{ attr: "class", op: "=", value: el.class }] };
  return { type, conditions: [] };
}

/** Builds a selector from an element's ancestor chain [topWindow, ..., target]. */
export function selectorFromChain(chain: ElementInfo[]): string {
  if (chain.length === 0) throw new Error("Empty element chain");
  const [win, ...rest] = chain;
  const segments = [windowSegment(win!)];
  const target = rest.at(-1);
  if (target) {
    const t = targetSegment(target);
    // A target without id or name is ambiguous; anchor it on the closest ancestor that has an id.
    if (!t.conditions.some((c) => c.attr === "id" || c.attr === "name")) {
      const anchor = [...rest.slice(0, -1)].reverse().find((a) => usableId(a));
      if (anchor) segments.push(targetSegment(anchor));
    }
    if (t.type === "*" && t.conditions.length === 0) t.type = "custom";
    segments.push(t);
  }
  return formatSelector(segments);
}

const KIND: Record<string, string> = {
  button: "button", edit: "field", document: "text area", menuitem: "menu item", checkbox: "checkbox", radiobutton: "option",
  combobox: "dropdown", listitem: "list item", treeitem: "tree item", tabitem: "tab", hyperlink: "link", datagrid: "table",
};

/** Plain-language description used by AI self-healing, e.g. `The "Save" button in Notepad`. */
export function describeChain(chain: ElementInfo[]): string {
  const win = chain[0];
  const target = chain.at(-1)!;
  const app = win?.name ? (win.name.lastIndexOf(" - ") > 0 ? win.name.slice(win.name.lastIndexOf(" - ") + 3) : win.name) : win?.process;
  const kind = KIND[target.type] ?? target.type;
  const label = target.name && stableName(target.name) ? `"${target.name}" ` : "";
  return `The ${label}${kind}${app && target !== win ? ` in ${app}` : ""}`;
}
