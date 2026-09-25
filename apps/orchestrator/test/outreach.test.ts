import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { DocText, HelpChatInput, ZamAI } from "@zamtest/ai";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail, Mailer } from "../src/mailer.js";
import { emailHtml, VISITOR_QUESTIONS_PER_DAY } from "../src/outreach.js";
import { Store } from "../src/store.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const owner = { authorization: `Bearer ${TOKEN}` };
const PASSWORD = "correct horse battery";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}

let asked: HelpChatInput | undefined;
const ai = {
  model: "test",
  answerHelp: async (input: HelpChatInput) => ((asked = input), "ZamTech AI automates web and Windows work. Start free!"),
  translateDoc: async (d: DocText & { language: string }) => ({ title: `[${d.language}] ${d.title}`, summary: "", body: `[${d.language}] ${d.body}` }),
} as unknown as ZamAI;

async function setup(env: Record<string, string>, mailer = new FakeMailer()) {
  const config = { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ...env }), dataDir: null };
  ({ app } = await buildApp({ config, store: new Store(null), ai, mailer }));
  return mailer;
}

describe("the website assistant", () => {
  it("answers visitors without an account, with plans and the sign-up link, a few questions per visitor", async () => {
    await setup({});
    const ask = () => app.inject({ method: "POST", url: "/api/public/chat", payload: { messages: [{ role: "user", content: "What does it cost?" }], language: "fr" } });
    const res = await ask();
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().answer).toContain("Start free");
    expect(asked).toMatchObject({ language: "French", visitor: { signupUrl: "http://localhost:5173/?signup=1" } });
    expect(asked!.visitor!.pricing).toContain("runsPerMonth");
    for (let i = 1; i < VISITOR_QUESTIONS_PER_DAY; i++) await ask();
    expect((await ask()).statusCode).toBe(429);
  });
});

describe("product update emails", () => {
  it("go to verified people who did not unsubscribe, in their language, with one-click unsubscribe and the company address", async () => {
    const mailer = await setup({ ZAMTEST_COMPANY_ADDRESS: "ZAMTECH&HOME LLC, 1 Main St, Rosenberg, TX" });
    const person = async (email: string, extra: Record<string, unknown> = {}) => {
      const res = await app.inject({ method: "POST", url: "/api/users", headers: owner, payload: { email, name: email.split("@")[0], role: "viewer", password: PASSWORD } });
      return res.json().id as string;
    };
    await person("ann@example.com");
    await person("bea@example.com");
    await person("cid@example.com");
    // Bea uses the Portal in German; Cid turns updates off in Settings.
    const login = async (email: string) => {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
      return { authorization: `Bearer ${res.json().token}` };
    };
    const bea = await login("bea@example.com");
    await app.inject({ method: "GET", url: "/api/auth/me", headers: { ...bea, "x-zamtech-language": "de" } });
    const cid = await login("cid@example.com");
    expect((await app.inject({ method: "GET", url: "/api/auth/me/preferences", headers: cid })).json()).toEqual({ productUpdates: true, available: true });
    expect((await app.inject({ method: "PUT", url: "/api/auth/me/preferences", headers: cid, payload: { productUpdates: false } })).statusCode).toBe(200);

    // Only the platform owner can send.
    const ann = await login("ann@example.com");
    expect((await app.inject({ method: "GET", url: "/api/platform/announcements", headers: ann })).statusCode).toBe(403);
    const overview = (await app.inject({ method: "GET", url: "/api/platform/announcements", headers: owner })).json();
    expect(overview).toMatchObject({ subscribers: 2, emailReady: true, companyAddress: "ZAMTECH&HOME LLC, 1 Main St, Rosenberg, TX" });

    const sent = await app.inject({
      method: "POST",
      url: "/api/platform/announcements",
      headers: owner,
      payload: { subject: "New: Fix with AI", body: "Hello,\n\n- It reads the log\n- It **fixes** it\n\n[Read more](https://zamtechai.com)", translate: true },
    });
    expect(sent.statusCode, sent.body).toBe(202);
    for (let i = 0; i < 40 && mailer.sent.length < 2; i++) await sleep(100);
    await sleep(500);
    expect(mailer.sent.map((m) => m.to).sort()).toEqual(["ann@example.com", "bea@example.com"]);
    const toBea = mailer.sent.find((m) => m.to === "bea@example.com")!;
    expect(toBea.subject).toBe("[German] New: Fix with AI");
    expect(toBea.html).toContain("ZAMTECH&amp;HOME LLC");
    expect(toBea.html).toContain("<strong>fixes</strong>");
    expect(toBea.headers).toMatchObject({ "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(mailer.sent.find((m) => m.to === "ann@example.com")!.subject).toBe("New: Fix with AI");
    const done = (await app.inject({ method: "GET", url: "/api/platform/announcements", headers: owner })).json().announcements[0];
    expect(done).toMatchObject({ status: "sent", sent: 2, failed: 0, recipients: 2 });

    // The link in the email unsubscribes (and a changed link does not).
    const link = /<(http[^>]+)>/.exec(toBea.headers!["List-Unsubscribe"]!)![1]!.replace("http://localhost:5173", "");
    expect((await app.inject({ method: "GET", url: link.replace(/t=[^&]+/, "t=wrong") })).body).toContain("not valid");
    const page = await app.inject({ method: "GET", url: link });
    expect(page.headers["content-type"]).toContain("text/html");
    expect((await app.inject({ method: "GET", url: "/api/platform/announcements", headers: owner })).json().subscribers).toBe(1);
    // Mail programs' one-click unsubscribe.
    const annLink = /<(http[^>]+)>/.exec(mailer.sent.find((m) => m.to === "ann@example.com")!.headers!["List-Unsubscribe"]!)![1]!.replace("http://localhost:5173", "");
    expect((await app.inject({ method: "POST", url: annLink })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/platform/announcements", headers: owner })).json().subscribers).toBe(0);
  });

  it("are not sent without the company's postal address", async () => {
    await setup({});
    const res = await app.inject({ method: "POST", url: "/api/platform/announcements", headers: owner, payload: { subject: "Hello", body: "Something new here." } });
    expect(res.statusCode).toBe(409);
  });

  it("turn Markdown into safe HTML", () => {
    const html = emailHtml('<script>x</script> **a** [b](javascript:alert(1)) [c](https://x.com/"y)');
    expect(html).not.toMatch(/<script>|href="javascript/);
    expect(html).toContain("<strong>a</strong>");
    expect(emailHtml("- one\n- two")).toContain("<li");
  });
});
