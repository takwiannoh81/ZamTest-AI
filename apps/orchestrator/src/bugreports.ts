/**
 * "Report a problem" in the Portal and the Designer: what happened, what the
 * person was doing, screenshots, and the details that help find it (page,
 * browser, recent errors). The platform owner is emailed, reads them on the
 * Bug reports page, and the person hears back when it is fixed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { LoginLimiter } from "./auth.js";
import { HttpError, parse } from "./errors.js";
import type { Mail } from "./mailer.js";
import { newId, nowIso } from "./store.js";
import type { Store } from "./store.js";
import type { BugReport, Principal } from "./types.js";

const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Screenshots of reports: files next to the database (in memory without one). */
export class BugReportFiles {
  private readonly root: string | null;
  private readonly memory = new Map<string, Buffer>();

  constructor(dataDir: string | null) {
    this.root = dataDir ? join(dataDir, "bug-reports") : null;
  }

  private key(id: string, n: number) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !Number.isInteger(n) || n < 0) throw new HttpError(400, "Bad image");
    return `${id}-${n}`;
  }

  write(id: string, n: number, ext: string, data: Buffer) {
    const key = this.key(id, n);
    if (!this.root) return void this.memory.set(key, data);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(join(this.root, `${key}.${ext}`), data);
  }

  read(id: string, n: number, ext: string): Buffer | undefined {
    const key = this.key(id, n);
    if (!this.root) return this.memory.get(key);
    const file = join(this.root, `${key}.${ext}`);
    return existsSync(file) ? readFileSync(file) : undefined;
  }
}

export interface BugReportContext {
  store: Store;
  files: BugReportFiles;
  me(req: FastifyRequest): Principal;
  isPlatformAdmin(p: Principal): boolean;
  portalUrl: string;
  supportEmail?: string;
  /** Sends an email when email is set up (errors are logged, never shown to the reporter). */
  notify(to: string, mail: Omit<Mail, "to">): void;
}

const ReportBody = z.object({
  kind: z.enum(["blocking", "annoying", "suggestion"]),
  what: z.string().trim().min(5, "Say what happened in a few words").max(5000),
  doing: z.string().trim().max(5000).optional(),
  context: z
    .object({
      app: z.enum(["portal", "designer"]),
      page: z.string().max(2000).optional(),
      where: z.string().max(300).optional(),
      userAgent: z.string().max(500).optional(),
      language: z.string().max(20).optional(),
      timeZone: z.string().max(64).optional(),
      screen: z.string().max(40).optional(),
      errors: z.array(z.object({ time: z.string().max(40), message: z.string().max(1000) })).max(20).default([]),
    })
    .strip(),
  images: z.array(z.object({ name: z.string().max(200), type: z.string().max(50), base64: z.string().max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8) })).max(MAX_IMAGES).default([]),
});

const KIND_TEXT: Record<BugReport["kind"], string> = { blocking: "Blocks my work", annoying: "Annoying", suggestion: "Suggestion" };

/** What the reporter sees of their own reports. */
const mineView = (r: BugReport) => ({ id: r.id, kind: r.kind, what: r.what, status: r.status, note: r.note, createdAt: r.createdAt, updatedAt: r.updatedAt });

export function registerBugReports(app: FastifyInstance, ctx: BugReportContext): void {
  const { store } = ctx;
  // Ten reports a person a day is plenty (it also keeps email from being flooded).
  const limiter = new LoginLimiter(10, 24 * 60 * 60 * 1000);
  const owner = (req: FastifyRequest) => {
    if (!ctx.isPlatformAdmin(ctx.me(req))) throw new HttpError(403, "Only the platform owner can see bug reports");
  };

  app.post("/api/bug-reports", async (req, reply) => {
    const p = ctx.me(req);
    const body = parse(ReportBody, req.body);
    if (limiter.blocked(`bug:${p.id}`)) throw new HttpError(429, "You sent many reports today; please try again tomorrow, or email us");
    const images: Array<{ name: string; type: string; ext: string; data: Buffer }> = [];
    for (const image of body.images) {
      const ext = IMAGE_TYPES[image.type];
      if (!ext) throw new HttpError(400, `"${image.name}" is not a picture (PNG, JPEG, WebP or GIF)`);
      const data = Buffer.from(image.base64, "base64");
      if (data.length > MAX_IMAGE_BYTES) throw new HttpError(400, `"${image.name}" is larger than 4 MB`);
      images.push({ name: image.name, type: image.type, ext, data });
    }
    const workspace = store.data.workspaces[p.workspaceId];
    const report: BugReport = {
      id: newId("bug"),
      workspaceId: p.workspaceId,
      workspaceName: workspace?.name ?? "",
      userId: p.kind === "user" ? p.id : undefined,
      reporter: p.kind === "user" ? `${p.name} <${p.email}>` : p.name,
      email: p.kind === "user" ? p.email : undefined,
      kind: body.kind,
      what: body.what,
      doing: body.doing || undefined,
      context: { ...body.context, ip: req.ip },
      images: images.map((i) => ({ name: i.name, type: i.type, ext: i.ext, bytes: i.data.length })),
      status: "new",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    images.forEach((image, n) => ctx.files.write(report.id, n, image.ext, image.data));
    store.data.bugReports[report.id] = report;
    store.save();
    limiter.fail(`bug:${p.id}`);

    // Tell the platform owner (the support address, or the owners' own).
    const to = ctx.supportEmail
      ? [ctx.supportEmail]
      : Object.values(store.data.users)
          .filter((u) => u.platformOwner && !u.disabled)
          .map((u) => u.email);
    const c = report.context;
    for (const address of to) {
      ctx.notify(address, {
        subject: `${report.kind === "blocking" ? "🔴" : report.kind === "annoying" ? "🟠" : "💡"} Bug report from ${report.workspaceName || report.reporter}: ${report.what.split("\n")[0]!.slice(0, 80)}`,
        text: [
          `${KIND_TEXT[report.kind]} - reported by ${report.reporter} (${report.workspaceName})`,
          "",
          "What happened:",
          report.what,
          ...(report.doing ? ["", "What they were doing:", report.doing] : []),
          "",
          `App: ${c.app}${c.where ? ` (${c.where})` : ""}`,
          ...(c.page ? [`Page: ${c.page}`] : []),
          ...(c.userAgent ? [`Browser: ${c.userAgent}`] : []),
          ...(c.errors.length ? ["", "Recent errors on the page:", ...c.errors.map((e) => `- ${e.time} ${e.message}`)] : []),
          ...(report.images.length ? ["", `${report.images.length} screenshot(s) attached in the Portal.`] : []),
          "",
          `Open it: ${ctx.portalUrl}/#/bug-reports?id=${report.id}`,
        ].join("\n"),
      });
    }
    return reply.status(201).send(mineView(report));
  });

  /** The person's own reports, newest first, with what the team said. */
  app.get("/api/bug-reports/mine", async (req) => {
    const p = ctx.me(req);
    return Object.values(store.data.bugReports)
      .filter((r) => r.workspaceId === p.workspaceId && (p.kind === "user" ? r.userId === p.id : r.reporter === p.name))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map(mineView);
  });

  /* ---------- the platform owner ---------- */
  app.get<{ Querystring: { status?: string } }>("/api/platform/bug-reports", async (req) => {
    owner(req);
    const status = req.query.status;
    return Object.values(store.data.bugReports)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 500);
  });

  app.get<{ Params: { id: string; n: string } }>("/api/platform/bug-reports/:id/images/:n", async (req, reply) => {
    owner(req);
    const report = store.data.bugReports[req.params.id];
    const n = Number(req.params.n);
    const image = report?.images[n];
    const data = image ? ctx.files.read(report.id, n, image.ext) : undefined;
    if (!report || !image || !data) throw new HttpError(404, "Screenshot not found");
    return reply.header("content-type", image.type).header("cache-control", "private, max-age=3600").send(data);
  });

  app.put<{ Params: { id: string } }>("/api/platform/bug-reports/:id", async (req) => {
    owner(req);
    const report = store.data.bugReports[req.params.id];
    if (!report) throw new HttpError(404, "Bug report not found");
    const body = parse(z.object({ status: z.enum(["new", "investigating", "fixed", "wontfix"]), note: z.string().trim().max(3000).nullish() }), req.body);
    const nowFixed = body.status === "fixed" && report.status !== "fixed";
    report.status = body.status;
    if (body.note !== undefined) report.note = body.note || undefined;
    report.updatedAt = nowIso();
    store.save();
    // The reporter hears back when it is fixed.
    if (nowFixed && report.email) {
      ctx.notify(report.email, {
        subject: "Fixed: the problem you reported in ZamTech AI",
        text: [
          `Hello,`,
          "",
          `Thank you for reporting this problem:`,
          `"${report.what.split("\n")[0]!.slice(0, 200)}"`,
          "",
          `It is fixed now.${report.note ? `\n\n${report.note}` : ""}`,
          "",
          `Your reports: ${ctx.portalUrl}/#/report`,
          "",
          "ZamTech AI",
        ].join("\n"),
      });
    }
    return report;
  });
}
