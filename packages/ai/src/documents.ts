/**
 * Document understanding: Claude reads a PDF (typed or scanned) or a photo of a
 * document and fills in the fields asked for. For each field it also says how
 * sure it is (0 to 1) and where on the document the value came from, so a person
 * only has to check what is uncertain.
 */
import type { AiClient } from "./client.js";
import { jsonOf } from "./client.js";

export type DocumentFieldType = "text" | "number" | "date" | "boolean";

export interface DocumentField {
  name: string;
  type: DocumentFieldType;
  /** What it is, in words (helps AI find it), e.g. "the total including tax". */
  description?: string;
}

export interface ReadDocumentInput {
  data: Buffer;
  /** application/pdf, image/png, image/jpeg, image/gif or image/webp. */
  mediaType: string;
  fields: DocumentField[];
  instructions?: string;
  /** English name of the language for the summary. */
  language?: string;
}

export interface ReadDocumentResult {
  documentType: string;
  summary: string;
  fields: Record<string, string | number | boolean | null>;
  /** 0 to 1 per field. */
  confidence: Record<string, number>;
  /** The text on the document each value was read from. */
  evidence: Record<string, string>;
}

export const DOCUMENT_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"];

const valueSchema = (type: DocumentFieldType) =>
  type === "number" ? { type: ["number", "null"] } : type === "boolean" ? { type: ["boolean", "null"] } : { type: ["string", "null"] };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function readDocument(ai: AiClient, input: ReadDocumentInput): Promise<ReadDocumentResult> {
  if (!DOCUMENT_MEDIA_TYPES.includes(input.mediaType)) throw new Error(`Documents must be PDF, PNG, JPEG, GIF or WebP files (this one is ${input.mediaType})`);
  if (!input.fields.length) throw new Error("Say which fields to read from the document");
  const schema = {
    type: "object",
    properties: {
      documentType: { type: "string", description: "What the document is, e.g. invoice, receipt, purchase order, letter" },
      summary: { type: "string", description: "One sentence about the document" },
      fields: {
        type: "object",
        properties: Object.fromEntries(
          input.fields.map((f) => [
            f.name,
            {
              type: "object",
              properties: {
                value: valueSchema(f.type),
                confidence: { type: "number", description: "0 to 1" },
                evidence: { type: "string", description: "The text on the document the value comes from, or empty" },
              },
              required: ["value", "confidence", "evidence"],
              additionalProperties: false,
            },
          ]),
        ),
        required: input.fields.map((f) => f.name),
        additionalProperties: false,
      },
    },
    required: ["documentType", "summary", "fields"],
    additionalProperties: false,
  };
  const list = input.fields
    .map((f) => `- ${f.name} (${f.type === "date" ? "date as YYYY-MM-DD" : f.type === "text" ? "text" : f.type})${f.description ? `: ${f.description}` : ""}`)
    .join("\n");
  const block =
    input.mediaType === "application/pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: input.data.toString("base64") } }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: input.mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: input.data.toString("base64") },
        };
  const message = await ai.create({
    max_tokens: 16000,
    system: `You read business documents (typed, scanned or photographed) for an automation platform, and a person checks what you are unsure of.
For each field give the value exactly as meant on the document, how sure you are, and the text you read it from.
Confidence: 0.95 or more when the value is printed clearly and there is no doubt which one is meant; 0.6 to 0.9 when it is hard to read,
there are several candidates, or you had to combine or compute it; below 0.5 when you are guessing. When the field is not on the document,
the value is null; its confidence is how sure you are that it is really missing. Never invent a value. Numbers without currency signs or
thousands separators; dates as YYYY-MM-DD.${input.language && input.language !== "English" ? ` Write the summary in ${input.language}.` : ""}`,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: [block, { type: "text", text: `${input.instructions ? `${input.instructions}\n\n` : ""}The fields to read:\n${list}` }] }],
  });
  const raw = jsonOf<{ documentType: string; summary: string; fields: Record<string, { value: unknown; confidence: number; evidence: string }> }>(message);

  const result: ReadDocumentResult = { documentType: raw.documentType, summary: raw.summary, fields: {}, confidence: {}, evidence: {} };
  for (const field of input.fields) {
    const got = raw.fields?.[field.name];
    let value = (got?.value ?? null) as string | number | boolean | null;
    let confidence = Math.min(1, Math.max(0, Number(got?.confidence ?? 0)));
    // A value of the wrong form is kept for the person to fix, but not trusted.
    if (value !== null && field.type === "date" && !(typeof value === "string" && DATE.test(value))) confidence = Math.min(confidence, 0.3);
    if (value !== null && field.type === "number" && typeof value !== "number") {
      const n = Number(String(value).replace(/[^\d.-]/g, ""));
      value = Number.isFinite(n) ? n : value;
      confidence = Math.min(confidence, 0.3);
    }
    result.fields[field.name] = value;
    result.confidence[field.name] = Math.round(confidence * 100) / 100;
    result.evidence[field.name] = (got?.evidence ?? "").slice(0, 300);
  }
  return result;
}

/**
 * "supplier, invoiceNumber, invoiceDate:date, total:number" (commas or lines;
 * "name: type - description" also works) as fields.
 */
export function parseFieldList(text: string): DocumentField[] {
  const fields: DocumentField[] = [];
  // One per line (descriptions may then have commas), or all on one line separated by commas.
  for (const part of text.includes("\n") ? text.split(/\n+/) : text.split(",")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*(text|string|number|date|boolean))?\s*(?:[-–]\s*(.+))?$/i.exec(part);
    if (!m) {
      if (part.trim()) throw new Error(`Cannot read the field "${part.trim()}": write name or name:type (text, number, date or boolean)`);
      continue;
    }
    const type = (m[2]?.toLowerCase() === "string" ? "text" : (m[2]?.toLowerCase() ?? "text")) as DocumentFieldType;
    if (!fields.some((f) => f.name === m[1])) fields.push({ name: m[1]!, type, description: m[3]?.trim() || undefined });
  }
  return fields;
}

/** Ready-made field lists. */
export const DOCUMENT_PRESETS: Record<string, string> = {
  invoice:
    "supplier - the company that sent the invoice, invoiceNumber, invoiceDate:date, dueDate:date, currency - e.g. USD or EUR, subtotal:number - before tax, tax:number, total:number - the total to pay, purchaseOrder - the customer's order number if shown",
  receipt: "merchant - the shop or company, date:date, currency, total:number - the amount paid, tax:number, paymentMethod - e.g. card or cash",
  "purchase order": "buyer - the company ordering, orderNumber, orderDate:date, deliveryDate:date, currency, total:number",
};
