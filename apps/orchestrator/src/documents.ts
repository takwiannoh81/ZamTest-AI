/**
 * Document processing with human review.
 *
 * A bot PC sends a document (PDF, scan or photo) and the fields to read; the
 * server has AI read them, with how sure it is of each (AI runs here, where the
 * key is, and counts as one of the plan's AI requests). When the workflow asks for
 * it (always, or when AI is unsure of a field) a person checks the document in the
 * Portal (Reviews): corrects the fields, then approves or rejects it. The workflow
 * either waits for that, or hands over: a process named in the step starts with
 * the result.
 *
 * The files are kept next to the database (<data dir>/documents/<id>), and deleted
 * DOCUMENT_DAYS after the document was done; the record (with the fields) stays.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DOCUMENT_MEDIA_TYPES, DOCUMENT_PRESETS, parseFieldList } from "@zamtest/ai";
import type { DocumentField, ZamAI } from "@zamtest/ai";
import { effectiveEnv, isIn } from "./cicd.js";
import { HttpError, parse } from "./errors.js";
import { createJob } from "./jobs.js";
import type { Mailer } from "./mailer.js";
import { useAi } from "./plans.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { Agent, DocumentTask, Principal } from "./types.js";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const safeId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** The document files: on disk next to the database, or in memory (tests). */
export class DocumentFiles {
  private readonly root: string | null;
  private readonly memory = new Map<string, Buffer>();

  constructor(dataDir: string | null) {
    this.root = dataDir ? join(dataDir, "documents") : null;
    if (this.root) mkdirSync(this.root, { recursive: true });
  }

  save(id: string, data: Buffer): void {
    if (!safeId(id)) throw new Error("Bad document id");
    if (this.root) writeFileSync(join(this.root, id), data);
    else this.memory.set(id, data);
  }

  read(id: string): Buffer | undefined {
    if (!safeId(id)) return undefined;
    if (!this.root) return this.memory.get(id);
    const file = join(this.root, id);
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  delete(id: string): void {
    if (!safeId(id)) return;
    if (this.root) rmSync(join(this.root, id), { force: true });
    else this.memory.delete(id);
  }

  /** Files without a document (uploaded, but the step never finished). */
  ids(): string[] {
    return this.root ? readdirSync(this.root) : [...this.memory.keys()];
  }
}

export interface DocumentContext {
  store: Store;
  files: DocumentFiles;
  getAi(): ZamAI;
  mailer?: Mailer | null;
  portalUrl: string;
  /** Days a document's file is kept after it is done. */
  keepDays: number;
  me(req: FastifyRequest): Principal;
  own<T extends { workspaceId: string }>(collection: Record<string, T>, id: string, what: string, req: FastifyRequest): T;
  mine<T extends { workspaceId: string }>(collection: Record<string, T>, req: FastifyRequest): T[];
  agentFor(req: FastifyRequest): Agent;
  who(p: Principal): string;
  log?: (message: string) => void;
}

const ProcessBody = z.object({
  fileId: z.string().regex(/^doc_[A-Za-z0-9]+$/),
  jobId: z.string().optional(),
  name: z.string().trim().min(1).max(300),
  documentType: z.string().trim().max(60).default("invoice"),
  fields: z.string().max(5000).optional(),
  instructions: z.string().max(4000).optional(),
  review: z.enum(["when unsure", "always", "never"]).default("when unsure"),
  threshold: z.number().min(0).max(1).default(0.9),
  title: z.string().trim().max(300).optional(),
  notify: z.string().trim().max(1000).optional(),
  thenProcess: z.string().trim().max(200).optional(),
  language: z.string().optional(),
});

type Value = string | number | boolean | null;

/** What a workflow gets back, and what a process started after the review gets. */
export function documentResult(d: DocumentTask) {
  return {
    documentId: d.id,
    status: d.status,
    documentType: d.result.documentType,
    summary: d.result.summary,
    fields: d.final ?? d.result.fields,
    confidence: d.result.confidence,
    unsure: d.unsure,
    reviewedBy: d.reviewedBy,
    comment: d.comment,
    name: d.name,
  };
}

/**
 * A number as people type it: "1,108.00", "1.108,00", "1 108,50", "1'108.5" or "1108".
 * With both separators the last one is the decimal point; a lone comma followed by
 * exactly three digits groups thousands, else it is the decimal point.
 */
export function parseNumber(text: string): number {
  let t = text.trim().replace(/[\s'\u00a0\u202f]/g, "").replace(/^[^\d+-]+|[^\d]+$/g, "");
  const comma = t.lastIndexOf(",");
  const dot = t.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) t = comma > dot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (comma >= 0) t = /^[+-]?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  return t ? Number(t) : NaN;
}

/** Checks a person's corrections against the fields' types. */
function checkedFields(spec: DocumentField[], values: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const field of spec) {
    const raw = values[field.name];
    if (raw === undefined || raw === null || raw === "") {
      out[field.name] = null;
      continue;
    }
    if (field.type === "number") {
      const n = typeof raw === "number" ? raw : parseNumber(String(raw));
      if (!Number.isFinite(n)) throw new HttpError(400, `${field.name} must be a number`);
      out[field.name] = n;
    } else if (field.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw new HttpError(400, `${field.name} must be a date (YYYY-MM-DD)`);
      out[field.name] = String(raw);
    } else if (field.type === "boolean") out[field.name] = raw === true || raw === "true";
    else out[field.name] = String(raw);
  }
  return out;
}

export function registerDocuments(app: FastifyInstance, ctx: DocumentContext) {
  const { store, files } = ctx;
  const log = ctx.log ?? (() => undefined);

  /** Starts the process named in the step, with the result. */
  const handOver = (d: DocumentTask) => {
    if (!d.thenProcess || d.status === "pending" || d.thenJobId) return;
    const env = effectiveEnv(store, d.workspaceId, undefined);
    const pkg = Object.values(store.data.packages)
      .filter((p) => p.workspaceId === d.workspaceId && p.name.toLowerCase() === d.thenProcess!.toLowerCase() && isIn(p, env))
      .sort((a, b) => b.version - a.version)[0];
    try {
      if (!pkg) throw new Error(`There is no published process called "${d.thenProcess}"`);
      const job = createJob(store, { workspaceId: d.workspaceId, packageId: pkg.id, inputs: { document: documentResult(d) }, source: "trigger", startedBy: `document: ${d.name}` });
      d.thenJobId = job.id;
    } catch (err) {
      d.thenError = err instanceof Error ? err.message : String(err);
      log(`Document ${d.id}: could not start "${d.thenProcess}": ${d.thenError}`);
    }
  };

  const notify = (d: DocumentTask) => {
    if (!ctx.mailer || !d.notify?.length) return;
    const link = `${ctx.portalUrl}/#/reviews/${d.id}`;
    const title = d.title || d.name;
    void ctx.mailer
      .send({
        to: d.notify.join(", "),
        subject: `Document to review: ${title}`,
        text: `A document is waiting for you to check it in ZamTech AI.\n\n${title}\n${d.result.summary}\n\nFields to check: ${d.unsure.join(", ") || "all"}\n\nOpen it: ${link}\n`,
      })
      .catch((err: Error) => log(`Document ${d.id}: the review email could not be sent: ${err.message}`));
  };

  /* ----------------------------- the bot PC ----------------------------- */
  app.register(async (scope) => {
    for (const type of DOCUMENT_MEDIA_TYPES) {
      scope.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: MAX_DOCUMENT_BYTES }, (_req, body, done) => done(null, body));
    }
    /** The file first; then the step says what to read from it. */
    scope.post("/api/agent/documents/file", async (req, reply) => {
      ctx.agentFor(req);
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
      if (!DOCUMENT_MEDIA_TYPES.includes(type)) throw new HttpError(415, "Documents must be PDF, PNG, JPEG, GIF or WebP files");
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, "The file is empty");
      const id = newId("doc");
      files.save(id, data);
      pendingFiles.set(id, { type, size: data.length, at: Date.now() });
      return reply.status(201).send({ fileId: id });
    });
  });
  /** Uploaded files not used by a step yet (their type), for up to an hour. */
  const pendingFiles = new Map<string, { type: string; size: number; at: number }>();

  app.post("/api/agent/documents", async (req) => {
    const agent = ctx.agentFor(req);
    const body = parse(ProcessBody, req.body);
    const file = pendingFiles.get(body.fileId);
    const data = files.read(body.fileId);
    if (!file || !data) throw new HttpError(404, "The document file was not found; send it again");
    pendingFiles.delete(body.fileId);
    const preset = DOCUMENT_PRESETS[body.documentType.toLowerCase()];
    let fields: DocumentField[];
    try {
      fields = parseFieldList(body.fields?.trim() ? body.fields : (preset ?? ""));
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (!fields.length) throw new HttpError(400, "Say which fields to read (Fields), or choose a document type");
    const ai = ctx.getAi();
    useAi(store, agent.workspaceId);
    const job = body.jobId ? store.data.jobs[body.jobId] : undefined;
    const result = await ai.readDocument({
      data,
      mediaType: file.type,
      fields,
      instructions: body.instructions,
      language: body.language,
    });
    const unsure = fields.filter((f) => (result.confidence[f.name] ?? 0) < body.threshold || result.fields[f.name] === null).map((f) => f.name);
    const needsReview = body.review === "always" || (body.review === "when unsure" && unsure.length > 0);
    const doc: DocumentTask = {
      id: body.fileId,
      workspaceId: agent.workspaceId,
      jobId: job?.workspaceId === agent.workspaceId ? job.id : undefined,
      processName: job?.name,
      name: body.name,
      mediaType: file.type,
      size: file.size,
      title: body.title,
      fields,
      result,
      review: body.review,
      threshold: body.threshold,
      unsure,
      status: needsReview ? "pending" : "auto",
      notify: body.notify ? body.notify.split(/[,;\s]+/).filter((e) => e.includes("@")) : undefined,
      thenProcess: body.thenProcess || undefined,
      createdAt: nowIso(),
      doneAt: needsReview ? undefined : nowIso(),
    };
    store.data.documents[doc.id] = doc;
    if (needsReview) notify(doc);
    else handOver(doc);
    store.save();
    return documentResult(doc);
  });

  /** The workflow waiting for the review asks how it is going. */
  app.get<{ Params: { id: string } }>("/api/agent/documents/:id", async (req) => {
    const agent = ctx.agentFor(req);
    const doc = store.data.documents[req.params.id];
    if (!doc || doc.workspaceId !== agent.workspaceId) throw new HttpError(404, "Document not found");
    return documentResult(doc);
  });

  /* ------------------------------ the Portal ------------------------------ */
  const listView = ({ result, fields, ...d }: DocumentTask) => ({
    ...d,
    documentType: result.documentType,
    summary: result.summary,
    fieldCount: fields.length,
    hasFile: !d.fileDeletedAt,
  });
  app.get<{ Querystring: { status?: string } }>("/api/documents", async (req) => {
    const wanted = req.query.status;
    return ctx
      .mine(store.data.documents, req)
      .filter((d) => !wanted || (wanted === "pending" ? d.status === "pending" : d.status !== "pending"))
      .sort((a, b) => (wanted === "pending" ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt)))
      .slice(0, 500)
      .map(listView);
  });
  app.get("/api/documents/summary", async (req) => ({ pending: ctx.mine(store.data.documents, req).filter((d) => d.status === "pending").length }));
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const doc = ctx.own(store.data.documents, req.params.id, "Document", req);
    return { ...doc, hasFile: !doc.fileDeletedAt };
  });
  app.get<{ Params: { id: string } }>("/api/documents/:id/file", async (req, reply) => {
    const doc = ctx.own(store.data.documents, req.params.id, "Document", req);
    const data = files.read(doc.id);
    if (!data) throw new HttpError(404, "The document's file is no longer kept");
    return reply
      .header("content-type", doc.mediaType)
      .header("content-disposition", `inline; filename="${doc.name.replace(/[^\w.\- ]/g, "_")}"`)
      .header("cache-control", "private, no-store")
      .send(data);
  });

  const Decision = z.object({ fields: z.record(z.unknown()).default({}), comment: z.string().trim().max(2000).optional() });
  const decide = (req: FastifyRequest, status: "approved" | "rejected") => {
    const doc = ctx.own(store.data.documents, (req.params as { id: string }).id, "Document", req);
    if (doc.status !== "pending") throw new HttpError(409, `This document was already ${doc.status === "auto" ? "processed without review" : doc.status}`);
    const body = parse(Decision, req.body ?? {});
    if (status === "rejected" && !body.comment) throw new HttpError(400, "Say why the document is rejected");
    doc.final = checkedFields(doc.fields, { ...doc.result.fields, ...body.fields });
    doc.corrected = doc.fields.filter((f) => JSON.stringify(doc.final![f.name]) !== JSON.stringify(doc.result.fields[f.name] ?? null)).map((f) => f.name);
    doc.status = status;
    doc.comment = body.comment;
    doc.reviewedBy = ctx.who(ctx.me(req));
    doc.reviewedAt = doc.doneAt = nowIso();
    handOver(doc);
    store.save();
    return { ...doc, hasFile: !doc.fileDeletedAt };
  };
  app.post<{ Params: { id: string } }>("/api/documents/:id/approve", async (req) => decide(req, "approved"));
  app.post<{ Params: { id: string } }>("/api/documents/:id/reject", async (req) => decide(req, "rejected"));

  /** Files of documents done more than keepDays ago, and uploads never used, are deleted. */
  const sweep = (now = Date.now()) => {
    const cutoff = new Date(now - ctx.keepDays * 86_400_000).toISOString();
    for (const doc of Object.values(store.data.documents)) {
      if (doc.doneAt && doc.doneAt < cutoff && !doc.fileDeletedAt) {
        files.delete(doc.id);
        doc.fileDeletedAt = nowIso();
        store.save();
      }
    }
    for (const [id, file] of pendingFiles) {
      if (now - file.at > 3_600_000) {
        pendingFiles.delete(id);
        if (!store.data.documents[id]) files.delete(id);
      }
    }
  };
  return { sweep };
}
