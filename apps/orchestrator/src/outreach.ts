/**
 * Talking with people outside the product:
 * - the assistant on the public website (visitors without an account), limited per visitor and per day;
 * - product update emails the platform owner sends to customers, in each person's language, with a
 *   one-click unsubscribe (link and List-Unsubscribe header) and the company's postal address (US CAN-SPAM).
 */
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ZamAI } from "@zamtest/ai";
import { createTranslator, languageName, loadLocale, LOCALES } from "@zamtest/i18n";
import type { Locale } from "@zamtest/i18n";
import { HttpError, parse } from "./errors.js";
import { DOCS_TEXT } from "./help.js";
import type { Mailer } from "./mailer.js";
import type { Store } from "./store.js";
import { newId, nowIso } from "./store.js";
import type { Announcement, Principal, User } from "./types.js";
import { safeEqual } from "./auth.js";

/** Questions one visitor may ask the website assistant per day. */
export const VISITOR_QUESTIONS_PER_DAY = 15;
/** All visitors together per day, so the website cannot run up the AI bill. */
export const VISITOR_QUESTIONS_TOTAL_PER_DAY = 1000;
/** Pause between product update emails, to stay under the mail service's sending rate. */
const SEND_GAP_MS = 400;

export interface OutreachContext {
  store: Store;
  mailer?: Mailer;
  config: { portalUrl: string; siteUrl?: string; supportEmail?: string; companyAddress?: string };
  ai(): ZamAI | undefined;
  me(req: FastifyRequest): Principal;
  isPlatformAdmin(p: Principal): boolean;
  /** Plans and prices as text, for the website assistant. */
  pricingText(): Promise<string>;
  log: { warn(msg: string): void; info(msg: string): void };
}

const localeOf = (lang: unknown): Locale => (LOCALES.some((l) => l.code === lang) ? (lang as Locale) : "en");

/** Receives product update emails: verified, active, not unsubscribed. */
export const subscribed = (u: User) => !u.disabled && u.emailVerified !== false && u.productUpdates !== false;

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Simple Markdown (paragraphs, - lists, **bold**, [links](https://...)) as email HTML; everything else is text. */
export function emailHtml(markdown: string): string {
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, text: string, href: string) => `<a href="${href.replace(/"/g, "%22")}" style="color:#4f46e5">${text}</a>`);
  return markdown
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.length && lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        return `<ul style="padding-left:20px;margin:0 0 14px">${lines.map((l) => `<li style="margin:4px 0">${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      }
      if (/^#{1,3}\s/.test(block)) return `<h3 style="font-size:17px;margin:18px 0 8px">${inline(block.replace(/^#{1,3}\s+/, ""))}</h3>`;
      return `<p style="margin:0 0 14px;line-height:1.55">${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

export function registerOutreach(app: FastifyInstance, ctx: OutreachContext): void {
  const { store, config } = ctx;

  /* ------------------------- the website assistant ------------------------- */
  const visitors = new Map<string, { day: string; count: number }>();
  let total = { day: "", count: 0 };

  app.post("/api/public/chat", async (req) => {
    const ai = ctx.ai();
    if (!ai) throw new HttpError(503, "The assistant is not available right now");
    const body = parse(
      z.object({
        messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(16),
        language: z.string().optional(),
      }),
      req.body,
    );
    if (body.messages.at(-1)!.role !== "user") throw new HttpError(400, "The last message must be the question");
    const day = nowIso().slice(0, 10);
    const visitor = visitors.get(req.ip);
    const count = visitor?.day === day ? visitor.count : 0;
    if (count >= VISITOR_QUESTIONS_PER_DAY) throw new HttpError(429, "That is all the questions for today. Create a free account to keep going, or come back tomorrow.");
    if (total.day !== day) total = { day, count: 0 };
    if (total.count >= VISITOR_QUESTIONS_TOTAL_PER_DAY) throw new HttpError(429, "The assistant is busy today; please try again tomorrow.");
    visitors.set(req.ip, { day, count: count + 1 });
    total.count++;
    // Forget yesterday's visitors.
    if (visitors.size > 50_000) for (const [ip, v] of visitors) if (v.day !== day) visitors.delete(ip);

    const answer = await ai.answerHelp({
      docs: DOCS_TEXT,
      messages: body.messages,
      language: languageName(localeOf(body.language)),
      support: config.supportEmail,
      visitor: { pricing: await ctx.pricingText(), signupUrl: `${config.portalUrl}/?signup=1`, siteUrl: config.siteUrl },
    });
    return { answer };
  });

  /* --------------------------- product update emails --------------------------- */
  const secret = () => (store.data.secrets.unsubscribe ??= randomBytes(32).toString("hex"));
  const unsubscribeToken = (userId: string) => createHmac("sha256", secret()).update(`unsubscribe:${userId}`).digest("base64url").slice(0, 32);
  const unsubscribeUrl = (userId: string) => `${config.portalUrl}/api/public/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`;

  /** One email in the person's language (the announcement translated for it). */
  const compose = async (a: Pick<Announcement, "subject" | "body">, user: User, texts: { subject: string; body: string }) => {
    const lang = localeOf(user.language);
    const tr = createTranslator(lang, await loadLocale(lang));
    const unsubscribe = unsubscribeUrl(user.id);
    const footer = `${tr.t("updates.footer")} ${config.companyAddress ?? ""}`.trim();
    const html = `<!doctype html><html><body style="margin:0;background:#f6f7fb;padding:24px 12px;font-family:'Segoe UI',Arial,sans-serif;color:#1b1f2a">
<div style="max-width:600px;margin:0 auto">
<div style="background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">ZamTech AI</div>
<div style="background:#fff;padding:24px;border:1px solid #e2e5ee;border-top:0;border-radius:0 0 12px 12px">
<h2 style="font-size:20px;margin:0 0 16px">${escapeHtml(texts.subject)}</h2>
${emailHtml(texts.body)}
<p style="margin:22px 0 0"><a href="${config.portalUrl}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">${escapeHtml(tr.t("updates.open"))}</a></p>
</div>
<p style="color:#6a7185;font-size:12px;line-height:1.5;margin:16px 8px">${escapeHtml(footer)}<br><a href="${unsubscribe}" style="color:#6a7185">${escapeHtml(tr.t("updates.unsubscribe"))}</a></p>
</div></body></html>`;
    const text = `${texts.subject}\n\n${texts.body}\n\n${config.portalUrl}\n\n--\n${footer}\n${tr.t("updates.unsubscribe")}: ${unsubscribe}`;
    return {
      to: user.email,
      subject: texts.subject,
      text,
      html,
      headers: { "List-Unsubscribe": `<${unsubscribe}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
  };

  /** The announcement in a language: as written for English, else translated once (or as written, when it cannot be). */
  const inLanguage = async (a: Announcement, lang: Locale, cache: Map<string, { subject: string; body: string }>) => {
    if (!a.translate || lang === "en") return { subject: a.subject, body: a.body };
    const hit = cache.get(lang);
    if (hit) return hit;
    let texts = { subject: a.subject, body: a.body };
    try {
      const ai = ctx.ai();
      if (ai) {
        const t = await ai.translateDoc({ title: a.subject, summary: "-", body: a.body, language: languageName(lang) });
        texts = { subject: t.title, body: t.body };
      }
    } catch (err) {
      ctx.log.warn(`Product update: could not translate into ${lang}: ${(err as Error).message}`);
    }
    cache.set(lang, texts);
    return texts;
  };

  const requireOwner = (req: FastifyRequest) => {
    if (!ctx.isPlatformAdmin(ctx.me(req))) throw new HttpError(403, "Only the platform owner can do this");
  };
  const ready = () => {
    if (!ctx.mailer) throw new HttpError(503, "Email is not set up on this server (SMTP_URL)");
    if (!config.companyAddress) {
      throw new HttpError(409, "Set the company's postal address first (ZAMTEST_COMPANY_ADDRESS): the law requires it in marketing emails");
    }
  };
  const recipients = () => Object.values(store.data.users).filter(subscribed);

  app.get("/api/platform/announcements", async (req) => {
    requireOwner(req);
    return {
      subscribers: recipients().length,
      emailReady: Boolean(ctx.mailer),
      companyAddress: config.companyAddress ?? null,
      announcements: Object.values(store.data.announcements).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  });

  const AnnouncementBody = z.object({
    subject: z.string().trim().min(3).max(150),
    body: z.string().trim().min(10).max(20_000),
    translate: z.boolean().default(true),
  });

  /** A test email to the platform owner only (in their language). */
  app.post("/api/platform/announcements/test", async (req) => {
    requireOwner(req);
    ready();
    const body = parse(AnnouncementBody, req.body);
    const p = ctx.me(req);
    const user = p.kind === "user" ? store.data.users[p.id] : undefined;
    if (!user) throw new HttpError(400, "Sign in with your own account to get a test email");
    const draft: Announcement = { id: "test", ...body, createdAt: nowIso(), createdBy: "", status: "sending", recipients: 1, sent: 0, failed: 0 };
    await ctx.mailer!.send(await compose(draft, user, await inLanguage(draft, localeOf(user.language), new Map())));
    return { sentTo: user.email };
  });

  app.post("/api/platform/announcements", async (req, reply) => {
    requireOwner(req);
    ready();
    const body = parse(AnnouncementBody, req.body);
    if (Object.values(store.data.announcements).some((a) => a.status === "sending")) throw new HttpError(409, "An update is still being sent; wait until it finishes");
    const to = recipients();
    const p = ctx.me(req);
    const announcement: Announcement = {
      id: newId("ann"),
      ...body,
      createdAt: nowIso(),
      createdBy: p.email ? `${p.name} <${p.email}>` : p.name,
      status: "sending",
      recipients: to.length,
      sent: 0,
      failed: 0,
    };
    store.data.announcements[announcement.id] = announcement;
    store.save();
    // In the background, one at a time: the Portal shows the progress.
    void (async () => {
      const translations = new Map<string, { subject: string; body: string }>();
      for (const user of to) {
        try {
          if (subscribed(user)) {
            await ctx.mailer!.send(await compose(announcement, user, await inLanguage(announcement, localeOf(user.language), translations)));
            announcement.sent++;
          }
        } catch (err) {
          announcement.failed++;
          ctx.log.warn(`Product update to ${user.email} failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, SEND_GAP_MS));
      }
      announcement.status = "sent";
      announcement.finishedAt = nowIso();
      store.save();
      ctx.log.info(`Product update "${announcement.subject}": ${announcement.sent} sent, ${announcement.failed} failed`);
    })();
    return reply.status(202).send(announcement);
  });

  /* ------------------------------ unsubscribe ------------------------------ */
  const unsubscribe = (req: FastifyRequest<{ Querystring: { u?: string; t?: string } }>) => {
    const user = store.data.users[String(req.query.u ?? "")];
    if (!user || !safeEqual(String(req.query.t ?? ""), unsubscribeToken(user.id))) return undefined;
    if (user.productUpdates !== false) {
      user.productUpdates = false;
      store.save();
    }
    return user;
  };
  // Mail programs' one-click button (RFC 8058).
  app.post<{ Querystring: { u?: string; t?: string } }>("/api/public/unsubscribe", async (req, reply) => {
    if (!unsubscribe(req)) return reply.status(400).send({ error: "This unsubscribe link is not valid" });
    return { ok: true };
  });
  // The link in the email.
  app.get<{ Querystring: { u?: string; t?: string } }>("/api/public/unsubscribe", async (req, reply) => {
    const user = unsubscribe(req);
    const tr = createTranslator(localeOf(user?.language), await loadLocale(localeOf(user?.language)));
    const message = user ? tr.t("updates.unsubscribed") : tr.t("updates.badLink");
    reply.type("text/html; charset=utf-8");
    return `<!doctype html><html lang="${tr.locale}" dir="${tr.dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ZamTech AI</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f6f7fb;color:#1b1f2a;display:grid;place-items:center;min-height:90vh;margin:0">
<div style="background:#fff;border:1px solid #e2e5ee;border-radius:12px;padding:28px;max-width:440px;text-align:center">
<div style="font-weight:700;font-size:18px;margin-bottom:10px">ZamTech AI</div>
<p style="line-height:1.5">${escapeHtml(message)}</p>
<p><a href="${config.portalUrl}/#/settings" style="color:#4f46e5">${escapeHtml(tr.t("updates.manage"))}</a></p>
</div></body></html>`;
  });

  /* ------------------------ the person's own choice ------------------------ */
  app.get("/api/auth/me/preferences", async (req) => {
    const p = ctx.me(req);
    const user = p.kind === "user" ? store.data.users[p.id] : undefined;
    return { productUpdates: user ? user.productUpdates !== false : false, available: Boolean(user) };
  });
  app.put("/api/auth/me/preferences", async (req) => {
    const p = ctx.me(req);
    const user = p.kind === "user" ? store.data.users[p.id] : undefined;
    if (!user) throw new HttpError(400, "Only people with an account have email preferences");
    const body = parse(z.object({ productUpdates: z.boolean() }), req.body);
    user.productUpdates = body.productUpdates;
    store.save();
    return { productUpdates: body.productUpdates, available: true };
  });
}
