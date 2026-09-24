import { describe, expect, it } from "vitest";
import { interpolate, parseWorkflow, runWorkflow } from "../src/index.js";
import type { ActionHandler, EngineEvent, Step } from "../src/index.js";

const logs: string[] = [];
const handlers: Record<string, ActionHandler> = {
  "core.log": (p) => {
    logs.push(String(p.message));
  },
  "core.assign": (p, ctx) => ctx.setVar(String(p.variable), p.value),
  "core.throw": (p) => {
    throw new Error(String(p.message));
  },
};

const step = (type: string, props: Record<string, unknown> = {}, slots?: Record<string, Step[]>): Step => ({
  id: Math.random().toString(36).slice(2),
  type,
  props,
  slots,
});

const wf = (body: Step[], variables: unknown[] = []) =>
  parseWorkflow({ id: "t", name: "t", variables, root: step("core.sequence", {}, { body }) });

describe("expressions", () => {
  it("keeps raw types for whole templates and interpolates mixed strings", () => {
    expect(interpolate("{{ items }}", { items: [1, 2] })).toEqual([1, 2]);
    expect(interpolate("Total: {{ a + b }}!", { a: 1, b: 2 })).toBe("Total: 3!");
  });
});

describe("engine", () => {
  it("runs sequences, if/else, loops and returns out arguments", async () => {
    logs.length = 0;
    const result = await runWorkflow(
      wf(
        [
          step("core.assign", { variable: "total", value: "0" }),
          step("core.forEach", { items: "numbers", itemVariable: "n" }, {
            body: [
              step("core.if", { condition: "n > 2" }, { then: [step("core.break")] }),
              step("core.assign", { variable: "total", value: "total + n" }),
            ],
          }),
          step("core.if", { condition: "total === 3" }, {
            then: [step("core.log", { message: "sum is {{ total }}" })],
            else: [step("core.log", { message: "wrong" })],
          }),
        ],
        [
          { name: "numbers", type: "array", direction: "in" },
          { name: "total", type: "number", direction: "out" },
        ],
      ),
      { handlers, inputs: { numbers: [1, 2, 3, 4] } },
    );
    expect(result.status).toBe("succeeded");
    expect(result.outputs.total).toBe(3);
    expect(logs).toEqual(["sum is 3"]);
  });

  it("catches errors in try/catch and exposes the error variable", async () => {
    logs.length = 0;
    const result = await runWorkflow(
      wf([
        step("core.tryCatch", { errorVariable: "err" }, {
          try: [step("core.throw", { message: "boom" })],
          catch: [step("core.log", { message: "caught {{ err.message }}" })],
          finally: [step("core.log", { message: "finally" })],
        }),
      ]),
      { handlers },
    );
    expect(result.status).toBe("succeeded");
    expect(logs).toEqual(["caught boom", "finally"]);
  });

  it("retries failing steps and reports failure", async () => {
    let calls = 0;
    const failing: ActionHandler = () => {
      calls++;
      throw new Error("flaky");
    };
    const s = step("test.flaky");
    s.retry = { count: 2, delayMs: 1 };
    const events: EngineEvent[] = [];
    const result = await runWorkflow(wf([s]), { handlers: { ...handlers, "test.flaky": failing }, onEvent: (e) => events.push(e) });
    expect(calls).toBe(3);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("flaky");
    expect(events.some((e) => e.type === "stepEnd" && e.status === "error")).toBe(true);
  });

  it("continueOnError keeps the sequence going", async () => {
    logs.length = 0;
    const bad = step("core.throw", { message: "ignored" });
    bad.continueOnError = true;
    const result = await runWorkflow(wf([bad, step("core.log", { message: "after" })]), { handlers });
    expect(result.status).toBe("succeeded");
    expect(logs).toEqual(["after"]);
  });

  it("stores action results in the output variable", async () => {
    const result = await runWorkflow(
      wf([step("core.getAsset", { name: "apiUrl", output: "url" })], [{ name: "url", direction: "out" }]),
      { handlers: { "core.getAsset": (p) => `https://${p.name}` } },
    );
    expect(result.outputs.url).toBe("https://apiUrl");
  });

  it("fails fast on missing required props", async () => {
    const result = await runWorkflow(wf([step("core.log", {})]), { handlers });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/missing required property/);
  });

  it("can be cancelled", async () => {
    const controller = new AbortController();
    const result = await runWorkflow(
      wf([
        step("test.cancel"),
        step("core.log", { message: "never" }),
      ]),
      { handlers: { ...handlers, "test.cancel": () => controller.abort() }, signal: controller.signal },
    );
    expect(result.status).toBe("cancelled");
  });
});

describe("after each step (screenshots)", () => {
  it("is called after action steps only, with their outcome and the run's resources, and never breaks a run", async () => {
    const seen: string[] = [];
    const first = step("core.log", { message: "one" });
    const loop = step("core.if", { condition: "true" }, { then: [step("core.log", { message: "two" })] });
    const bad = { ...step("core.throw", { message: "boom" }), continueOnError: true };
    const result = await runWorkflow(wf([first, loop, bad]), {
      handlers: { ...handlers, "core.log": (_p, ctx) => void ctx.resources.set("page", "open") },
      afterStep: ({ step: s, status, error, resources }) => {
        seen.push(`${s.type}:${status}${error ? `:${error}` : ""}:${String(resources.get("page"))}`);
        throw new Error("the camera broke");
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("succeeded");
    expect(seen).toEqual(["core.log:ok:open", "core.log:ok:open", "core.throw:error:boom:open"]);
  });
});

describe("Call Workflow", () => {
  const login = parseWorkflow({
    id: "wf_login",
    name: "Log in",
    variables: [
      { name: "user", type: "string", direction: "in" },
      { name: "greeting", type: "string", direction: "out" },
    ],
    root: {
      id: "root",
      type: "core.sequence",
      props: {},
      slots: {
        body: [
          { id: "open", type: "test.open", props: {} },
          { id: "set", type: "core.assign", props: { variable: "greeting", value: "\"Welcome, \" + user" } },
        ],
      },
    },
  });
  const open: ActionHandler = (_p, ctx) => {
    ctx.resources.set("browser", "open");
    ctx.onDispose(() => ctx.resources.set("browser", "closed"));
  };
  const seen: unknown[] = [];
  const check: ActionHandler = (_p, ctx) => void seen.push(ctx.resources.get("browser"));

  it("runs the called workflow with its inputs, keeps its browser open for the caller, and returns its outputs", async () => {
    const test = parseWorkflow({
      id: "tc",
      name: "Login works",
      variables: [{ name: "result", type: "object", direction: "out" }],
      root: step("core.sequence", {}, { body: [step("core.callWorkflow", { workflowId: "wf_login", inputs: { user: "Ivo" }, output: "result" }), step("test.check")] }),
      workflows: { wf_login: login },
    });
    const result = await runWorkflow(test, { handlers: { ...handlers, "test.open": open, "test.check": check } });
    expect(result.error).toBeUndefined();
    expect(result.outputs.result).toEqual({ greeting: "Welcome, Ivo" });
    expect(seen).toEqual(["open"]);
  });

  it("fails with the called workflow's error, and when the workflow is not there", async () => {
    const broken = parseWorkflow({ id: "wf_b", name: "Broken", variables: [], root: step("core.sequence", {}, { body: [step("core.throw", { message: "boom" })] }) });
    const call = (workflows: Record<string, unknown>) =>
      runWorkflow(parseWorkflow({ id: "t", name: "t", variables: [], root: step("core.sequence", {}, { body: [step("core.callWorkflow", { workflowId: "wf_b" })] }), workflows }), { handlers });
    expect((await call({ wf_b: broken })).error).toBe('Workflow "Broken" failed: boom');
    expect((await call({})).error).toMatch(/not available/);
  });
});
