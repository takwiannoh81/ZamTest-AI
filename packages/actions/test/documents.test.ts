import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_ACTIONS, runWorkflow } from "@zamtest/core";
import type { Step } from "@zamtest/core";
import type { DocumentResult, DocumentService } from "../src/index.js";

process.env.ZAMTEST_REVIEW_POLL_MS = "20";
const { builtinHandlers } = await import("../src/index.js");

const dir = mkdtempSync(join(tmpdir(), "zamtest-doc-"));
const pdf = join(dir, "invoice.pdf");
writeFileSync(pdf, "%PDF-1.4 fake");

const result = (over: Partial<DocumentResult>): DocumentResult => ({
  documentId: "doc_1",
  status: "auto",
  documentType: "invoice",
  summary: "",
  fields: { total: 10 },
  confidence: { total: 0.99 },
  unsure: [],
  name: "invoice.pdf",
  ...over,
});

async function run(props: Record<string, unknown>, documents: DocumentService) {
  const step: Step = { id: "d", type: "doc.process", props: { path: pdf, output: "doc", ...props } };
  return runWorkflow(
    { schemaVersion: 1, id: "w", name: "w", variables: [{ name: "doc", type: "object", direction: "out" }], root: { id: "root", type: "core.sequence", props: {}, slots: { body: [step] } } },
    { handlers: builtinHandlers, catalog: BUILTIN_ACTIONS, services: { documents } },
  );
}

describe("Process Document with AI", () => {
  it("sends the file with what to read, and returns at once when no review is needed", async () => {
    const sent: Array<Parameters<DocumentService["process"]>[0]> = [];
    const r = await run({ documentType: "receipt", review: "when unsure", threshold: 0.8, title: "Receipt" }, {
      process: async (input) => (sent.push(input), result({})),
      get: async () => result({}),
    });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.outputs.doc).toMatchObject({ status: "auto", fields: { total: 10 } });
    expect(sent[0]).toMatchObject({ mediaType: "application/pdf", name: "invoice.pdf", documentType: "receipt", threshold: 0.8, title: "Receipt" });
    expect(sent[0]!.data.toString()).toBe("%PDF-1.4 fake");
  });

  it("waits for the review, and gets the reviewed fields", async () => {
    let asks = 0;
    const r = await run({}, {
      process: async () => result({ status: "pending", unsure: ["total"] }),
      get: async () => (++asks < 3 ? result({ status: "pending" }) : result({ status: "approved", fields: { total: 12 }, reviewedBy: "Anna" })),
    });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.outputs.doc).toMatchObject({ status: "approved", fields: { total: 12 }, reviewedBy: "Anna" });
    expect(asks).toBe(3);
  });

  it("hands over without waiting, and stops after the wait when nobody reviews it", async () => {
    const pending = { process: async () => result({ status: "pending" }), get: async () => result({ status: "pending" }) };
    const handed = await run({ thenProcess: "Book invoice" }, pending);
    expect(handed.outputs.doc).toMatchObject({ status: "pending" });
    const waited = await run({ waitMinutes: 0.001 }, pending);
    expect(waited.status).toBe("failed");
    expect(waited.error).toContain("was not reviewed within 0.001 minutes");
  });

  it("refuses other files clearly", async () => {
    const txt = join(dir, "notes.txt");
    writeFileSync(txt, "x");
    const service = { process: async () => result({}), get: async () => result({}) };
    expect((await run({ path: txt }, service)).error).toContain("Documents must be PDF, PNG, JPEG, GIF or WebP files");
    expect((await run({ path: join(dir, "missing.pdf") }, service)).error).toContain("File not found");
  });
});
