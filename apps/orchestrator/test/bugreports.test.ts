import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail, Mailer } from "../src/mailer.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}

describe("Report a problem", () => {
  it("reaches the platform owner with its details and screenshot, and the person hears back when it is fixed", async () => {
    const mailer = new FakeMailer();
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_SUPPORT_EMAIL: "support@zamtechai.com" }), dataDir: null }, ai: null, mailer }));
    await app.inject({ method: "POST", url: "/api/users", headers: master, payload: { email: "viewer@example.com", name: "Vee", role: "viewer", password: "correct horse battery" } });
    const vee = { authorization: `Bearer ${(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "viewer@example.com", password: "correct horse battery" } })).json().token}` };
    const report = (payload: object) => app.inject({ method: "POST", url: "/api/bug-reports", headers: vee, payload });
    const base = {
      kind: "blocking",
      what: "Run does nothing\nThe panel stays empty.",
      doing: "Opened a workflow and clicked Run",
      context: { app: "designer", page: "https://designer.zamtechai.com/#/wf/1", where: "editing the workflow", userAgent: "Chrome", language: "en", errors: [{ time: "2026-09-25T10:00:00Z", message: "POST /api/jobs -> 500: boom" }] },
    };

    expect((await report({ ...base, images: [{ name: "x.exe", type: "application/x-msdownload", base64: "AA==" }] })).statusCode).toBe(400);
    // Even a viewer can report.
    const sent = await report({ ...base, images: [{ name: "shot.png", type: "image/png", base64: png.toString("base64") }] });
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().id;

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "support@zamtechai.com", subject: "🔴 Bug report from Default workspace: Run does nothing" });
    expect(mailer.sent[0]!.text).toContain("POST /api/jobs -> 500: boom");
    expect(mailer.sent[0]!.headers).toEqual({ "Reply-To": "viewer@example.com" });
    expect(mailer.sent[0]!.text).toContain(`/#/bug-reports?id=${id}`);

    expect((await app.inject({ method: "GET", url: "/api/bug-reports/mine", headers: vee })).json()).toMatchObject([{ id, status: "new" }]);
    // Customers never see others' reports.
    expect((await app.inject({ method: "GET", url: "/api/platform/bug-reports", headers: vee })).statusCode).toBe(403);

    const list = (await app.inject({ method: "GET", url: "/api/platform/bug-reports?status=new", headers: master })).json();
    expect(list[0]).toMatchObject({ id, reporter: "Vee <viewer@example.com>", kind: "blocking", images: [{ name: "shot.png", bytes: png.length }] });
    expect(list[0].context.ip).toBeTruthy();
    const image = await app.inject({ method: "GET", url: `/api/platform/bug-reports/${id}/images/0`, headers: master });
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload).toEqual(png);

    await app.inject({ method: "PUT", url: `/api/platform/bug-reports/${id}`, headers: master, payload: { status: "investigating" } });
    expect(mailer.sent).toHaveLength(1);
    await app.inject({ method: "PUT", url: `/api/platform/bug-reports/${id}`, headers: master, payload: { status: "fixed", note: "Fixed in today's update." } });
    expect(mailer.sent[1]).toMatchObject({ to: "viewer@example.com", subject: "Fixed: the problem you reported in ZamTech AI" });
    expect(mailer.sent[1]!.text).toContain("Fixed in today's update.");
    expect((await app.inject({ method: "GET", url: "/api/bug-reports/mine", headers: vee })).json()[0]).toMatchObject({ status: "fixed", note: "Fixed in today's update." });

    // At most ten a day.
    for (let i = 0; i < 9; i++) await report(base);
    expect((await report(base)).statusCode).toBe(429);
  });
});
