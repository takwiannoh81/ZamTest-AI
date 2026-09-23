import { newStepId } from "@zamtest/core";
import type { ActivityMeta, Step } from "@zamtest/core";

export interface Location {
  parentId: string;
  slot: string;
  index: number;
}

export function findStep(root: Step, id: string): Step | undefined {
  if (root.id === id) return root;
  for (const children of Object.values(root.slots ?? {})) {
    for (const child of children) {
      const found = findStep(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

export function locate(root: Step, id: string): Location | undefined {
  for (const [slot, children] of Object.entries(root.slots ?? {})) {
    const index = children.findIndex((c) => c.id === id);
    if (index >= 0) return { parentId: root.id, slot, index };
    for (const child of children) {
      const found = locate(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Returns a copy of `root` with `fn` applied to the step with `id`. */
export function mapStep(root: Step, id: string, fn: (s: Step) => Step): Step {
  if (root.id === id) return fn(root);
  if (!root.slots) return root;
  let changed = false;
  const slots: Record<string, Step[]> = {};
  for (const [name, children] of Object.entries(root.slots)) {
    slots[name] = children.map((c) => {
      const next = mapStep(c, id, fn);
      if (next !== c) changed = true;
      return next;
    });
  }
  return changed ? { ...root, slots } : root;
}

export function removeStep(root: Step, id: string): Step {
  const loc = locate(root, id);
  if (!loc) return root;
  return mapStep(root, loc.parentId, (p) => ({
    ...p,
    slots: { ...p.slots, [loc.slot]: p.slots![loc.slot]!.filter((c) => c.id !== id) },
  }));
}

export function insertStep(root: Step, loc: Location, step: Step): Step {
  return mapStep(root, loc.parentId, (p) => {
    const list = [...(p.slots?.[loc.slot] ?? [])];
    list.splice(Math.min(loc.index, list.length), 0, step);
    return { ...p, slots: { ...p.slots, [loc.slot]: list } };
  });
}

export function containsStep(root: Step, id: string): boolean {
  return Boolean(findStep(root, id));
}

export function moveStep(root: Step, id: string, target: Location): Step {
  const step = findStep(root, id);
  const from = locate(root, id);
  if (!step || !from) return root;
  // Cannot drop a container into itself.
  if (containsStep(step, target.parentId)) return root;
  let index = target.index;
  if (from.parentId === target.parentId && from.slot === target.slot && from.index < index) index--;
  return insertStep(removeStep(root, id), { ...target, index }, step);
}

export function cloneWithNewIds(step: Step): Step {
  return {
    ...structuredClone(step),
    id: newStepId(),
    slots: step.slots
      ? Object.fromEntries(Object.entries(step.slots).map(([k, v]) => [k, v.map(cloneWithNewIds)]))
      : undefined,
  };
}

export function createStep(meta: ActivityMeta): Step {
  const props: Record<string, unknown> = {};
  for (const p of meta.props) {
    if (p.required && p.default !== undefined) props[p.name] = p.default;
  }
  return {
    id: newStepId(),
    type: meta.type,
    props,
    slots: meta.slots?.length ? Object.fromEntries(meta.slots.map((s) => [s, []])) : undefined,
  };
}

/** One-line summary shown on the step card. */
export function summarize(step: Step): string {
  const p = step.props ?? {};
  const pick = ["message", "condition", "items", "selector", "url", "goal", "prompt", "name", "path", "text", "code"];
  for (const key of pick) {
    const v = p[key];
    if (typeof v === "string" && v) return v.length > 90 ? `${v.slice(0, 90)}...` : v;
  }
  if (step.type === "core.assign" && p.variable) return `${p.variable} = ${p.value ?? ""}`;
  if (step.type === "core.delay") return `${p.ms ?? 1000} ms`;
  return "";
}
