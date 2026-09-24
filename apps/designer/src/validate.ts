import { walkSteps } from "@zamtest/core";
import type { ActionMeta, Workflow } from "@zamtest/core";
import type { Translator } from "@zamtest/i18n";

export interface Issue {
  stepId: string;
  message: string;
  /** The property to fill in (the Properties panel focuses it). */
  prop?: string;
}

/** Design-time checks shown in the toolbar before publishing. */
export function validate(workflow: Workflow, metas: Map<string, ActionMeta>, tr: Translator): Issue[] {
  const { t } = tr;
  const issues: Issue[] = [];
  const declared = new Set(workflow.variables.map((v) => v.name));
  const names = new Set<string>();
  for (const v of workflow.variables) {
    if (names.has(v.name)) issues.push({ stepId: workflow.root.id, message: t("validate.duplicateVariable", { name: v.name }) });
    names.add(v.name);
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v.name)) {
      issues.push({ stepId: workflow.root.id, message: t("validate.invalidVariable", { name: v.name }) });
    }
  }
  walkSteps(workflow.root, (step) => {
    if (step.disabled) return;
    const meta = metas.get(step.type);
    if (!meta) {
      issues.push({ stepId: step.id, message: t("validate.unknownAction", { type: step.type }) });
      return;
    }
    const stepName = step.label ?? tr.actionName(meta);
    for (const p of meta.props) {
      const v = step.props[p.name];
      if (p.required && (v === undefined || v === "") && p.default === undefined) {
        issues.push({ stepId: step.id, prop: p.name, message: t("validate.required", { step: stepName, prop: tr.propLabel(step.type, p) }) });
      }
      if (
        p.type === "variable" &&
        typeof v === "string" &&
        v &&
        !declared.has(v) &&
        !["itemVariable", "indexVariable", "errorVariable"].includes(p.name)
      ) {
        issues.push({ stepId: step.id, prop: p.name, message: t("validate.undeclared", { step: stepName, name: v }) });
      }
    }
    if (meta.type.startsWith("browser.") && meta.props.some((p) => p.name === "description") && !step.props.description) {
      issues.push({ stepId: step.id, prop: "description", message: t("validate.needsDescription", { step: stepName }) });
    }
  });
  return issues;
}
