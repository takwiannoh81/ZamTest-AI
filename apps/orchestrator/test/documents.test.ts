import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { ReadDocumentInput, ReadDocumentResult, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DocumentFiles, parseNumber } from "../src/documents.js";
import type { Mailer } from "../src/mailer.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
let store: Store;
let files: DocumentFiles;
afterEach(() => app?.close());

const agentKey = { "x-agent-key": "k" };
const PDF = Buffer.from("%PDF-1.4 fake invoice");

/** AI that reads every invoice the same way; the total is hard to read. */
function fakeAi(seen: ReadDocumentInput[]): ZamAI {
  return {
    model: "test",
    readDocument: async (input: ReadDocumentInput): Promise<ReadDocumentResult> => {
      seen.push(input);
      const fields = Object.fromEntries(input.fields.map((f) => [f.name, f.name === "total" ? 1180 : f.type === "date" ? "2026-09-01" : f.type === "number" ? 10 : `the ${f.name}`]));
      const confidence = Object.fromEntries(input.fields.map((f) => [f.name, f.name === "total" ? 0.62 : 0.98]));
      return { documentType: "invoice", summary: "An invoice from ACME", fields, confidence, evidence: { total: "Total 1,180.00" } };
    },
  } as unknown as ZamAI;
}

async function setup(mails: Array<{ to: string; subject: string; text: string }> = []) {
  const seen: ReadDocumentInput[] = [];
  store = new Store(null);
  files = new DocumentFiles(null);
  const mailer: Mailer = { send: async (m) => void mails.push(m) };
  ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai: fakeAi(seen), mailer, documentFiles: files }));
  const pc = (await app.inject({ method: "POST", url: "/api/agent/register", headers: agentKey, payload: { name: "pc", version: "0.3.9" } })).json();
  return { seen, agentId: pc.agentId as string };
}

/** What the "Process Document with AI" step sends. */
async function send(agentId: string, spec: Record<string, unknown>, type = "application/pdf", data = PDF) {
  const upload = await app.inject({ method: "POST", url: `/api/agent/documents/file?agentId=${agentId}`, headers: { ...agentKey, "content-type": type }, payload: data });
  if (upload.statusCode !== 201) return upload;
  return app.inject({ method: "POST", url: "/api/agent/documents", headers: agentKey, payload: { agentId, fileId: upload.json().fileId, name: "invoice-17.pdf", ...spec } });
}

describe("document processing", () => {
  it("sends a document with an unsure field to review; the corrected fields go back to the workflow", async () => {
    const mails: Array<{ to: string; subject: string; text: string }> = [];
    const { seen, agentId } = await setup(mails);
    const res = await send(agentId, { documentType: "invoice", title: "Invoice from ACME", notify: "ap@acme.example" });
    expect(res.statusCode, res.body).toBe(200);
    const pending = res.json();
    expect(pending).toMatchObject({ status: "pending", unsure: ["total"], fields: { total: 1180, supplier: "the supplier" } });
    // The invoice preset's fields, and the file as it was sent.
    expect(seen[0]!.fields.map((f) => f.name)).toEqual(["supplier", "invoiceNumber", "invoiceDate", "dueDate", "currency", "subtotal", "tax", "total", "purchaseOrder"]);
    expect(seen[0]!.data.equals(PDF)).toBe(true);
    expect(mails[0]).toMatchObject({ to: "ap@acme.example", subject: "Document to review: Invoice from ACME" });
    expect(mails[0]!.text).toContain(`/#/reviews/${pending.documentId}`);

    // The Portal: the list, the document, its file.
    expect((await app.inject({ method: "GET", url: "/api/documents/summary" })).json()).toEqual({ pending: 1 });
    const list = (await app.inject({ method: "GET", url: "/api/documents?status=pending" })).json();
    expect(list[0]).toMatchObject({ id: pending.documentId, title: "Invoice from ACME", hasFile: true, fieldCount: 9 });
    const file = await app.inject({ method: "GET", url: `/api/documents/${pending.documentId}/file` });
    expect(file.headers["content-type"]).toBe("application/pdf");
    expect(file.rawPayload.equals(PDF)).toBe(true);

    // Wrong types are refused; a reject needs a reason.
    const bad = await app.inject({ method: "POST", url: `/api/documents/${pending.documentId}/approve`, payload: { fields: { total: "about a thousand" } } });
    expect(bad.json().error).toBe("total must be a number");
    expect((await app.inject({ method: "POST", url: `/api/documents/${pending.documentId}/reject`, payload: {} })).statusCode).toBe(400);

    const approved = await app.inject({ method: "POST", url: `/api/documents/${pending.documentId}/approve`, payload: { fields: { total: "1,108.00" } } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ status: "approved", corrected: ["total"], final: { total: 1108 } });
    expect((await app.inject({ method: "POST", url: `/api/documents/${pending.documentId}/approve`, payload: {} })).statusCode).toBe(409);

    // The waiting workflow sees the result.
    const result = (await app.inject({ method: "GET", url: `/api/agent/documents/${pending.documentId}?agentId=${agentId}`, headers: agentKey })).json();
    expect(result).toMatchObject({ status: "approved", fields: { total: 1108, supplier: "the supplier" }, reviewedBy: expect.any(String) });
  });

  it("needs no review when AI is sure (or review is never), and hands over to a process", async () => {
    const { agentId } = await setup();
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Book invoice" } })).json();
    await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, payload: {} });

    const sure = (await send(agentId, { documentType: "custom", fields: "supplier\ninvoiceDate:date - the date on the invoice", thenProcess: "book invoice" })).json();
    expect(sure).toMatchObject({ status: "auto", unsure: [] });
    const doc = store.data.documents[sure.documentId]!;
    const job = store.data.jobs[doc.thenJobId!]!;
    expect(job.name).toBe("Book invoice");
    expect(job.inputs.document).toMatchObject({ status: "auto", fields: { supplier: "the supplier", invoiceDate: "2026-09-01" } });

    const never = (await send(agentId, { documentType: "invoice", review: "never" })).json();
    expect(never.status).toBe("auto");
    const always = (await send(agentId, { documentType: "custom", fields: "supplier", review: "always" })).json();
    expect(always.status).toBe("pending");
  });

  it("refuses files that are not documents, and field lists it cannot read", async () => {
    const { agentId } = await setup();
    expect((await send(agentId, {}, "text/plain", Buffer.from("hi"))).statusCode).toBe(415);
    const res = await send(agentId, { documentType: "custom", fields: "total amount!!" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Cannot read the field "total amount!!"');
    expect((await send(agentId, { documentType: "custom" })).json().error).toContain("Say which fields");
  });

  it("deletes the files of documents done long ago, and keeps their fields", async () => {
    const { agentId } = await setup();
    const doc = (await send(agentId, { review: "never" })).json();
    store.data.documents[doc.documentId]!.doneAt = "2020-01-01T00:00:00.000Z";
    await app.inject({ method: "GET", url: "/api/health" });
    (app as unknown as { documentsSweep: () => void }).documentsSweep();
    expect(files.read(doc.documentId)).toBeUndefined();
    const kept = (await app.inject({ method: "GET", url: `/api/documents/${doc.documentId}` })).json();
    expect(kept).toMatchObject({ hasFile: false, result: { fields: { total: 1180 } } });
    expect((await app.inject({ method: "GET", url: `/api/documents/${doc.documentId}/file` })).statusCode).toBe(404);
  });
});

describe("numbers as people type them", () => {
  it("reads the usual ways of writing amounts", () => {
    expect(parseNumber("1,108.00")).toBe(1108);
    expect(parseNumber("1.108,00")).toBe(1108);
    expect(parseNumber("1 108,50")).toBe(1108.5);
    expect(parseNumber("1'108.5")).toBe(1108.5);
    expect(parseNumber("1108,5")).toBe(1108.5);
    expect(parseNumber("1,108")).toBe(1108);
    expect(parseNumber("12,5")).toBe(12.5);
    expect(parseNumber("$ 1,234,567.89")).toBe(1234567.89);
    expect(parseNumber("-42")).toBe(-42);
    expect(parseNumber("about a thousand")).toBeNaN();
  });
});
