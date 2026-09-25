import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DocText, HelpChatInput, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DOCS } from "../src/docs/content.js";
import { HELP_QUESTIONS_PER_DAY } from "../src/help.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
const dirs: string[] = [];
afterEach(async () => {
  await app?.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const TOKEN = "master-token-0123456789abcdef";
const PASSWORD = "correct horse battery";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("docs and the help assistant", () => {
  it("translates the docs once per language and keeps them; the assistant answers from the docs with a daily limit", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "zt-help-"));
    dirs.push(dataDir);
    let translations = 0;
    let asked: HelpChatInput | undefined;
    const ai = {
      model: "test",
      translateDoc: async (d: DocText & { language: string }) => {
        translations++;
        return { title: `[${d.language}] ${d.title}`, summary: `[${d.language}] ${d.summary}`, body: `[${d.language}] ${d.body}` };
      },
      answerHelp: async (input: HelpChatInput) => ((asked = input), "Open **Bot Agents** and click **Download for Windows**."),
    } as unknown as ZamAI;
    const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_SUPPORT_EMAIL: "support@example.com" }), dataDir };
    ({ app } = await buildApp({ config, store: new Store(null), ai }));
    await app.inject({ method: "POST", url: "/api/users", headers: { authorization: `Bearer ${TOKEN}` }, payload: { email: "v@example.com", name: "Vi", role: "viewer", password: PASSWORD } });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "v@example.com", password: PASSWORD } });
    const viewer = { authorization: `Bearer ${login.json().token}` };

    // English straight away.
    const en = (await app.inject({ method: "GET", url: "/api/docs?lang=en", headers: viewer })).json();
    expect(en.sections).toHaveLength(DOCS.length);
    expect(en.translating).toBe(false);

    // German: translated in the background, a few at a time; the page asks again until done.
    const first = (await app.inject({ method: "GET", url: "/api/docs?lang=de", headers: viewer })).json();
    expect(first.translating).toBe(true);
    for (let i = 0; i < 50 && translations < DOCS.length; i++) await sleep(20);
    await sleep(20);
    const later = (await app.inject({ method: "GET", url: "/api/docs?lang=de", headers: viewer })).json();
    expect(later.translating).toBe(false);
    expect(later.sections[0].title).toBe(`[German] ${DOCS[0]!.title}`);
    const section = (await app.inject({ method: "GET", url: `/api/docs/${DOCS[1]!.id}?lang=de`, headers: viewer })).json();
    expect(section).toMatchObject({ translated: true, body: `[German] ${DOCS[1]!.body}` });
    // Kept: no translation again, and saved next to the database.
    expect(translations).toBe(DOCS.length);
    expect(JSON.parse(readFileSync(join(dataDir, "docs-translations.json"), "utf8")).de[DOCS[1]!.id].title).toBe(`[German] ${DOCS[1]!.title}`);
    // An unknown language is English.
    expect((await app.inject({ method: "GET", url: "/api/docs?lang=xx", headers: viewer })).json().language).toBe("en");

    // The assistant: any role, the whole docs as its source, in the person's language.
    const chat = (question: string) =>
      app.inject({ method: "POST", url: "/api/help/chat", headers: viewer, payload: { messages: [{ role: "user", content: question }], language: "ja", where: "the Portal" } });
    const answer = await chat("How do I connect a PC?");
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toEqual({ answer: "Open **Bot Agents** and click **Download for Windows**.", left: HELP_QUESTIONS_PER_DAY - 1 });
    expect(asked).toMatchObject({ language: "Japanese", where: "the Portal", support: "support@example.com" });
    expect(asked!.docs).toContain(DOCS[0]!.title);
    for (let i = 1; i < HELP_QUESTIONS_PER_DAY; i++) await chat("again?");
    const tooMany = await chat("one more?");
    expect(tooMany.statusCode).toBe(429);
  });

  it("shows the docs in English and says the assistant is not set up when the server has no AI", async () => {
    const config = { ...loadConfig({}), dataDir: null };
    ({ app } = await buildApp({ config, ai: null }));
    const de = (await app.inject({ method: "GET", url: "/api/docs?lang=de" })).json();
    expect(de).toMatchObject({ language: "de", translating: false });
    expect(de.sections[0]).toMatchObject({ title: DOCS[0]!.title, translated: false });
    expect(existsSync(join(tmpdir(), "docs-translations.json"))).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/help/chat", payload: { messages: [{ role: "user", content: "hi" }] } })).statusCode).toBe(503);
  });
});
