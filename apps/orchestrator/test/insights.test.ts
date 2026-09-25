import { afterEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Mail, Mailer } from "../src/mailer.js";
import { parseCsv, parseTestData, variableNames } from "../src/testdata.js";

let app: FastifyInstance;
afterEach(() => app?.close());

const agent = { "x-agent-key": "k" };
const TOKEN = "master-token-0123456789abcdef";
const master = { authorization: `Bearer ${TOKEN}` };
type Headers = Record<string, string>;
const open: Headers = {};
const call = (headers: Headers, method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => app.inject({ method, url, headers, payload: payload as object });

class FakeMailer implements Mailer {
  sent: Mail[] = [];
  async send(mail: Mail) {
    this.sent.push(mail);
  }
}

const steps = (id: string) => ({
  schemaVersion: 1,
  id,
  name: id,
  variables: [],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "type", type: "core.log", props: { message: "{{ username }}" } }] } },
});

/** The bot finishes each pending job: failed when `fail` says so. */
async function bot(agentId: string, fail: (job: { inputs: Record<string, unknown>; name: string }) => string | undefined) {
  for (;;) {
    const next = await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agent, payload: { agentId } });
    if (next.statusCode === 204) return;
    const job = next.json();
    const error = fail(job);
    await app.inject({ method: "POST", url: `/api/agent/jobs/${job.id}/complete`, headers: agent, payload: { agentId, status: error ? "failed" : "succeeded", error } });
  }
}

async function localApp(extra: { mailer?: Mailer; fetch?: typeof fetch } = {}) {
  ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null, ...extra }));
  return (await app.inject({ method: "POST", url: "/api/agent/register", headers: agent, payload: { name: "bot" } })).json().agentId as string;
}

describe("data-driven tests", () => {
  it("run once per row, each column's value in its variable", async () => {
    const agentId = await localApp();
    const data = { columns: ["username", "password"], rows: [["ada", "a1"], ["bob", "b2"], ["cy", "c3"]] };
    const bad = await call(open, "POST", "/api/test-cases", { name: "x", definition: steps("x"), data: { columns: ["a"], rows: [["1", "2"]] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("Row 1 has 2 values for 1 columns");
    expect((await call(open, "POST", "/api/test-cases", { name: "x", definition: steps("x"), data: { columns: ["first name"], rows: [] } })).statusCode).toBe(400);

    const login = (await call(open, "POST", "/api/test-cases", { name: "Login", definition: steps("login"), data })).json();
    expect(login.dataSize).toEqual({ columns: 2, rows: 3 });
    expect((await call(open, "GET", `/api/test-cases/${login.id}`)).json().data).toEqual(data);

    const run = (await call(open, "POST", "/api/test-runs", { caseIds: [login.id] })).json();
    expect(run.items.map((i: { row: number; rowLabel: string }) => `${i.row}:${i.rowLabel}`)).toEqual(["1:ada", "2:bob", "3:cy"]);
    const next = (await app.inject({ method: "POST", url: "/api/agent/jobs/next", headers: agent, payload: { agentId } })).json();
    expect(next.inputs).toEqual({ username: "ada", password: "a1" });
    expect(next.name).toBe("Login · row 1");
    expect(next.definition.variables).toEqual([
      { name: "username", type: "string", direction: "in" },
      { name: "password", type: "string", direction: "in" },
    ]);
    await app.inject({ method: "POST", url: `/api/agent/jobs/${next.id}/complete`, headers: agent, payload: { agentId, status: "succeeded" } });
    await bot(agentId, (job) => (job.inputs.username === "bob" ? "Wrong password" : undefined));
    const done = (await call(open, "GET", `/api/test-runs/${run.id}`)).json();
    expect(done).toMatchObject({ done: true, passed: 2, failed: 1 });
    expect(done.items[1]).toMatchObject({ row: 2, status: "failed", message: "Wrong password" });

    // The Designer's Run: the first row only.
    const tryOut = (await call(open, "POST", "/api/test-runs", { caseIds: [login.id], firstRowOnly: true })).json();
    expect(tryOut.items).toHaveLength(1);
  });

  it("read CSV and Excel files", async () => {
    expect(parseCsv('name;note\r\n"Ada";"says ""hi""; bye"\r\nBob;\n')).toEqual([["name", "note"], ["Ada", 'says "hi"; bye'], ["Bob", ""]]);
    expect(variableNames(["First name", "2nd", "", "First name"])).toEqual({
      columns: ["First_name", "_2nd", "Column3", "First_name_2"],
      renamed: [
        { from: "First name", to: "First_name" },
        { from: "2nd", to: "_2nd" },
        { from: "(column 3)", to: "Column3" },
        { from: "First name", to: "First_name_2" },
      ],
    });
    const csv = await parseTestData("users.csv", Buffer.from("﻿user,pin\nada,1234\n\n,\nbob,0042\n"));
    expect(csv).toMatchObject({ columns: ["user", "pin"], rows: [["ada", "1234"], ["bob", "0042"]], truncated: false });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Logins");
    sheet.addRow(["User", "Born", "Age"]);
    sheet.addRow(["ada", new Date(Date.UTC(1990, 4, 1)), 36]);
    const xlsx = await parseTestData("users.xlsx", Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(xlsx).toMatchObject({ columns: ["User", "Born", "Age"], rows: [["ada", "1990-05-01", "36"]] });

    await localApp();
    const parsed = await call(open, "POST", "/api/test-data/parse", { fileName: "a.csv", base64: Buffer.from("a,b\n1,2").toString("base64") });
    expect(parsed.json()).toMatchObject({ columns: ["a", "b"], rows: [["1", "2"]] });
    expect((await call(open, "POST", "/api/test-data/parse", { fileName: "a.xls", base64: "AA==" })).json().error).toContain(".xlsx");
  });
});

describe("test reports", () => {
  it("show pass rate, flaky tests, common failures and a printable run report", async () => {
    const agentId = await localApp();
    const folder = (await call(open, "POST", "/api/test-folders", { name: "Web" })).json();
    const stable = (await call(open, "POST", "/api/test-cases", { name: "Home page", folderId: folder.id, definition: steps("home") })).json();
    const shaky = (await call(open, "POST", "/api/test-cases", { name: "Checkout", folderId: folder.id, definition: steps("checkout") })).json();

    let round = 0;
    for (const failCheckout of [true, false, true]) {
      round++;
      await call(open, "POST", "/api/test-runs", { folderId: folder.id });
      await bot(agentId, (job) => (failCheckout && job.name === "Checkout" ? `Timed out after ${30000 + round} ms waiting for #pay-${round}` : undefined));
    }

    const report = (await call(open, "GET", "/api/test-reports?days=7&tz=America/Chicago")).json();
    expect(report.summary).toMatchObject({ runs: 3, tests: 6, passed: 4, failed: 2, flaky: 1 });
    expect(report.daily).toHaveLength(7);
    expect(report.daily.at(-1)).toMatchObject({ passed: 4, failed: 2 });
    expect(report.tests[0]).toMatchObject({ id: shaky.id, runs: 3, passed: 1, failed: 2, flaky: true, lastStatus: "failed", history: ["failed", "passed", "failed"] });
    expect(report.tests[1]).toMatchObject({ id: stable.id, passRate: 1, flaky: false });
    // Alike messages are one failure.
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ count: 2, tests: ["Checkout"] });
    expect(report.runs).toHaveLength(3);

    const csv = (await call(open, "GET", "/api/test-reports/export.csv?days=7")).body;
    expect(csv.split("\r\n")[1]).toContain("Web,Checkout,3,1,2,33,yes");

    const html = await call(open, "GET", `/api/test-runs/${report.runs[0].id}/report`);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(html.body).toContain("Print / Save as PDF");
    expect(html.body).toContain("Timed out after 30003 ms");
    // The run's results outlive its jobs.
    for (const job of (await call(open, "GET", "/api/jobs")).json()) await call(open, "DELETE", `/api/jobs/${job.id}`);
    expect((await call(open, "GET", "/api/test-reports?days=7")).json().summary).toMatchObject({ passed: 4, failed: 2 });
  });
});

describe("alerts", () => {
  it("tell by email and Slack when a scheduled test run or a process fails, not for runs someone watches", async () => {
    const mailer = new FakeMailer();
    const posts: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const agentId = await localApp({ mailer, fetch: fakeFetch });

    expect((await call(open, "PUT", "/api/workspace/alerts", { emails: ["qa@example.com"], slackUrl: "https://evil.example.com/x", jobFailed: true, testRuns: "failures", agentOffline: false })).statusCode).toBe(400);
    const saved = await call(open, "PUT", "/api/workspace/alerts", {
      emails: ["QA@example.com"],
      slackUrl: "https://hooks.slack.com/services/T000/B000/secretsecret1234",
      jobFailed: true,
      testRuns: "failures",
      agentOffline: false,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ emails: ["qa@example.com"], slack: "https://hooks.slack.com/…1234", chosen: true });
    expect(JSON.stringify(saved.json())).not.toContain("secretsecret");

    const tc = (await call(open, "POST", "/api/test-cases", { name: "Login", definition: steps("login") })).json();
    // Someone ran it and is watching: no alert.
    await call(open, "POST", "/api/test-runs", { caseIds: [tc.id] });
    await bot(agentId, () => "Wrong password");
    // A schedule ran it: an alert.
    const schedule = (await call(open, "POST", "/api/schedules", { name: "Nightly", cron: "0 2 * * *", tests: { caseIds: [tc.id] } })).json();
    await call(open, "POST", `/api/schedules/${schedule.id}/run`);
    await bot(agentId, () => "Wrong password");
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: "qa@example.com", subject: "❌ 1 of 1 tests failed: Login" });
    expect(mailer.sent[0]!.text).toContain("✕ Login - Wrong password");
    expect(mailer.sent[0]!.text).toContain("/#/test-reports?run=");
    expect((posts[0]!.body as { text: string }).text).toContain("*1 of 1 tests failed: Login*");

    // A process that failed: an alert with the job's link. A Designer try-out that failed: none.
    const wf = (await call(open, "POST", "/api/workflows", { definition: steps("proc") })).json();
    await call(open, "POST", "/api/jobs", { definition: steps("try"), source: "designer" });
    await bot(agentId, () => "Oops");
    const pkg = (await call(open, "POST", `/api/workflows/${wf.id}/publish`, {})).json();
    const job = (await call(open, "POST", "/api/jobs", { packageId: pkg.id })).json();
    await bot(agentId, () => "Element not found: #save");
    await vi.waitFor(() => expect(mailer.sent).toHaveLength(2));
    expect(mailer.sent[1]).toMatchObject({ subject: "❌ proc failed" });
    expect(mailer.sent[1]!.text).toContain(`/#/jobs/${job.id}`);
    expect(mailer.sent[1]!.text).toContain("Error: Element not found: #save");

    // "Send a test alert" says what happened on each channel.
    expect((await call(open, "POST", "/api/workspace/alerts/test")).json()).toEqual({ email: "sent", slack: "sent", teams: undefined });
    // A Teams address from Teams only.
    expect((await call(open, "PUT", "/api/workspace/alerts", { emails: [], teamsUrl: "https://example.com/hook", jobFailed: true, testRuns: "off", agentOffline: true })).statusCode).toBe(400);
    const teams = await call(open, "PUT", "/api/workspace/alerts", { emails: [], teamsUrl: "https://prod-01.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=zz", jobFailed: true, testRuns: "off", agentOffline: true });
    expect(teams.json()).toMatchObject({ teams: "https://prod-01.westus.logic.azure.com/…g=zz", slack: "https://hooks.slack.com/…1234" });
    await call(open, "POST", "/api/workspace/alerts/test");
    await vi.waitFor(() => expect(posts.some((p) => p.url.includes("logic.azure.com"))).toBe(true));
    const card = posts.find((p) => p.url.includes("logic.azure.com"))!.body as { attachments: Array<{ content: { type: string } }> };
    expect(card.attachments[0]!.content.type).toBe("AdaptiveCard");
  });
});

describe("audit log", () => {
  it("records who changed what (never secret values), sign-ins, and is for admins", async () => {
    ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_ADMIN_TOKEN: TOKEN, ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, ai: null }));
    await call(master, "POST", "/api/users", { email: "dev@example.com", name: "Dev", role: "developer", password: "correct horse battery" });
    await call(master, "POST", "/api/users", { email: "boss@example.com", name: "Boss", role: "admin", password: "correct horse battery" });
    expect((await call(open, "POST", "/api/auth/login", { email: "dev@example.com", password: "wrong wrong wrong" })).statusCode).toBe(401);
    const dev = { authorization: `Bearer ${(await call(open, "POST", "/api/auth/login", { email: "dev@example.com", password: "correct horse battery" })).json().token}` };
    const boss = { authorization: `Bearer ${(await call(open, "POST", "/api/auth/login", { email: "boss@example.com", password: "correct horse battery" })).json().token}` };

    const wf = (await call(dev, "POST", "/api/workflows", { definition: steps("Invoices") })).json();
    await call(dev, "PUT", `/api/workflows/${wf.id}`, { definition: steps("Invoices") });
    await call(dev, "PUT", `/api/workflows/${wf.id}`, { definition: steps("Invoices") });
    await call(dev, "POST", `/api/workflows/${wf.id}/publish`, {});
    const asset = (await call(dev, "POST", "/api/assets", { name: "Bank/Login", type: "credential", value: { username: "u", password: "hunter2-secret" } })).json();
    await call(dev, "PUT", `/api/assets/${asset.id}`, { value: { username: "u", password: "new-secret-99" } });
    await call(dev, "DELETE", `/api/assets/${asset.id}`);
    // Not allowed: recorded as refused.
    expect((await call(dev, "POST", "/api/users", { email: "x@example.com", name: "X", role: "admin", password: "correct horse battery" })).statusCode).toBe(403);
    await call(dev, "GET", "/api/workflows");

    expect((await call(dev, "GET", "/api/audit")).statusCode).toBe(403);
    const { events } = (await call(boss, "GET", "/api/audit")).json();
    const lines = events.map((e: { actor: string; action: string; target?: string; status: number; count?: number }) => [e.actor.split(" ")[0], e.action, e.target, e.status, e.count && `x${e.count}`].filter(Boolean).join(" "));
    expect(lines).toEqual([
      "Dev user.create 403",
      "Dev asset.delete Bank/Login 204",
      "Dev asset.change Bank/Login 200",
      "Dev asset.create Bank/Login 201",
      "Dev workflow.publish Invoices 201",
      "Dev workflow.change Invoices 200 x2",
      "Dev workflow.create Invoices 201",
      "Boss session.signIn 200",
      "Dev session.signIn 200",
      "Dev session.signInFailed 401",
      "Access user.create Boss <boss@example.com> 201",
      "Access user.create Dev <dev@example.com> 201",
    ]);
    const all = JSON.stringify(events);
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("new-secret");
    expect(events.find((e: { action: string }) => e.action === "asset.change").details).toEqual({ fields: ["value (hidden)"] });
    expect(events.find((e: { action: string }) => e.action === "session.signIn").ip).toBeTruthy();

    expect((await call(boss, "GET", "/api/audit?q=asset%20delete")).json().events).toHaveLength(1);
    const csv = await call(boss, "GET", "/api/audit/export.csv");
    expect(csv.headers["content-disposition"]).toContain("audit-log-");
    expect(csv.body).toContain("asset.delete,Bank/Login");
    // Exporting the log is itself recorded.
    expect((await call(boss, "GET", "/api/audit?limit=1")).json().events[0]).toMatchObject({ action: "audit.export" });
  });
});
