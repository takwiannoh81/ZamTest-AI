import { describe, expect, it } from "vitest";
import { BUILTIN_ACTIONS, safeParseWorkflow, TEMPLATES, walkSteps, workflowFromTemplate } from "../src/index.js";

const actions = new Map(BUILTIN_ACTIONS.map((a) => [a.type, a]));

describe.each(TEMPLATES.map((t) => [t.id, t] as const))("template %s", (_id, template) => {
  const workflow = workflowFromTemplate(template, "Name", "Set-up note");

  it("is a valid workflow of known actions, with every required setting filled in", () => {
    const parsed = safeParseWorkflow(workflow);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    const ids = new Set<string>();
    walkSteps(workflow.root, (step) => {
      if (step.id === "root") return;
      expect(ids.has(step.id), `duplicate id ${step.id}`).toBe(false);
      ids.add(step.id);
      const meta = actions.get(step.type);
      expect(meta, step.type).toBeDefined();
      expect(step.label, `${step.type} has a label`).toBeTruthy();
      for (const prop of meta!.props) {
        if (prop.required) expect(step.props[prop.name], `${step.type}.${prop.name}`).not.toBeUndefined();
        if (prop.type === "enum" && step.props[prop.name] !== undefined) expect(prop.options).toContain(step.props[prop.name]);
      }
      for (const name of Object.keys(step.props)) expect(meta!.props.map((p) => p.name), `${step.type} has no prop ${name}`).toContain(name);
      for (const slot of Object.keys(step.slots ?? {})) expect(meta!.slots).toContain(slot);
    });
  });

  it("declares every variable its steps save to", () => {
    const declared = new Set(workflow.variables.map((v) => v.name));
    walkSteps(workflow.root, (step) => {
      for (const key of ["output", "variable", "itemVariable", "errorVariable"]) {
        const name = step.props[key];
        if (typeof name === "string" && name) expect(declared, `${step.type}.${key} = ${name}`).toContain(name);
      }
    });
  });

  it("makes independent copies", () => {
    const again = workflowFromTemplate(template, "Other");
    again.root.slots!.body![0]!.label = "changed";
    expect(workflowFromTemplate(template, "x").root.slots!.body![0]!.label).not.toBe("changed");
  });
});

describe("templates", () => {
  it("have unique ids and cover every category", () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.category))).toEqual(new Set(["email", "data", "web", "integration", "testing"]));
  });
});
