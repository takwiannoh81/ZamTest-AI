import { walkSteps } from "@zamtest/core";
import type { ActionMeta, Workflow } from "@zamtest/core";

export interface Issue {
  stepId: string;
  message: string;
}

/** Design-time checks shown in the toolbar before publishing. */
export function validate(workflow: Workflow, metas: Map<string, ActionMeta>): Issue[] {
  const issues: Issue[] = [];
  const declared = new Set(workflow.variables.map((v) => v.name));
  const names = new Set<string>();
  for (const v of workflow.variables) {
    if (names.has(v.name)) issues.push({ stepId: workflow.root.id, message: `Variable "${v.name}" is declared twice` });
    names.add(v.name);
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v.name)) issues.push({ stepId: workflow.root.id, message: `"${v.name}" is not a valid variable name` });
  }
  walkSteps(workflow.root, (step) => {
    if (step.disabled) return;
    const meta = metas.get(step.type);
    if (!meta) {
      issues.push({ stepId: step.id, message: `Unknown action ${step.type}` });
      return;
    }
    for (const p of meta.props) {
      const v = step.props[p.name];
      if (p.required && (v === undefined || v === "") && p.default === undefined) {
        issues.push({ stepId: step.id, message: `${step.label ?? meta.displayName}: "${p.label}" is required` });
      }
      if (p.type === "variable" && typeof v === "string" && v && !declared.has(v) && !["itemVariable", "indexVariable", "errorVariable"].includes(p.name)) {
        issues.push({ stepId: step.id, message: `${step.label ?? meta.displayName}: variable "${v}" is not declared` });
      }
    }
    if (meta.type.startsWith("browser.") && meta.props.some((p) => p.name === "description") && !step.props.description) {
      issues.push({ stepId: step.id, message: `${step.label ?? meta.displayName}: add a target description so AI can self-heal the selector` });
    }
  });
  return issues;
}
