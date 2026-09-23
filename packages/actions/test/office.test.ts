import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { parseWorkflow, runWorkflow } from "@zamtest/core";
import { builtinHandlers } from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "zamtech-"));
const step = (id: string, type: string, props: Record<string, unknown>) => ({ id, type, props });
const run = (steps: ReturnType<typeof step>[], variables: unknown[] = [], services = {}) =>
  runWorkflow(parseWorkflow({ id: "t", name: "t", variables, root: { id: "r", type: "core.sequence", props: {}, slots: { body: steps } } }), {
    handlers: builtinHandlers,
    services,
  });

describe("Excel and CSV", () => {
  it("round-trips rows through xlsx and appends by header", async () => {
    const path = join(dir, "out/invoices.xlsx");
    const result = await run(
      [
        step("w", "excel.write", { path, sheet: "Invoices", rows: '[{ number: "A-1", total: 120 }, { number: "A-2", total: 80.5 }]' }),
        step("a", "excel.write", { path, sheet: "Invoices", rows: '[{ total: 10, number: "A-3" }]', append: true }),
        step("r", "excel.read", { path, sheet: "Invoices", output: "rows" }),
      ],
      [{ name: "rows", direction: "out" }],
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs.rows).toEqual([
      { number: "A-1", total: 120 },
      { number: "A-2", total: 80.5 },
      { number: "A-3", total: 10 },
    ]);
  });

  it("writes and reads CSV with a custom delimiter", async () => {
    const path = join(dir, "people.csv");
    const result = await run(
      [
        step("w", "csv.write", { path, delimiter: ";", rows: '[{ name: "Ada", city: "London" }, { name: "Grace; H.", city: "NYC" }]' }),
        step("r", "csv.read", { path, delimiter: ";", output: "rows" }),
      ],
      [{ name: "rows", direction: "out" }],
    );
    expect(result.outputs.rows).toEqual([
      { name: "Ada", city: "London" },
      { name: "Grace; H.", city: "NYC" },
    ]);
  });
});

describe("PDF", () => {
  it("merges PDFs and extracts their text", async () => {
    const make = async (file: string, text: string) => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.addPage().drawText(text, { x: 50, y: 700, size: 14, font });
      writeFileSync(join(dir, file), await doc.save());
      return join(dir, file);
    };
    const a = await make("a.pdf", "Invoice number INV-42");
    const b = await make("b.pdf", "Total due 1,250.00 EUR");
    const merged = join(dir, "merged.pdf");
    const result = await run(
      [
        step("m", "pdf.merge", { files: JSON.stringify([a, b]), path: merged }),
        step("t", "pdf.readText", { path: merged, output: "text" }),
      ],
      [{ name: "text", direction: "out" }],
    );
    expect(result.error).toBeUndefined();
    expect(result.outputs.text).toContain("INV-42");
    expect(result.outputs.text).toContain("1,250.00 EUR");
  });
});

describe("Email and queues without an orchestrator", () => {
  it("explains what is missing", async () => {
    const mail = await run([step("e", "email.send", { server: "smtp.example.com:587", credential: "mail", to: "a@b.c", subject: "s", body: "b" })]);
    expect(mail.error).toMatch(/credential asset/);
    const q = await run([step("q", "queue.getNext", { queue: "invoices", output: "item" })]);
    expect(q.error).toMatch(/orchestrator/);
  });
});
