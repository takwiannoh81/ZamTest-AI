/**
 * "Call Workflow" steps name a workflow by id. When a job starts, the workflows it
 * calls (and the ones those call) are added to its definition, as saved at that
 * moment, so the bot needs nothing else. Only the workspace's own workflows.
 */
import { walkSteps } from "@zamtest/core";
import type { Step, Workflow } from "@zamtest/core";
import { HttpError } from "./errors.js";
import type { Store } from "./store.js";

const MAX_CALLED = 50;

const calledIds = (root: Step): string[] => {
  const ids: string[] = [];
  walkSteps(root, (step) => {
    if (step.type === "core.callWorkflow" && !step.disabled && typeof step.props?.workflowId === "string" && step.props.workflowId) ids.push(step.props.workflowId);
  });
  return ids;
};

export function withCalledWorkflows(store: Store, workspaceId: string, definition: Workflow): Workflow {
  const library: Record<string, Workflow> = {};
  const queue = calledIds(definition.root);
  while (queue.length) {
    const id = queue.shift()!;
    if (library[id]) continue;
    const called = store.data.workflows[id];
    if (!called || called.workspaceId !== workspaceId) throw new HttpError(400, `A "Call Workflow" step calls workflow ${id}, which does not exist (was it deleted?)`);
    if (Object.keys(library).length >= MAX_CALLED) throw new HttpError(400, `A workflow may call at most ${MAX_CALLED} other workflows`);
    const { workflows: _nested, ...own } = called.definition;
    library[id] = { ...own, id };
    queue.push(...calledIds(called.definition.root));
  }
  if (!Object.keys(library).length) return definition;
  return { ...definition, workflows: library };
}

/** Points "Call Workflow" steps at new workflow ids (importing a project). */
export function remapCalls(root: Step, ids: Map<string, string>): Step {
  const copy = structuredClone(root);
  walkSteps(copy, (step) => {
    if (step.type === "core.callWorkflow" && typeof step.props?.workflowId === "string") {
      const mapped = ids.get(step.props.workflowId);
      if (mapped) step.props.workflowId = mapped;
    }
  });
  return copy;
}
