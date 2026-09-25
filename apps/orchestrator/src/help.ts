/**
 * Docs and the help assistant. The docs are written in English (docs/content.ts);
 * the first time a section is read in another language it is translated with AI
 * once and kept (next to the database), so later readers get it at once. A
 * section is translated again only when its English text changes.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocText, ZamAI } from "@zamtest/ai";
import { languageName, LOCALES } from "@zamtest/i18n";
import { DOCS } from "./docs/content.js";
import type { DocSection } from "./docs/content.js";
import { HttpError, parse } from "./errors.js";
import type { Store } from "./store.js";
import { nowIso } from "./store.js";
import type { Principal } from "./types.js";

/** Help questions per person per day (they do not use the plan's AI requests). */
export const HELP_QUESTIONS_PER_DAY = 30;
/** Sections translated at the same time when a language is first opened. */
const PARALLEL_TRANSLATIONS = 3;

type Cached = DocText & { hash: string };

export interface HelpContext {
  store: Store;
  dataDir: string | null;
  supportEmail?: string;
  /** The AI, or undefined when this server has none (the docs are then shown in English). */
  ai(): ZamAI | undefined;
  me(req: FastifyRequest): Principal;
}

const hashOf = (s: DocSection) => createHash("sha256").update(`${s.title}\n${s.summary}\n${s.body}`).digest("hex").slice(0, 16);

/** The whole documentation as one Markdown text, for the help assistant. */
export const DOCS_TEXT = DOCS.map((s) => `# ${s.title}\n\n${s.body}`).join("\n\n");

export function registerHelp(app: FastifyInstance, ctx: HelpContext): void {
  const file = ctx.dataDir ? join(ctx.dataDir, "docs-translations.json") : null;
  let cache: Record<string, Record<string, Cached>> = {};
  try {
    if (file && existsSync(file)) cache = JSON.parse(readFileSync(file, "utf8")) as typeof cache;
  } catch {
    cache = {};
  }
  const persist = () => {
    try {
      if (file) writeFileSync(file, JSON.stringify(cache));
    } catch {
      /* the translations are made again when needed */
    }
  };

  const localeOf = (lang: unknown): string => {
    const wanted = String(lang ?? "en");
    return LOCALES.some((l) => l.code === wanted) ? wanted : "en";
  };
  const translated = (lang: string, s: DocSection): Cached | undefined => {
    const hit = cache[lang]?.[s.id];
    return hit && hit.hash === hashOf(s) ? hit : undefined;
  };

  /** One translation at a time per section and language, however many people ask. */
  const inFlight = new Map<string, Promise<Cached | undefined>>();
  const translate = (lang: string, s: DocSection): Promise<Cached | undefined> => {
    const done = translated(lang, s);
    if (done) return Promise.resolve(done);
    const ai = ctx.ai();
    if (!ai) return Promise.resolve(undefined);
    const key = `${lang}:${s.id}`;
    let running = inFlight.get(key);
    if (!running) {
      running = ai
        .translateDoc({ title: s.title, summary: s.summary, body: s.body, language: languageName(lang) })
        .then((t) => {
          const entry: Cached = { ...t, hash: hashOf(s) };
          (cache[lang] ??= {})[s.id] = entry;
          persist();
          return entry;
        })
        .catch((err: unknown) => {
          app.log.warn(`Could not translate docs section ${s.id} into ${lang}: ${err instanceof Error ? err.message : err}`);
          return undefined;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, running);
    }
    return running;
  };

  /** A language opened for the first time: its sections are translated in the background, a few at a time. */
  const warming = new Set<string>();
  const warm = (lang: string) => {
    if (lang === "en" || warming.has(lang) || !ctx.ai()) return;
    const missing = DOCS.filter((s) => !translated(lang, s));
    if (!missing.length) return;
    warming.add(lang);
    const queue = [...missing];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) await translate(lang, s);
    };
    void Promise.all(Array.from({ length: PARALLEL_TRANSLATIONS }, worker)).finally(() => warming.delete(lang));
  };

  const view = (lang: string, s: DocSection) => {
    const t = lang === "en" ? undefined : translated(lang, s);
    return { id: s.id, title: t?.title ?? s.title, summary: t?.summary ?? s.summary, translated: lang === "en" || Boolean(t) };
  };

  /** The list of sections, in the language where translated (the rest in English while it is being translated). */
  app.get<{ Querystring: { lang?: string } }>("/api/docs", async (req) => {
    const lang = localeOf(req.query.lang);
    warm(lang);
    const sections = DOCS.map((s) => view(lang, s));
    return {
      language: lang,
      // The page asks again while this is true.
      translating: lang !== "en" && Boolean(ctx.ai()) && sections.some((s) => !s.translated),
      sections,
    };
  });

  /** One section; translated now when it is not yet (a few seconds, once per language). */
  app.get<{ Params: { id: string }; Querystring: { lang?: string } }>("/api/docs/:id", async (req) => {
    const lang = localeOf(req.query.lang);
    const section = DOCS.find((s) => s.id === req.params.id);
    if (!section) throw new HttpError(404, "No such docs section");
    const t = lang === "en" ? undefined : await translate(lang, section);
    return { id: section.id, title: t?.title ?? section.title, summary: t?.summary ?? section.summary, body: t?.body ?? section.body, translated: lang === "en" || Boolean(t) };
  });

  /** The help assistant. */
  app.post("/api/help/chat", async (req) => {
    const ai = ctx.ai();
    if (!ai) throw new HttpError(503, "The help assistant is not set up on this server");
    const body = parse(
      z.object({
        messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) })).min(1).max(20),
        language: z.string().optional(),
        where: z.string().max(200).optional(),
      }),
      req.body,
    );
    if (body.messages.at(-1)!.role !== "user") throw new HttpError(400, "The last message must be the question");
    const p = ctx.me(req);
    const who = `${p.kind}:${p.id}`;
    const day = nowIso().slice(0, 10);
    const used = ctx.store.data.helpUsage[who];
    const count = used?.day === day ? used.count : 0;
    if (count >= HELP_QUESTIONS_PER_DAY) {
      throw new HttpError(429, `You have asked ${HELP_QUESTIONS_PER_DAY} questions today, the daily limit. The docs are still open to you; ask again tomorrow.`);
    }
    ctx.store.data.helpUsage[who] = { day, count: count + 1 };
    ctx.store.save();
    const answer = await ai.answerHelp({
      docs: DOCS_TEXT,
      messages: body.messages,
      language: languageName(localeOf(body.language)),
      where: body.where,
      support: ctx.supportEmail,
    });
    return { answer, left: HELP_QUESTIONS_PER_DAY - count - 1 };
  });
}
