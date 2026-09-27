import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ActionContext, ActionHandler } from "@zamtest/core";

/** What the server answers for a document. */
export interface DocumentResult {
  documentId: string;
  status: "pending" | "approved" | "rejected" | "auto";
  documentType: string;
  summary: string;
  fields: Record<string, unknown>;
  confidence: Record<string, number>;
  unsure: string[];
  reviewedBy?: string;
  comment?: string;
  name: string;
}

/** The orchestrator reads documents with AI and keeps their reviews. */
export interface DocumentService {
  process(input: {
    data: Buffer;
    mediaType: string;
    name: string;
    documentType: string;
    fields?: string;
    instructions?: string;
    review: string;
    threshold: number;
    title?: string;
    notify?: string;
    thenProcess?: string;
  }): Promise<DocumentResult>;
  get(id: string): Promise<DocumentResult>;
}

const TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const MAX_BYTES = 20 * 1024 * 1024;
/** How often a waiting workflow asks whether the review is done. */
export const REVIEW_POLL_MS = Number(process.env.ZAMTEST_REVIEW_POLL_MS) || 5_000;

function documents(ctx: ActionContext): DocumentService {
  const service = ctx.services.documents as DocumentService | undefined;
  if (!service) throw new Error("Processing documents needs the orchestrator (it reads them with AI and keeps the reviews)");
  return service;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    }, { once: true });
  });

export const documentHandlers: Record<string, ActionHandler> = {
  "doc.process": async (props, ctx) => {
    const path = String(props.path ?? "");
    const mediaType = TYPES[extname(path).toLowerCase()];
    if (!mediaType) throw new Error(`Documents must be PDF, PNG, JPEG, GIF or WebP files: ${basename(path)}`);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`File not found: ${path}`);
    if (info.size > MAX_BYTES) throw new Error(`${basename(path)} is larger than 20 MB`);
    const service = documents(ctx);
    const title = props.title ? String(props.title) : undefined;
    ctx.log("info", `Reading ${basename(path)} with AI`);
    let result = await service.process({
      data: await readFile(path),
      mediaType,
      name: basename(path),
      documentType: String(props.documentType ?? "invoice"),
      fields: props.fields ? String(props.fields) : undefined,
      instructions: props.instructions ? String(props.instructions) : undefined,
      review: String(props.review ?? "when unsure"),
      threshold: Number(props.threshold ?? 0.9),
      title,
      notify: props.notify ? String(props.notify) : undefined,
      thenProcess: props.thenProcess ? String(props.thenProcess) : undefined,
    });
    if (result.status === "auto") {
      ctx.log("info", `Read ${Object.keys(result.fields).length} fields; no review needed`);
      return result;
    }
    ctx.log("info", `Waiting for a person to review it in the Portal (Reviews)${result.unsure.length ? `; to check: ${result.unsure.join(", ")}` : ""}`);
    ctx.emit("documentReview", { documentId: result.documentId });
    // Handed over: the process named in the step continues with the result.
    if (props.thenProcess) return result;
    const minutes = Number(props.waitMinutes ?? 60);
    const until = Date.now() + minutes * 60_000;
    while (result.status === "pending") {
      if (Date.now() > until) throw new Error(`The document was not reviewed within ${minutes} minutes. It stays in Reviews in the Portal.`);
      await sleep(REVIEW_POLL_MS, ctx.signal);
      result = await service.get(result.documentId);
    }
    ctx.log("info", `Reviewed by ${result.reviewedBy ?? "?"}: ${result.status}${result.comment ? ` (${result.comment})` : ""}`);
    return result;
  },
};
