import { autocompletion, snippetCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { tags } from "@lezer/highlight";
import { codeToWorkflow, workflowToCode, workflowToPlaywright } from "@zamtest/core";
import type { ActionMeta, PropDef, Workflow } from "@zamtest/core";
import { useI18n } from "@zamtest/i18n/react";
import { basicSetup } from "codemirror";
import { useEffect, useRef, useState } from "react";
import { saveText } from "../files";

/** How long after the last key the code is read into steps. */
const READ_AFTER_MS = 400;

/** Marks the code the view writes itself, so it is not read back as an edit. */
const fromOutside = Annotation.define<boolean>();

/** What the code view compares to know a change came from itself. */
const stepsKey = (w: Workflow) => JSON.stringify({ root: w.root, variables: w.variables });

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--surface)", color: "var(--text)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--text)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": { backgroundColor: "var(--surface-2)", color: "var(--muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
  ".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: "8px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--text)" },
  ".cm-completionDetail": { color: "var(--muted)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-completionInfo": { maxWidth: "340px" },
  ".cm-diagnostic": { color: "var(--text)" },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--ok)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warn)" },
  { tag: tags.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: [tags.propertyName, tags.function(tags.propertyName)], color: "var(--info)" },
  { tag: tags.function(tags.variableName), color: "var(--info)" },
  { tag: tags.regexp, color: "var(--danger)" },
]);

/** A snippet for a property: text in quotes, expressions and others as they are. */
const placeholder = (p: PropDef) => (["string", "text", "selector", "secret"].includes(p.type) ? `"\${${p.name}}"` : `\${${p.name}}`);
const escapeSnippet = (s: string) => s.replace(/[{}$#\\]/g, (c) => `\\${c}`);

/** Completions: actions (browser.click...), their settings, variables and statements. */
function completions(catalog: ActionMeta[], variables: () => Workflow["variables"]) {
  const metas = new Map(catalog.map((m) => [m.type, m]));
  const callName = (type: string) => (type.startsWith("core.") ? type.slice(5) : type);
  const actionOption = (m: ActionMeta, label: string): Completion => {
    const required = m.props.filter((p) => p.required && !p.output);
    return snippetCompletion(`${escapeSnippet(label)}(${required.map(placeholder).join(", ")})`, {
      label,
      detail: m.displayName,
      info: m.description,
      type: "function",
    });
  };
  const namespaces = [...new Set(catalog.filter((m) => !m.type.startsWith("core.")).map((m) => m.type.split(".")[0]!))];
  const statements: Completion[] = [
    snippetCompletion("if (${condition}) {\n\t${}\n}", { label: "if", detail: "If", type: "keyword" }),
    snippetCompletion("if (${condition}) {\n\t${}\n} else {\n\t\n}", { label: "if else", detail: "If / Else", type: "keyword" }),
    snippetCompletion("for (const ${item} of ${items}) {\n\t${}\n}", { label: "for", detail: "For Each", type: "keyword" }),
    snippetCompletion("while (${condition}) {\n\t${}\n}", { label: "while", detail: "While", type: "keyword" }),
    snippetCompletion("try {\n\t${}\n} catch (error) {\n\t\n}", { label: "try", detail: "Try / Catch", type: "keyword" }),
    snippetCompletion('throw new Error("${message}")', { label: "throw", detail: "Throw", type: "keyword" }),
    snippetCompletion('variable("${name}", "${string}")', { label: "variable", detail: "A variable", type: "keyword" }),
    snippetCompletion('input("${name}", "${string}")', { label: "input", detail: "An in-argument", type: "keyword" }),
    snippetCompletion('output("${name}", "${string}")', { label: "output", detail: "An out-argument", type: "keyword" }),
    snippetCompletion("// @step { ${continueOnError: true} }", { label: "@step", detail: "The next step's settings", type: "keyword" }),
  ];

  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    // Inside an action's settings object: its setting names.
    const inObject = /([A-Za-z_$][\w$.]*)\([^()]*\{[^{}]*$/.exec(before);
    const word = context.matchBefore(/[\w$.@]*/);
    if (inObject && /(^|[{,]\s*)[\w$]*$/.test(before)) {
      const type = inObject[1]!.includes(".") ? inObject[1]! : `core.${inObject[1]}`;
      const meta = metas.get(type) ?? metas.get(inObject[1]!);
      if (meta) {
        const from = context.matchBefore(/[\w$]*/)!.from;
        return {
          from,
          options: meta.props.filter((p) => !p.output).map((p) => ({ label: p.name, apply: `${p.name}: `, detail: p.label, info: p.description, type: "property" })),
        };
      }
    }
    if (!word || (word.from === word.to && !context.explicit)) return null;
    if (/\/\//.test(before.slice(0, word.from - line.from)) && !word.text.startsWith("@")) return null;
    const dot = word.text.lastIndexOf(".");
    if (dot > 0) {
      const prefix = word.text.slice(0, dot + 1);
      return {
        from: word.from,
        options: catalog.filter((m) => m.type.startsWith(prefix) || `core.${callName(m.type)}`.startsWith(`core.${prefix}`)).map((m) => actionOption(m, m.type)),
        validFor: /^[\w$.]*$/,
      };
    }
    return {
      from: word.from,
      options: [
        ...statements,
        ...namespaces.map((ns) => ({ label: ns, detail: "actions", type: "namespace", apply: `${ns}.`, boost: -1 })),
        ...catalog.filter((m) => m.type.startsWith("core.") && !["core.sequence", "core.if", "core.forEach", "core.while", "core.tryCatch", "core.break", "core.throw", "core.comment", "core.assign"].includes(m.type)).map((m) => actionOption(m, callName(m.type))),
        ...variables().map((v) => ({ label: v.name, detail: `${v.direction === "local" ? "variable" : `${v.direction}-argument`} · ${v.type}`, type: "variable", boost: 1 })),
      ],
      validFor: /^[\w$@]*$/,
    };
  };
}

/**
 * The workflow as code (see packages/core/src/code.ts). Edits here become steps
 * as soon as the code reads well; changes made elsewhere (recording, the canvas,
 * undo) rewrite the code.
 */
export function CodeView({
  workflow,
  catalog,
  readOnly,
  onChange,
  onStatus,
}: {
  workflow: Workflow;
  catalog: ActionMeta[];
  readOnly: boolean;
  onChange: (workflow: Workflow) => void;
  onStatus: (message: string) => void;
}) {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const current = useRef(workflow);
  current.current = workflow;
  const change = useRef(onChange);
  change.current = onChange;
  /** The steps the code last turned into (so the workflow coming back does not rewrite the code). */
  const applied = useRef(stepsKey(workflow));
  const editable = useRef(new Compartment());
  const [problems, setProblems] = useState({ errors: 0, warnings: 0 });

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const v = view.current;
      if (!v) return;
      const result = codeToWorkflow(v.state.doc.toString(), current.current, catalog);
      const diagnostics: Diagnostic[] = result.diagnostics.map((d) => ({
        from: Math.min(d.from, v.state.doc.length),
        to: Math.min(Math.max(d.to, d.from), v.state.doc.length),
        severity: d.severity,
        message: d.message,
      }));
      v.dispatch(setDiagnostics(v.state, diagnostics));
      setProblems({ errors: diagnostics.filter((d) => d.severity === "error").length, warnings: diagnostics.filter((d) => d.severity === "warning").length });
      if (!result.workflow) return;
      const key = stepsKey(result.workflow);
      if (key === stepsKey(current.current)) return;
      applied.current = key;
      change.current(result.workflow);
    };
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: workflowToCode(workflow, catalog),
        extensions: [
          basicSetup,
          // Tab indents (Esc, then Tab, moves on to the rest of the page).
          keymap.of([indentWithTab]),
          javascript(),
          // Long action lines wrap instead of running off the side.
          EditorView.lineWrapping,
          theme,
          syntaxHighlighting(highlight),
          lintGutter(),
          autocompletion({ override: [completions(catalog, () => current.current.variables)], icons: false }),
          editable.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.every((tr) => tr.annotation(fromOutside))) return;
            clearTimeout(timer);
            timer = setTimeout(read, READ_AFTER_MS);
          }),
          EditorView.contentAttributes.of({ "aria-label": "Workflow code", spellcheck: "false" }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      clearTimeout(timer);
      editor.destroy();
      view.current = undefined;
    };
    // The editor is made once; the workflow and read-only state reach it below.
  }, [catalog]);

  // Changes from elsewhere (canvas, recording, undo, AI): the code is written again.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const key = stepsKey(workflow);
    if (key === applied.current) return;
    applied.current = key;
    const code = workflowToCode(workflow, catalog);
    if (code === v.state.doc.toString()) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: code }, annotations: fromOutside.of(true) });
    v.dispatch(setDiagnostics(v.state, []));
    setProblems({ errors: 0, warnings: 0 });
  }, [workflow, catalog]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);

  const exportPlaywright = async () => {
    const { code, fileName, unsupported } = workflowToPlaywright(workflow, catalog);
    if (!(await saveText(fileName, code, t("code.playwrightKind"), "text/plain", ".ts"))) return;
    onStatus(unsupported ? t("code.playwrightSavedTodo", { file: fileName, count: unsupported }) : t("code.playwrightSaved", { file: fileName }));
  };

  return (
    <section className="code-view">
      <div className="code-head">
        {problems.errors > 0 ? (
          <span className="code-state bad">{t("code.problems", { count: problems.errors })}</span>
        ) : (
          <span className="code-state ok">{t("code.inSync")}</span>
        )}
        <span className="tiny muted code-hint">{t("code.hint")}</span>
        <span className="spacer" />
        <button className="btn-ghost small" onClick={() => void navigator.clipboard?.writeText(view.current?.state.doc.toString() ?? "")}>
          {t("common.copy")}
        </button>
        <button className="btn-ghost small" title={t("code.playwrightHint")} onClick={() => void exportPlaywright()}>
          {t("code.playwright")}
        </button>
      </div>
      <div className="code-editor" ref={host} />
    </section>
  );
}
