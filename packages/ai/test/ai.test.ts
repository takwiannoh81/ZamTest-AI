import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AiRefusalError, extractJson, parseFieldList, ZamAI } from "../src/index.js";
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

describe("readDocument", () => {
  const answer = (fields: Record<string, { value: unknown; confidence: number; evidence: string }>) =>
    text(JSON.stringify({ documentType: "invoice", summary: "An invoice", fields }));

  it("sends a PDF as a document (an image as an image), and checks what comes back", async () => {
    const { client, requests } = fakeClient([
      {
        content: [
          answer({
            supplier: { value: "ACME", confidence: 0.99, evidence: "ACME Ltd" },
            invoiceDate: { value: "1 Sept 2026", confidence: 0.95, evidence: "1 Sept 2026" },
            total: { value: "1,180.00", confidence: 1.4, evidence: "Total 1,180.00" },
            dueDate: { value: null, confidence: 0.9, evidence: "" },
          }),
        ],
      },
      { content: [answer({ total: { value: 5, confidence: 0.97, evidence: "5.00" } })] },
    ]);
    const ai = new ZamAI({ client });
    const fields = parseFieldList("supplier, invoiceDate:date, total:number, dueDate:date");
    const read = await ai.readDocument({ data: Buffer.from("%PDF"), mediaType: "application/pdf", fields });
    expect(read.fields).toEqual({ supplier: "ACME", invoiceDate: "1 Sept 2026", total: 1180, dueDate: null });
    // A date or number in the wrong form is kept to be fixed, but not trusted; confidence stays within 0..1.
    expect(read.confidence).toEqual({ supplier: 0.99, invoiceDate: 0.3, total: 0.3, dueDate: 0.9 });
    const sent = requests[0] as { messages: Array<{ content: Array<{ type: string; source?: { media_type: string } }> }> };
    expect(sent.messages[0]!.content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });

    await ai.readDocument({ data: Buffer.from("png"), mediaType: "image/png", fields: parseFieldList("total:number") });
    expect((requests[1] as typeof sent).messages[0]!.content[0]).toMatchObject({ type: "image", source: { media_type: "image/png" } });
    await expect(ai.readDocument({ data: Buffer.from("x"), mediaType: "image/tiff", fields })).rejects.toThrow("must be PDF, PNG, JPEG, GIF or WebP");
  });

  it("reads field lists as people write them", () => {
    expect(parseFieldList("supplier, total:number, invoiceDate: date - the date printed at the top")).toEqual([
      { name: "supplier", type: "text" },
      { name: "total", type: "number" },
      { name: "invoiceDate", type: "date", description: "the date printed at the top" },
    ]);
    expect(parseFieldList("iban:string - the account, with spaces\npaid:boolean")).toEqual([
      { name: "iban", type: "text", description: "the account, with spaces" },
      { name: "paid", type: "boolean" },
    ]);
    expect(() => parseFieldList("total amount")).toThrow('Cannot read the field "total amount"');
  });
});

describe("lookAtScreen (AI Vision)", () => {
  const image = Buffer.from("fake jpeg");
  it("sends the screenshot with its size and keeps the click inside the element", async () => {
    const answer = { found: true, box: { x: 100, y: 200, width: 80, height: 30 }, x: 400, y: 10, confidence: 0.93, reason: "The Submit button below the form" };
    const { client, requests } = fakeClient([{ content: [text(JSON.stringify(answer))] }]);
    const ai = new ZamAI({ client, model: "claude-opus-5" });
    const result = await ai.lookAtScreen({ task: "locate", target: "the Submit button", image, mediaType: "image/jpeg", width: 1280, height: 720 });
    // The point was outside its own box: the box's center is used.
    expect(result).toMatchObject({ found: true, x: 140, y: 215, confidence: 0.93, box: { x: 100, y: 200, width: 80, height: 30 } });
    const req = requests[0] as { system: string; messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }> };
    expect(req.system).toContain("1280 x 720");
    expect(req.messages[0]!.content[0]).toMatchObject({ type: "image", source: { data: image.toString("base64") } });
  });

  it("reads values and checks screens; nothing is made up when it is not there", async () => {
    const { client } = fakeClient([
      { content: [text(JSON.stringify({ found: true, value: "1,180.00", confidence: 0.97, reason: "Total at the bottom" }))] },
      { content: [text(JSON.stringify({ found: false, value: "ignored", confidence: 0.9, reason: "No total on this screen" }))] },
      { content: [text(JSON.stringify({ found: false, confidence: 0.8, reason: "The login page is shown" }))] },
    ]);
    const ai = new ZamAI({ client, model: "claude-opus-5" });
    const base = { image, mediaType: "image/jpeg" as const, width: 800, height: 600 };
    expect(await ai.lookAtScreen({ ...base, task: "read", target: "the total" })).toMatchObject({ found: true, value: "1,180.00" });
    expect(await ai.lookAtScreen({ ...base, task: "read", target: "the total" })).toMatchObject({ found: false, value: "" });
    expect(await ai.lookAtScreen({ ...base, task: "check", target: "the Welcome page" })).toMatchObject({ found: false, reason: "The login page is shown" });
  });
});
