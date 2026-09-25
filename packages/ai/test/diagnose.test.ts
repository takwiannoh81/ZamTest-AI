import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { applyStepChanges } from "@zamtest/core";
import type { Workflow } from "@zamtest/core";
import { ZamAI } from "../src/index.js";
import type { BetaMessage } from "../src/index.js";

type Block = BetaMessage["content"][number];

function fakeClient(replies: string[]) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          const reply = replies.shift();
          if (reply === undefined) throw new Error("No more fake replies");
          return {
            finalMessage: async () =>
              ({ id: "m", type: "message", role: "assistant", model: "fake", stop_reason: "end_turn", content: [{ type: "text", text: reply, citations: null } as Block], usage: {} }) as unknown as BetaMessage,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const workflow: Workflow = {
  schemaVersion: 1,
  id: "wf",
  name: "Login",
  variables: [],
  root: {
    id: "root",
    type: "core.sequence",
    props: {},
    slots: {
      body: [
        { id: "cred", type: "core.getAsset", props: { name: "VideoInsight/Login", variable: "credential" } },
        { id: "pw", type: "desktop.type", props: { selector: 'window[process="vimonitor"] > edit[id="Pwd"]', text: "{{ credential.password }}" } },
      ],
    },
  },
};

const answer = (fixes: unknown[]) =>
  "Looking at it.\n```json\n" + JSON.stringify({ summary: "The password field has another id.", cause: "selector", details: "The controls list shows id PasswordBox.", fixes }) + "\n```";

describe("applyStepChanges", () => {
  it("updates, inserts and removes steps on a copy", () => {
    const next = applyStepChanges(workflow, [
      { op: "update", stepId: "pw", props: { selector: 'window[process="vimonitor"] > edit[id="PasswordBox"]' }, retry: { count: 2 } },
      { op: "insert", before: "pw", step: { id: "wait", type: "desktop.waitFor", props: { selector: 'window[process="vimonitor"]' } } },
      { op: "remove", stepId: "cred" },
    ]);
    expect(next.root.slots!.body!.map((s) => s.id)).toEqual(["wait", "pw"]);
    expect(next.root.slots!.body![1]).toMatchObject({ props: { selector: 'window[process="vimonitor"] > edit[id="PasswordBox"]' }, retry: { count: 2 } });
    expect(workflow.root.slots!.body!).toHaveLength(2);
    expect(() => applyStepChanges(workflow, [{ op: "remove", stepId: "nope" }])).toThrow(/nope/);
  });
});

describe("diagnoseRun", () => {
  it("sends the evidence with the screenshots as images, and returns fixes that apply", async () => {
    const fix = { kind: "editSteps", title: "Use the real password field", why: "", changes: [{ op: "update", stepId: "pw", props: { selector: 'window[process="vimonitor"] > edit[id="PasswordBox"]' } }] };
    const { client, requests } = fakeClient([answer([fix])]);
    const ai = new ZamAI({ client, model: "claude-test" });
    const result = await ai.diagnoseRun({
      workflow,
      error: "Element not found",
      failedStepId: "pw",
      logs: [{ time: "t", level: "error", message: "Element not found", stepId: "pw" }],
      screenshots: [{ stepId: "pw", status: "error", jpeg: Buffer.from([1, 2, 3]) }],
      assets: [{ name: "VideoInsight/Login", type: "credential" }],
      live: { selector: 'window[process="vimonitor"]', found: true, tree: 'window process="vimonitor"\n  edit id="PasswordBox"' },
    });
    expect(result.cause).toBe("selector");
    expect(result.fixes[0]).toMatchObject({ kind: "editSteps", title: "Use the real password field" });
    const content = (requests[0]!.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]!.content;
    expect(content.filter((b) => b.type === "image")).toHaveLength(1);
    const all = content.map((b) => b.text ?? "").join("\n");
    expect(all).toContain("Failing step id: pw");
    expect(all).toContain('edit id="PasswordBox"');
    expect(all).toContain("VideoInsight/Login (credential)");
  });

  it("sends a fix that does not apply back to Claude once", async () => {
    const bad = { kind: "editSteps", title: "Fix", why: "", changes: [{ op: "update", stepId: "missing-step", props: {} }] };
    const good = { kind: "manual", title: "Check the password", why: "", instructions: ["Open the Portal"] };
    const { client, requests } = fakeClient([answer([bad]), answer([good])]);
    const result = await new ZamAI({ client }).diagnoseRun({ workflow, error: "x", logs: [] });
    expect(result.fixes).toEqual([good]);
    expect(requests).toHaveLength(2);
    const retry = (requests[1]!.messages as Array<{ content: unknown }>)[2]!.content;
    expect(String(retry)).toContain("missing-step");
  });
});
