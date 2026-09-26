import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiRefusalError, extractJson, ZamAI } from "../src/index.js";
import type { BetaMessage } from "../src/index.js";

type Block = BetaMessage["content"][number];

/** Fake Anthropic client that replays canned responses and records requests. */
function fakeClient(responses: Array<{ content: Block[]; stop_reason?: string }>) {
  const requests: Array<Record<string, unknown>> = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          requests.push(structuredClone(params));
          const next = responses.shift();
          if (!next) throw new Error("No more fake responses");
          return {
            finalMessage: async () =>
              ({
                id: "msg",
                type: "message",
                role: "assistant",
                model: "fake",
                stop_reason: next.stop_reason ?? "end_turn",
                content: next.content,
                usage: {},
              }) as unknown as BetaMessage,
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const text = (t: string): Block => ({ type: "text", text: t, citations: null }) as Block;

describe("extractJson", () => {
  it("reads fenced and bare JSON", () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('prefix {"b":[1,2]} suffix')).toEqual({ b: [1, 2] });
  });
});

describe("ZamAI", () => {
  it("defaults to claude-opus-5 with server-side refusal fallbacks", async () => {
    const { client, requests } = fakeClient([{ content: [text("hi")] }]);
    const ai = new ZamAI({ client, model: "claude-opus-5" });
    expect(await ai.prompt({ prompt: "hello" })).toBe("hi");
    expect(requests[0]).toMatchObject({ model: "claude-opus-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
  });

  it("raises AiRefusalError on refusals", async () => {
    const { client } = fakeClient([{ content: [], stop_reason: "refusal" }]);
    await expect(new ZamAI({ client }).prompt({ prompt: "x" })).rejects.toBeInstanceOf(AiRefusalError);
  });

  it("generates a workflow and repairs validation errors on a second attempt", async () => {
    const bad = {
      id: "w",
      name: "W",
      root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "made.up", props: {} }] } },
    };
    const good = { ...bad, root: { ...bad.root, slots: { body: [{ id: "a", type: "core.log", props: { message: "hi" } }] } } };
    const { client, requests } = fakeClient([
      { content: [text("- plan\n```json\n" + JSON.stringify(bad) + "\n```")] },
      { content: [text("- fixed\n```json\n" + JSON.stringify(good) + "\n```")] },
    ]);
    const result = await new ZamAI({ client }).generateWorkflow({ prompt: "say hi" });
    expect(result.workflow.root.slots?.body?.[0]?.type).toBe("core.log");
    expect(result.notes).toBe("- fixed");
    const retry = requests[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(JSON.stringify(retry.at(-1))).toContain('Unknown action type \\"made.up\\"');
  });

  it("runs an agent loop, executing tools and returning the final answer", async () => {
    const { client, requests } = fakeClient([
      {
        stop_reason: "tool_use",
        content: [text("Checking."), { type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } } as Block],
      },
      { content: [text("The answer is 42.")] },
    ]);
    const calls: unknown[] = [];
    const result = await new ZamAI({ client }).runAgent({
      goal: "find the answer",
      tools: [
        {
          name: "lookup",
          description: "look up",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
          run: async (input) => {
            calls.push(input);
            return 42;
          },
        },
      ],
    });
    expect(result).toMatchObject({ answer: "The answer is 42.", finished: true, steps: 2 });
    expect(calls).toEqual([{ q: "x" }]);
    const second = requests[1]!.messages as Array<{ role: string; content: Array<{ type: string; content?: string }> }>;
    expect(second.at(-1)!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "42" });
  });
});

describe("languages", () => {
  it("asks for human-readable workflow text in the user's language", async () => {
    const good = {
      id: "w",
      name: "Hallo",
      root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "hallo" } }] } },
    };
    const { client, requests } = fakeClient([{ content: [text("```json\n" + JSON.stringify(good) + "\n```")] }]);
    await new ZamAI({ client }).generateWorkflow({ prompt: "sag hallo", language: "German" });
    const blocks = (requests[0]!.messages as Array<{ content: Array<{ text?: string }> }>)[0]!.content;
    const first = blocks.map((b) => b.text ?? "").join("\n");
    expect(first).toContain("in German");
    expect(first).toContain("ASCII identifiers");
  });
});

describe("generateTests", () => {
  const answer = text('- covered\n```json\n{"tests":[{"name":"T","description":"d","steps":[{"id":"a","type":"browser.open","props":{"url":"https://x"}},{"id":"b","type":"browser.verifyTitle","props":{"text":"X"}}]}]}\n```');
  const page = { url: "https://x", title: "X", headings: [], text: "", fields: [], buttons: [], links: [], tables: [] };
  const prompt = (r: Record<string, unknown>) => JSON.stringify(r);

  it("asks for the kinds of tests and uses the person's test data; allows changes only when asked", async () => {
    const { client, requests } = fakeClient([{ content: [answer] }, { content: [answer] }]);
    const ai = new ZamAI({ client });
    await ai.generateTests({ pages: [page], signIn: { kind: "none" }, count: 1, kinds: ["forms", "tables"], testData: "Customer: 4711", allowChanges: true });
    await ai.generateTests({ pages: [page], signIn: { kind: "none" }, count: 1 });
    const [changing, safe] = requests.map(prompt);
    expect(changing).toContain("forms: fields accept valid input");
    expect(changing).toContain("tables and lists");
    expect(changing).not.toContain("search, filters");
    expect(changing).toContain("Customer: 4711");
    expect(changing).toContain("This is a test environment");
    expect(safe).toContain("Never do anything that changes or deletes real data");
    expect(safe).not.toContain("Write tests of these kinds");
  });
});
