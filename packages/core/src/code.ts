/**
 * The code view: a workflow as short, readable code, and back.
 *
 *   input("user", "string", "anna@example.com")   // The user to sign in as
 *
 *   browser.open("https://shop.example.com/login")  // Open the login page
 *   browser.type("#email", user)
 *   // @step { continueOnError: true }
 *   browser.click("button[type=submit]")
 *   if (rows.length > 0) {
 *     saved = saved + 1
 *   }
 *
 * The code is never run: it is read (with acorn) into the same steps the canvas
 * shows. Only what maps onto steps is allowed: actions (`browser.click(...)`,
 * core actions without "core.": `log(...)`), `x = expression` (Assign), `x = action(...)`
 * (the action's result into x), if / else, for...of, while, try / catch / finally,
 * `{ }` (a Sequence), break and `throw new Error(...)`. A comment at the end of a
 * step's line is its label; a comment on a line of its own is a Comment step;
 * `// @step { ... }` just above a step holds its settings (continueOnError,
 * retry, timeoutMs, disabled) and any other properties of a control step.
 *
 * An action's required properties are written in order, the others in an object
 * at the end: `browser.type("#email", user, { pressEnter: true })`. A value that
 * is not a plain literal becomes a template: `user` is `"{{ user }}"`.
 */
import { parse, parseExpressionAt } from "acorn";
import type * as ES from "acorn";
import { BUILTIN_ACTIONS } from "./catalog.js";
import { newStepId, safeParseWorkflow } from "./schema.js";
import type { ActionMeta, PropDef, Step, VariableDef, Workflow } from "./schema.js";

const INDENT = "  ";
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const WHOLE_TEMPLATE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
/** Declares a variable: `input("who", "string", "world")`. */
const VARIABLE_CALLS: Record<string, VariableDef["direction"]> = { variable: "local", input: "in", output: "out", inout: "inout" };
const DIRECTION_CALL: Record<VariableDef["direction"], string> = { local: "variable", in: "input", out: "output", inout: "inout" };
/** Step fields kept in `// @step { ... }`. */
const SETTINGS = ["disabled", "continueOnError", "retry", "timeoutMs"] as const;
const JS_WORDS = new Set(
  "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static enum await implements package protected interface private public undefined".split(" "),
);

export interface CodeDiagnostic {
  /** Offsets in the code. */
  from: number;
  to: number;
  /** 1-based. */
  line: number;
  message: string;
  severity: "error" | "warning";
}

export interface CodeResult {
  /** The workflow with the code's variables and steps; unset when there are errors. */
  workflow?: Workflow;
  diagnostics: CodeDiagnostic[];
}

/* ================================================================== */
/* Workflow -> code                                                    */
/* ================================================================== */

const isExpression = (source: string): boolean => {
  const text = source.trim();
  if (!text) return false;
  try {
    const node = parseExpressionAt(text, 0, { ecmaVersion: "latest" });
    return node.end === text.length;
  } catch {
    return false;
  }
};

const keyCode = (key: string) => (IDENTIFIER.test(key) && !JS_WORDS.has(key) ? key : JSON.stringify(key));

/** A string as code: a template literal when it has line breaks. */
const stringCode = (s: string) => (s.includes("\n") && !/[`\\]|\$\{/.test(s) ? `\`${s}\`` : JSON.stringify(s));

/** A plain value (from JSON) as code. */
export function literalCode(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return stringCode(value);
  if (Array.isArray(value)) return `[${value.map(literalCode).join(", ")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return entries.length ? `{ ${entries.map(([k, v]) => `${keyCode(k)}: ${literalCode(v)}`).join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

/** A property's value as code: expressions and whole templates as they are. */
function valueCode(value: unknown, def?: PropDef): string {
  if (def?.type === "expression") {
    if (typeof value !== "string") return literalCode(value);
    return isExpression(value) ? value.trim() : `expr(${JSON.stringify(value)})`;
  }
  if (def?.type !== "variable" && typeof value === "string") {
    const whole = WHOLE_TEMPLATE.exec(value);
    // As the engine reads it: one template, and nothing else, keeps its value.
    if (whole && !whole[1]!.includes("}}") && isExpression(whole[1]!)) return whole[1]!.trim();
  }
  return literalCode(value);
}

const labelSuffix = (step: Step) => (step.label ? ` // ${step.label.replace(/\s*\n\s*/g, " ")}` : "");

/** The workflow as code. */
export function workflowToCode(workflow: Workflow, catalog: ActionMeta[] = BUILTIN_ACTIONS): string {
  const metas = new Map(catalog.map((m) => [m.type, m]));
  const lines: string[] = [];

  for (const v of workflow.variables) {
    const args = [JSON.stringify(v.name)];
    if (v.type !== "any" || v.default !== undefined) args.push(JSON.stringify(v.type));
    if (v.default !== undefined) args.push(literalCode(v.default));
    lines.push(`${DIRECTION_CALL[v.direction]}(${args.join(", ")})${v.description ? ` // ${v.description.replace(/\s*\n\s*/g, " ")}` : ""}`);
  }
  if (workflow.variables.length) lines.push("");

  const emitSteps = (steps: Step[] | undefined, indent: string, inLoop: boolean) => {
    let lastWasComment = false;
    for (const step of steps ?? []) {
      const comment = isCommentStep(step);
      if (comment && lastWasComment) lines.push("");
      emitStep(step, indent, inLoop);
      lastWasComment = comment;
    }
  };

  const emitStep = (step: Step, indent: string, inLoop: boolean) => {
    const meta = metas.get(step.type);
    const defs = new Map((meta?.props ?? []).map((p) => [p.name, p]));
    const settings: Record<string, unknown> = {};
    for (const key of SETTINGS) if (step[key] !== undefined) settings[key] = step[key];
    const props = { ...step.props };
    const suffix = labelSuffix(step);
    /** Properties the statement form does not show go to @step. */
    const rest = (shown: string[], defaults: Record<string, unknown> = {}) => {
      for (const [k, v] of Object.entries(props)) {
        if (shown.includes(k) || v === undefined) continue;
        if (k in defaults && JSON.stringify(defaults[k]) === JSON.stringify(v)) continue;
        settings[k] = v;
      }
    };
    const block = (body: Step[] | undefined, loop: boolean) => emitSteps(body, indent + INDENT, loop);
    const cond = (value: unknown) => valueCode(value ?? "", { name: "condition", label: "", type: "expression" });
    const open: string[] = [];
    const flush = () => {
      if (Object.keys(settings).length) lines.push(`${indent}// @step ${literalCode(settings)}`);
      lines.push(...open);
    };

    switch (step.type) {
      case "core.sequence":
        rest([]);
        open.push(`${indent}{${suffix}`);
        flush();
        block(step.slots?.body, inLoop);
        lines.push(`${indent}}`);
        return;
      case "core.if": {
        rest(["condition"]);
        open.push(`${indent}if (${cond(props.condition)}) {${suffix}`);
        flush();
        block(step.slots?.then, inLoop);
        let otherwise = step.slots?.else ?? [];
        // else if: an Else that is only an If without a label or settings.
        while (otherwise.length === 1 && otherwise[0]!.type === "core.if" && !otherwise[0]!.label && !hasSettings(otherwise[0]!, ["condition"])) {
          const inner = otherwise[0]!;
          lines.push(`${indent}} else if (${cond(inner.props.condition)}) {`);
          block(inner.slots?.then, inLoop);
          otherwise = inner.slots?.else ?? [];
        }
        if (otherwise.length) {
          lines.push(`${indent}} else {`);
          block(otherwise, inLoop);
        }
        lines.push(`${indent}}`);
        return;
      }
      case "core.forEach": {
        rest(["items", "itemVariable", "indexVariable"]);
        const item = typeof props.itemVariable === "string" && IDENTIFIER.test(props.itemVariable) ? props.itemVariable : "item";
        const items = cond(props.items);
        const index = typeof props.indexVariable === "string" && IDENTIFIER.test(props.indexVariable) ? props.indexVariable : undefined;
        open.push(index ? `${indent}for (const [${index}, ${item}] of (${items}).entries()) {${suffix}` : `${indent}for (const ${item} of ${items}) {${suffix}`);
        flush();
        block(step.slots?.body, true);
        lines.push(`${indent}}`);
        return;
      }
      case "core.while":
        rest(["condition"], { maxIterations: 1000 });
        open.push(`${indent}while (${cond(props.condition)}) {${suffix}`);
        flush();
        block(step.slots?.body, true);
        lines.push(`${indent}}`);
        return;
      case "core.tryCatch": {
        rest(["errorVariable"]);
        const error = typeof props.errorVariable === "string" && IDENTIFIER.test(props.errorVariable) ? props.errorVariable : "error";
        open.push(`${indent}try {${suffix}`);
        flush();
        block(step.slots?.try, inLoop);
        lines.push(`${indent}} catch (${error}) {`);
        block(step.slots?.catch, inLoop);
        if (step.slots?.finally?.length) {
          lines.push(`${indent}} finally {`);
          block(step.slots.finally, inLoop);
        }
        lines.push(`${indent}}`);
        return;
      }
      case "core.break":
        if (inLoop) {
          rest([]);
          open.push(`${indent}break${suffix}`);
          flush();
          return;
        }
        break;
      case "core.throw":
        if (Object.keys(props).every((k) => k === "message")) {
          open.push(`${indent}throw new Error(${valueCode(props.message ?? "", defs.get("message"))})${suffix}`);
          flush();
          return;
        }
        break;
      case "core.assign":
        if (
          typeof props.variable === "string" &&
          IDENTIFIER.test(props.variable) &&
          typeof props.value === "string" &&
          isExpression(props.value) &&
          !callsAction(props.value) &&
          Object.keys(props).length === 2
        ) {
          open.push(`${indent}${props.variable} = ${props.value.trim()}${suffix}`);
          flush();
          return;
        }
        break;
      case "core.comment":
        if (isCommentStep(step)) {
          const text = String(props.text ?? "");
          for (const line of text.split("\n")) lines.push(`${indent}//${line ? ` ${line}` : ""}`);
          return;
        }
        break;
    }

    // An action.
    const short = step.type.slice("core.".length);
    const callee = step.type.startsWith("core.") && !JS_WORDS.has(short) && !(short in VARIABLE_CALLS) && short !== "expr" ? short : step.type;
    const outputDef = meta?.props.find((p) => p.output);
    const outputName = outputDef ? props[outputDef.name] : undefined;
    const assignTo = typeof outputName === "string" && IDENTIFIER.test(outputName) && !JS_WORDS.has(outputName) ? outputName : undefined;
    if (assignTo) delete props[outputDef!.name];
    const required = (meta?.props ?? []).filter((p) => p.required && !p.output);
    let last = -1;
    required.forEach((p, i) => {
      if (props[p.name] !== undefined) last = i;
    });
    // The others go in an object after every required place (undefined where one is missing),
    // or alone when no required one is set.
    const hasOthers = Object.keys(props).some((k) => props[k] !== undefined && !required.some((p) => p.name === k && props[k] !== undefined && required.indexOf(p) <= last));
    if (hasOthers && (last >= 0 || required[0]?.type === "json")) last = required.length - 1;
    const args: string[] = [];
    for (let i = 0; i <= last; i++) {
      const p = required[i]!;
      args.push(props[p.name] === undefined ? "undefined" : valueCode(props[p.name], p));
      delete props[p.name];
    }
    // The others, in the catalog's order, then any the catalog does not know.
    const order = [...(meta?.props ?? []).map((p) => p.name), ...Object.keys(props)];
    const others = [...new Set(order)].filter((k) => props[k] !== undefined);
    if (others.length) args.push(`{ ${others.map((k) => `${keyCode(k)}: ${valueCode(props[k], defs.get(k))}`).join(", ")} }`);
    open.push(`${indent}${assignTo ? `${assignTo} = ` : ""}${callee}(${args.join(", ")})${suffix}`);
    flush();
  };

  /** A value that reads like an action call (x = log(...) would be read as the action's result). */
  const callsAction = (value: string) => {
    const name = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(value)?.[1];
    return Boolean(name && (metas.has(name) || metas.has(`core.${name}`)));
  };

  const body = workflow.root.type === "core.sequence" ? workflow.root.slots?.body : [workflow.root];
  emitSteps(body, "", false);
  return `${lines.join("\n")}\n`;
}

/** A Comment step written as `// text` lines. */
function isCommentStep(step: Step): boolean {
  return step.type === "core.comment" && !step.label && !hasSettings(step, ["text"]) && typeof (step.props.text ?? "") === "string";
}

function hasSettings(step: Step, shown: string[]): boolean {
  return SETTINGS.some((k) => step[k] !== undefined) || Object.keys(step.props).some((k) => !shown.includes(k) && step.props[k] !== undefined);
}

/* ================================================================== */
/* Code -> workflow                                                    */
/* ================================================================== */

class CodeError extends Error {
  constructor(
    message: string,
    public readonly from: number,
    public readonly to: number,
  ) {
    super(message);
  }
}

interface Comment {
  text: string;
  block: boolean;
  start: number;
  end: number;
  line: number;
  endLine: number;
  used?: boolean;
}

/**
 * Reads code into the workflow's variables and steps. `base` gives everything else
 * (id, name...) and the ids of steps that are still there, so their run results,
 * screenshots and history stay with them.
 */
export function codeToWorkflow(code: string, base: Workflow, catalog: ActionMeta[] = BUILTIN_ACTIONS): CodeResult {
  const metas = new Map(catalog.map((m) => [m.type, m]));
  const diagnostics: CodeDiagnostic[] = [];
  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const report = (message: string, from: number, to: number, severity: CodeDiagnostic["severity"] = "error") =>
    diagnostics.push({ from, to: Math.max(to, from), line: lineOf(from), message, severity });

  const comments: Comment[] = [];
  let program: ES.Program;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      onComment: (block, text, start, end) => comments.push({ text, block, start, end, line: lineOf(start), endLine: lineOf(end) }),
    });
  } catch (err) {
    const e = err as SyntaxError & { pos?: number; raisedAt?: number };
    const pos = e.pos ?? 0;
    report(friendlySyntax(e.message.replace(/\s*\(\d+:\d+\)$/, "")), pos, Math.max(e.raisedAt ?? pos, pos + 1));
    return { diagnostics };
  }

  const src = (node: ES.Node) => code.slice(node.start, node.end);

  /* ---------------------------- comments ---------------------------- */
  // Labels (at the end of a step's first line) and @step settings (on the line just above).
  const byStatement = new Map<ES.Node, { label?: string; settings?: Comment }>();
  const statementsOf = (node: ES.Node): ES.Statement[] => {
    switch (node.type) {
      case "Program":
        return (node as ES.Program).body as ES.Statement[];
      case "BlockStatement":
        return (node as ES.BlockStatement).body;
      default:
        return [];
    }
  };
  const isBlockish = (s: ES.Node) => ["IfStatement", "ForOfStatement", "WhileStatement", "TryStatement", "BlockStatement"].includes(s.type);
  const attach = (s: ES.Node) => {
    const startLine = lineOf(s.start);
    const endLine = lineOf(s.end);
    const info: { label?: string; settings?: Comment } = {};
    const label = isBlockish(s)
      ? comments.find((c) => !c.used && !c.block && c.line === startLine && c.start > s.start && c.start < s.end && !c.text.trim().startsWith("@step"))
      : comments.find((c) => !c.used && !c.block && c.line === endLine && c.start >= s.end && !c.text.trim().startsWith("@step"));
    if (label) {
      label.used = true;
      info.label = label.text.trim() || undefined;
    }
    const settings = comments.find((c) => !c.used && !c.block && c.line === startLine - 1 && c.text.trim().startsWith("@step"));
    if (settings) {
      settings.used = true;
      info.settings = settings;
    }
    byStatement.set(s, info);
  };
  const walk = (node: ES.Node) => {
    for (const s of statementsOf(node)) {
      attach(s);
      for (const child of childBlocks(s)) walk(child);
    }
  };
  walk(program);
  for (const c of comments) {
    if (!c.used && c.text.trim().startsWith("@step")) report("// @step must be on the line just above a step", c.start, c.end);
  }

  /* ----------------------------- values ----------------------------- */
  /** A literal's value; non-literals become "{{ source }}" templates. */
  const value = (node: ES.Node): unknown => {
    switch (node.type) {
      case "Literal": {
        const lit = node as ES.Literal;
        if (lit.regex) return `{{ ${src(node)} }}`;
        return lit.value;
      }
      case "TemplateLiteral": {
        const tpl = node as ES.TemplateLiteral;
        // `Hello ${name}` is the template "Hello {{ name }}".
        let out = "";
        tpl.quasis.forEach((q, i) => {
          out += q.value.cooked ?? q.value.raw;
          if (i < tpl.expressions.length) out += `{{ ${src(tpl.expressions[i]!)} }}`;
        });
        return out;
      }
      case "ArrayExpression":
        return (node as ES.ArrayExpression).elements.map((e) => {
          if (!e) throw new CodeError("Empty places in lists are not allowed", node.start, node.end);
          if (e.type === "SpreadElement") throw new CodeError("... is not allowed here", e.start, e.end);
          return value(e);
        });
      case "ObjectExpression":
        return objectValue(node as ES.ObjectExpression, (_k, v) => value(v));
      case "UnaryExpression": {
        const u = node as ES.UnaryExpression;
        if (u.operator === "-" && u.argument.type === "Literal" && typeof (u.argument as ES.Literal).value === "number") return -((u.argument as ES.Literal).value as number);
        break;
      }
      case "Identifier":
        if ((node as ES.Identifier).name === "undefined") return undefined;
        break;
    }
    return `{{ ${src(node)} }}`;
  };

  const objectValue = (node: ES.ObjectExpression, each: (key: string, value: ES.Expression, prop: ES.Property) => unknown) => {
    const out: Record<string, unknown> = {};
    for (const p of node.properties) {
      if (p.type !== "Property" || p.computed || p.kind !== "init" || p.method) throw new CodeError("Only plain `name: value` pairs are allowed here", p.start, p.end);
      const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined;
      if (key === undefined) throw new CodeError("Use a name or a text as key", p.key.start, p.key.end);
      const v = each(key, p.value as ES.Expression, p);
      if (v !== undefined) out[key] = v;
    }
    return out;
  };

  /** A property's value, as its type wants it. */
  const propValue = (node: ES.Node, def?: PropDef): unknown => {
    if (def?.type === "expression") {
      const raw = exprCall(node);
      return raw ?? src(node);
    }
    if (def?.type === "variable" && node.type === "Identifier") return (node as ES.Identifier).name;
    return value(node);
  };

  /** `expr("...")`: an expression kept as written. */
  const exprCall = (node: ES.Node): string | undefined => {
    if (node.type !== "CallExpression") return undefined;
    const call = node as ES.CallExpression;
    if (call.callee.type !== "Identifier" || call.callee.name !== "expr") return undefined;
    const arg = call.arguments[0];
    if (call.arguments.length !== 1 || !arg || arg.type !== "Literal" || typeof (arg as ES.Literal).value !== "string") {
      throw new CodeError('Write expr("...") with one text', node.start, node.end);
    }
    return (arg as ES.Literal).value as string;
  };

  const expression = (node: ES.Node) => exprCall(node) ?? src(node);

  /* ---------------------------- actions ----------------------------- */
  const calleeType = (callee: ES.Node): string | undefined => {
    if (callee.type === "Identifier") return `core.${(callee as ES.Identifier).name}`;
    const parts: string[] = [];
    let node: ES.Node = callee;
    while (node.type === "MemberExpression") {
      const m = node as ES.MemberExpression;
      if (m.computed || m.property.type !== "Identifier") return undefined;
      parts.unshift((m.property as ES.Identifier).name);
      node = m.object;
    }
    if (node.type !== "Identifier") return undefined;
    parts.unshift((node as ES.Identifier).name);
    return parts.join(".");
  };

  const actionStep = (call: ES.CallExpression, output?: string): Step => {
    const type = calleeType(call.callee);
    if (!type) throw new CodeError("Call an action by its name, e.g. browser.click(...)", call.callee.start, call.callee.end);
    const name = type.startsWith("core.") ? type.slice(5) : type;
    if (name in VARIABLE_CALLS) throw new CodeError(`Declare variables at the top, not inside steps`, call.start, call.end);
    const meta = metas.get(type);
    if (!meta) {
      const hint = closest(type, [...metas.keys()]);
      throw new CodeError(`Unknown action ${name}${hint ? ` (did you mean ${hint.startsWith("core.") ? hint.slice(5) : hint}?)` : ""}`, call.callee.start, call.callee.end);
    }
    const defs = new Map(meta.props.map((p) => [p.name, p]));
    const required = meta.props.filter((p) => p.required && !p.output);
    const props: Record<string, unknown> = {};
    const args = call.arguments;
    for (const a of args) if (a.type === "SpreadElement") throw new CodeError("... is not allowed here", a.start, a.end);
    // One object and no required property that takes objects: the properties by name.
    const named = (i: number) => {
      const node = args[i] as ES.ObjectExpression;
      Object.assign(
        props,
        objectValue(node, (key, v, p) => {
          const def = defs.get(key);
          if (!def) report(`${name} has no setting "${key}"${meta.props.length ? `; it has: ${meta.props.map((d) => d.name).join(", ")}` : ""}`, p.key.start, p.key.end, "warning");
          return propValue(v, def);
        }),
      );
    };
    const onlyNamed = args.length === 1 && args[0]!.type === "ObjectExpression" && (required.length === 0 || required[0]!.type !== "json");
    if (onlyNamed) named(0);
    else {
      if (args.length > required.length + 1) throw new CodeError(`${name} takes ${required.length ? `${required.map((p) => p.name).join(", ")}, then ` : ""}an object with its other settings`, args[required.length + 1]!.start, call.end);
      args.forEach((a, i) => {
        // An object last where a required text belongs: the other settings (the required one is missing).
        if (a.type === "ObjectExpression" && i === args.length - 1 && i < required.length && required[i]!.type !== "json") {
          report(`${name} needs ${required.slice(i).map((p) => p.name).join(", ")} before its other settings`, a.start, a.end, "warning");
          named(i);
        } else if (i < required.length) {
          const v = a.type === "Identifier" && (a as ES.Identifier).name === "undefined" ? undefined : propValue(a, required[i]);
          if (v !== undefined) props[required[i]!.name] = v;
        } else {
          if (a.type !== "ObjectExpression") throw new CodeError(`After ${required.map((p) => p.name).join(", ") || "nothing"}, ${name} takes an object with its other settings, e.g. { timeoutMs: 5000 }`, a.start, a.end);
          named(i);
        }
      });
    }
    if (output !== undefined) {
      const out = meta.props.find((p) => p.output);
      if (!out) throw new CodeError(`${name} gives no result to put in ${output}`, call.start, call.end);
      props[out.name] = output;
    }
    return { id: "", type, props };
  };

  /* --------------------------- statements --------------------------- */
  const steps = (container: ES.Node, body: ES.Statement[], inLoop: boolean): Step[] => {
    // Comments on lines of their own, between the statements, are Comment steps.
    const items: Array<{ start: number; step?: Step; comment?: Comment }> = [];
    for (const s of body) {
      const step = statement(s, inLoop);
      if (step) items.push({ start: s.start, step });
    }
    const inside = (c: Comment) => c.start >= container.start && (container.type === "Program" || c.end < container.end) && !body.some((s) => c.start >= s.start && c.end <= s.end);
    const free = comments.filter((c) => !c.used && inside(c));
    // Consecutive // lines make one comment.
    let group: Comment[] = [];
    const flushGroup = () => {
      if (!group.length) return;
      const text = group.map((c) => (c.block ? c.text.trim() : c.text.replace(/^ /, ""))).join("\n");
      items.push({ start: group[0]!.start, step: { id: "", type: "core.comment", props: { text } } });
      group = [];
    };
    for (const c of free) {
      c.used = true;
      const prev = group.at(-1);
      const between = prev ? code.slice(prev.end, c.start) : "";
      if (prev && (c.block || prev.block || c.line !== prev.endLine + 1 || between.trim())) flushGroup();
      group.push(c);
    }
    flushGroup();
    return items.sort((a, b) => a.start - b.start).map((i) => i.step!);
  };

  const blockOf = (node: ES.Statement, inLoop: boolean): Step[] =>
    node.type === "BlockStatement" ? steps(node, (node as ES.BlockStatement).body, inLoop) : [statement(node, inLoop)].filter((s): s is Step => Boolean(s));

  const statement = (s: ES.Statement, inLoop: boolean): Step | undefined => {
    try {
      const step = statementStep(s, inLoop);
      if (!step) return undefined;
      const info = byStatement.get(s);
      if (info?.label) step.label = info.label;
      if (info?.settings) applySettings(step, info.settings);
      return step;
    } catch (err) {
      if (err instanceof CodeError) report(err.message, err.from, err.to);
      else throw err;
      return undefined;
    }
  };

  const applySettings = (step: Step, c: Comment) => {
    const text = c.text.trim().slice("@step".length);
    const at = c.start + 2 + c.text.indexOf("@step") + "@step".length;
    let node: ES.Expression;
    try {
      node = parseExpressionAt(text, 0, { ecmaVersion: "latest" }) as ES.Expression;
    } catch {
      throw new CodeError("Write the settings as { name: value }, e.g. // @step { continueOnError: true }", c.start, c.end);
    }
    if (node.type !== "ObjectExpression") throw new CodeError("Write the settings as { name: value }", c.start, c.end);
    const values = objectValue(node as ES.ObjectExpression, (_k, v) => {
      // Settings are plain values; keep their text for errors.
      const inner = text.slice(v.start, v.end);
      try {
        return JSON.parse(JSON.stringify(literalOf(v, inner)));
      } catch {
        throw new CodeError(`Use a plain value here: ${inner}`, at + v.start, at + v.end);
      }
    });
    const meta = metas.get(step.type);
    for (const [k, v] of Object.entries(values)) {
      if ((SETTINGS as readonly string[]).includes(k)) (step as unknown as Record<string, unknown>)[k] = v;
      else {
        if (meta && !meta.props.some((p) => p.name === k)) report(`${step.type} has no setting "${k}"`, c.start, c.end, "warning");
        step.props[k] = v;
      }
    }
  };

  const statementStep = (s: ES.Statement, inLoop: boolean): Step | undefined => {
    switch (s.type) {
      case "EmptyStatement":
        return undefined;
      case "ExpressionStatement": {
        const e = (s as ES.ExpressionStatement).expression;
        if (e.type === "CallExpression") return actionStep(e as ES.CallExpression);
        if (e.type === "AssignmentExpression") {
          const a = e as ES.AssignmentExpression;
          if (a.left.type !== "Identifier") throw new CodeError("Assign to a variable by its name, e.g. total = total + 1", a.left.start, a.left.end);
          const variable = (a.left as ES.Identifier).name;
          if (a.operator === "=") {
            if (a.right.type === "CallExpression" && isAction(a.right as ES.CallExpression)) return actionStep(a.right as ES.CallExpression, variable);
            return { id: "", type: "core.assign", props: { variable, value: expression(a.right) } };
          }
          const op = a.operator.slice(0, -1);
          return { id: "", type: "core.assign", props: { variable, value: `${variable} ${op} (${src(a.right)})` } };
        }
        if (e.type === "UpdateExpression") {
          const u = e as ES.UpdateExpression;
          if (u.argument.type !== "Identifier") throw new CodeError("Use a variable's name, e.g. count++", u.start, u.end);
          const variable = (u.argument as ES.Identifier).name;
          return { id: "", type: "core.assign", props: { variable, value: `${variable} ${u.operator === "++" ? "+" : "-"} 1` } };
        }
        throw new CodeError("This line does nothing. Use an action, e.g. log(...), or assign it: x = ...", s.start, s.end);
      }
      case "IfStatement": {
        const i = s as ES.IfStatement;
        return {
          id: "",
          type: "core.if",
          props: { condition: expression(i.test) },
          slots: { then: blockOf(i.consequent, inLoop), else: i.alternate ? blockOf(i.alternate, inLoop) : [] },
        };
      }
      case "ForOfStatement": {
        const f = s as ES.ForOfStatement;
        if (f.await) throw new CodeError("for await is not supported", s.start, s.end);
        if (f.left.type !== "VariableDeclaration" || f.left.declarations.length !== 1) throw new CodeError("Write for (const item of items)", f.left.start, f.left.end);
        const id = f.left.declarations[0]!.id;
        const props: Record<string, unknown> = {};
        if (id.type === "Identifier") {
          props.items = expression(f.right);
          props.itemVariable = id.name;
        } else if (id.type === "ArrayPattern" && id.elements.length === 2 && id.elements.every((e) => e?.type === "Identifier")) {
          const r = f.right;
          const entries =
            r.type === "CallExpression" &&
            r.arguments.length === 0 &&
            r.callee.type === "MemberExpression" &&
            !r.callee.computed &&
            r.callee.property.type === "Identifier" &&
            r.callee.property.name === "entries";
          if (!entries) throw new CodeError("With a position, write for (const [i, item] of (items).entries())", r.start, r.end);
          props.items = expression(((r as ES.CallExpression).callee as ES.MemberExpression).object);
          props.itemVariable = (id.elements[1] as ES.Identifier).name;
          props.indexVariable = (id.elements[0] as ES.Identifier).name;
        } else throw new CodeError("Write for (const item of items), or for (const [i, item] of (items).entries())", id.start, id.end);
        return { id: "", type: "core.forEach", props, slots: { body: blockOf(f.body, true) } };
      }
      case "WhileStatement": {
        const w = s as ES.WhileStatement;
        return { id: "", type: "core.while", props: { condition: expression(w.test) }, slots: { body: blockOf(w.body, true) } };
      }
      case "TryStatement": {
        const t = s as ES.TryStatement;
        const param = t.handler?.param;
        if (param && param.type !== "Identifier") throw new CodeError("Write catch (error)", param.start, param.end);
        return {
          id: "",
          type: "core.tryCatch",
          props: { errorVariable: param ? (param as ES.Identifier).name : "error" },
          slots: { try: blockOf(t.block, inLoop), catch: t.handler ? blockOf(t.handler.body, inLoop) : [], finally: t.finalizer ? blockOf(t.finalizer, inLoop) : [] },
        };
      }
      case "BlockStatement":
        return { id: "", type: "core.sequence", props: {}, slots: { body: steps(s, (s as ES.BlockStatement).body, inLoop) } };
      case "BreakStatement":
        if ((s as ES.BreakStatement).label) throw new CodeError("break with a label is not supported", s.start, s.end);
        return { id: "", type: "core.break", props: {} };
      case "ThrowStatement": {
        const arg = (s as ES.ThrowStatement).argument;
        const message =
          arg.type === "NewExpression" && arg.callee.type === "Identifier" && arg.callee.name === "Error" && arg.arguments.length === 1 ? arg.arguments[0]! : arg;
        return { id: "", type: "core.throw", props: { message: value(message) } };
      }
      case "VariableDeclaration":
        throw new CodeError('Declare variables at the top with variable("name", "type", value), or input(...) / output(...) for arguments', s.start, s.end);
      default:
        throw new CodeError(`${statementName(s.type)} is not supported in the code view. For your own code, use a Run JavaScript step: runScript(\`...\`)`, s.start, s.end);
    }
  };

  const isAction = (call: ES.CallExpression) => {
    const type = calleeType(call.callee);
    return Boolean(type && metas.has(type));
  };

  /* ---------------------------- top level --------------------------- */
  const variables: VariableDef[] = [];
  const body: ES.Statement[] = [];
  for (const s of program.body as ES.Statement[]) {
    const call = s.type === "ExpressionStatement" && (s as ES.ExpressionStatement).expression.type === "CallExpression" ? ((s as ES.ExpressionStatement).expression as ES.CallExpression) : undefined;
    const fn = call?.callee.type === "Identifier" ? (call.callee as ES.Identifier).name : undefined;
    if (!call || !fn || !(fn in VARIABLE_CALLS)) {
      body.push(s);
      continue;
    }
    try {
      const [nameNode, typeNode, defaultNode] = call.arguments;
      if (!nameNode || nameNode.type !== "Literal" || typeof (nameNode as ES.Literal).value !== "string") throw new CodeError(`Write ${fn}("name", "type", value)`, call.start, call.end);
      const name = (nameNode as ES.Literal).value as string;
      if (!IDENTIFIER.test(name)) throw new CodeError(`"${name}" cannot be a variable name: use letters, digits and _, not starting with a digit`, nameNode.start, nameNode.end);
      if (variables.some((v) => v.name === name)) throw new CodeError(`${name} is declared twice`, nameNode.start, nameNode.end);
      const type = typeNode ? (typeNode.type === "Literal" ? (typeNode as ES.Literal).value : undefined) : "any";
      if (!["string", "number", "boolean", "object", "array", "any"].includes(String(type))) {
        throw new CodeError("The type is one of string, number, boolean, object, array or any", typeNode!.start, typeNode!.end);
      }
      const v: VariableDef = { name, type: type as VariableDef["type"], direction: VARIABLE_CALLS[fn]! };
      if (defaultNode) v.default = literalOf(defaultNode as ES.Expression, src(defaultNode));
      const description = byStatement.get(s)?.label;
      if (description) v.description = description;
      variables.push(v);
    } catch (err) {
      if (err instanceof CodeError) report(err.message, err.from, err.to);
      else report((err as Error).message, call.start, call.end);
    }
  }
  const rootSteps = steps(program, body, false);
  if (diagnostics.some((d) => d.severity === "error")) return { diagnostics };

  const root: Step = { ...base.root, props: { ...base.root.props }, slots: { ...base.root.slots, body: rootSteps } };
  if (base.root.type !== "core.sequence") Object.assign(root, { type: "core.sequence", props: {}, slots: { body: rootSteps } });
  keepIds(root, base.root);
  const parsed = safeParseWorkflow({ ...base, variables, root });
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 5)) report(`${issue.path.join(".")}: ${issue.message}`, 0, 0);
    return { diagnostics };
  }
  return { workflow: parsed.data, diagnostics };
}

/** A plain value written in code (settings, variable defaults). */
function literalOf(node: ES.Expression, source: string): unknown {
  switch (node.type) {
    case "Literal":
      if ((node as ES.Literal).regex) break;
      return (node as ES.Literal).value;
    case "TemplateLiteral":
      if ((node as ES.TemplateLiteral).expressions.length) break;
      return (node as ES.TemplateLiteral).quasis.map((q) => q.value.cooked ?? q.value.raw).join("");
    case "ArrayExpression":
      return (node as ES.ArrayExpression).elements.map((e) => {
        if (!e || e.type === "SpreadElement") throw new CodeError("Use plain values", node.start, node.end);
        return literalOf(e, source);
      });
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const p of (node as ES.ObjectExpression).properties) {
        if (p.type !== "Property" || p.computed || p.kind !== "init") throw new CodeError("Use plain values", p.start, p.end);
        const key = p.key.type === "Identifier" ? p.key.name : String((p.key as ES.Literal).value);
        out[key] = literalOf(p.value as ES.Expression, source);
      }
      return out;
    }
    case "UnaryExpression": {
      const u = node as ES.UnaryExpression;
      if (u.operator === "-" && u.argument.type === "Literal" && typeof (u.argument as ES.Literal).value === "number") return -((u.argument as ES.Literal).value as number);
      break;
    }
  }
  throw new CodeError(`Use a plain value (text, number, true/false, list or object): ${source}`, node.start, node.end);
}

/** The blocks inside a statement (for finding comments). */
function childBlocks(s: ES.Node): ES.Node[] {
  switch (s.type) {
    case "BlockStatement":
      return [s];
    case "IfStatement": {
      const i = s as ES.IfStatement;
      return [i.consequent, ...(i.alternate ? [i.alternate] : [])].flatMap((b) => (b.type === "BlockStatement" ? [b] : childBlocks(b)));
    }
    case "ForOfStatement":
    case "WhileStatement": {
      const b = (s as ES.ForOfStatement | ES.WhileStatement).body;
      return b.type === "BlockStatement" ? [b] : childBlocks(b);
    }
    case "TryStatement": {
      const t = s as ES.TryStatement;
      return [t.block, ...(t.handler ? [t.handler.body] : []), ...(t.finalizer ? [t.finalizer] : [])];
    }
    default:
      return [];
  }
}

/** Steps that are still there keep their ids: the same step, or else the next of its type. */
function keepIds(root: Step, old: Step): void {
  const previous: Step[] = [];
  const collect = (s: Step) => {
    for (const children of Object.values(s.slots ?? {})) for (const c of children) {
      previous.push(c);
      collect(c);
    }
  };
  collect(old);
  const used = new Set<Step>();
  const fresh: Step[] = [];
  const all = (s: Step, visit: (s: Step) => void) => {
    for (const children of Object.values(s.slots ?? {})) for (const c of children) {
      visit(c);
      all(c, visit);
    }
  };
  const same = (a: Step, b: Step) => a.type === b.type && a.label === b.label && stable(a.props) === stable(b.props);
  all(root, (s) => {
    const match = previous.find((p) => !used.has(p) && same(p, s));
    if (match) {
      used.add(match);
      s.id = match.id;
    } else fresh.push(s);
  });
  for (const s of fresh) {
    const match = previous.find((p) => !used.has(p) && p.type === s.type);
    if (match) used.add(match);
    s.id = match?.id ?? newStepId();
  }
}

/** JSON with sorted keys, to compare values whatever their keys' order. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const STATEMENT_NAMES: Record<string, string> = {
  ForStatement: "A for (;;) loop",
  ForInStatement: "for...in",
  DoWhileStatement: "do...while",
  FunctionDeclaration: "A function",
  ClassDeclaration: "A class",
  ReturnStatement: "return",
  SwitchStatement: "switch",
  LabeledStatement: "A label",
  ContinueStatement: "continue",
};
const statementName = (type: string) => STATEMENT_NAMES[type] ?? type;

function friendlySyntax(message: string): string {
  if (/Unsyntactic break/.test(message)) return "break only works inside a loop (for or while)";
  return message;
}

/** The known name closest to a mistyped one, if it is close. */
function closest(word: string, words: string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(word.length / 4)) + 1;
  for (const w of words) {
    const d = distance(word.toLowerCase(), w.toLowerCase());
    if (d < bestDistance) {
      best = w;
      bestDistance = d;
    }
  }
  return best;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
