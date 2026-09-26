import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { canWatchFiles, patternMatches } from "../src/triggers.js";
import type { EmailEvent, Mailbox } from "../src/triggers.js";

let app: FastifyInstance;
let store: Store;
afterEach(() => app?.close());

const agentKey = { "x-agent-key": "k" };
const definition = {
  id: "invoices",
  name: "Invoices",
  variables: [
    { name: "trigger", type: "object", direction: "in" },
    { name: "customer", type: "string", direction: "in" },
  ],
  root: { id: "root", type: "core.sequence", props: {}, slots: { body: [{ id: "a", type: "core.log", props: { message: "{{ trigger }}" } }] } },
};

async function setup(mailbox?: Mailbox) {
  store = new Store(null);
  ({ app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai: null, mailbox }));
  const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Invoices", definition } })).json();
  return (await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, payload: {} })).json() as { id: string };
}
const post = (url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers, payload: payload as object });
const jobs = () => Object.values(store.data.jobs).filter((j) => j.source === "trigger");

describe("web request triggers", () => {
  it("start the process with the request, filling in-arguments by name", async () => {
    const pkg = await setup();
    const trigger = (await post("/api/triggers", { name: "New order", kind: "webhook", packageId: pkg.id, inputs: { customer: "default" } })).json();
    expect(trigger.webhook.path).toMatch(new RegExp(`^/api/hooks/${trigger.id}/[\\w-]{20,}$`));

    // Anyone with the address, and no one without it (no sign-in needed).
    const started = await post(trigger.webhook.path, { customer: "ACME", order: 42 });
    expect(started.statusCode, started.body).toBe(202);
    const job = store.data.jobs[started.json().jobId]!;
    expect(job).toMatchObject({ source: "trigger", startedBy: "trigger: New order" });
    expect(job.inputs).toMatchObject({ customer: "ACME", trigger: { body: { customer: "ACME", order: 42 } } });
    expect((await post(`/api/hooks/${trigger.id}/wrong-secret`, {})).statusCode).toBe(404);

    // A new secret: the old address stops working.
    const renewed = (await post(`/api/triggers/${trigger.id}/new-secret`)).json();
    expect((await post(trigger.webhook.path, {})).statusCode).toBe(404);
    expect((await post(renewed.webhook.path, {})).statusCode).toBe(202);

    // Turned off: refused. The list shows how often it ran.
    await app.inject({ method: "PUT", url: `/api/triggers/${trigger.id}`, payload: { enabled: false } });
    expect((await post(renewed.webhook.path, {})).statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/triggers" })).json()[0]).toMatchObject({ fired: 2, enabled: false });
  });

  it("can run test cases, and refuses a trigger with nothing to run", async () => {
    await setup();
    expect((await post("/api/triggers", { name: "x", kind: "webhook" })).statusCode).toBe(400);
    const tc = (await post("/api/test-cases", { name: "Login works" })).json();
    const trigger = (await post("/api/triggers", { name: "After deploy", kind: "webhook", tests: { caseIds: [tc.id] } })).json();
    const started = (await post(trigger.webhook.path, {})).json();
    expect(store.data.testRuns[started.testRunId]).toBeDefined();
  });
});

describe("email triggers", () => {
  it("start for each new matching email, from when the trigger was set up", async () => {
    const inbox: EmailEvent[] = [];
    const calls: Array<{ afterUid?: number }> = [];
    const mailbox: Mailbox = {
      async fetchNew(input) {
        calls.push({ afterUid: input.afterUid });
        const top = inbox.length;
        if (input.afterUid === undefined) return { uidValidity: "1", lastUid: top, emails: [] };
        return { uidValidity: "1", lastUid: top, emails: inbox.filter((e) => e.uid > input.afterUid!) };
      },
    };
    const mail = (subject: string, from = "billing@supplier.example"): EmailEvent => ({ uid: inbox.length + 1, from, to: "ap@acme.example", subject, text: "", attachments: [{ filename: "invoice.pdf", size: 1000 }] });
    const pkg = await setup(mailbox);
    await post("/api/assets", { name: "Mail/AP", type: "credential", value: { username: "ap@acme.example", password: "pw" } });
    inbox.push(mail("Invoice 1 (old)"));
    const trigger = (
      await post("/api/triggers", { name: "Invoices by email", kind: "email", packageId: pkg.id, email: { server: "imap.example:993", credential: "Mail/AP", subject: "invoice" } })
    ).json();
    expect(trigger.email).toMatchObject({ folder: "INBOX", markAsRead: false });

    const check = () => (app as unknown as { triggersCheck?: () => Promise<void> }).triggersCheck?.();
    expect(check).toBeDefined();
    await check(); // the first check only notes where the mailbox is
    expect(jobs()).toHaveLength(0);
    inbox.push(mail("Invoice 2"), mail("Lunch on Friday"), mail("INVOICE 3"));
    await check();
    expect(jobs().map((j) => (j.inputs.trigger as EmailEvent).subject)).toEqual(["Invoice 2", "INVOICE 3"]);
    await check(); // nothing new
    expect(jobs()).toHaveLength(2);
    expect(calls.map((c) => c.afterUid)).toEqual([undefined, 1, 4]);
  });

  it("shows a mailbox problem on the trigger", async () => {
    const pkg = await setup({ fetchNew: async () => Promise.reject(new Error("Invalid credentials (Failure)")) });
    await post("/api/assets", { name: "Mail/AP", type: "credential", value: { username: "u", password: "p" } });
    expect((await post("/api/triggers", { name: "t", kind: "email", packageId: pkg.id, email: { server: "x:993", credential: "Nope" } })).statusCode).toBe(404);
    await post("/api/triggers", { name: "t", kind: "email", packageId: pkg.id, email: { server: "x:993", credential: "Mail/AP" } });
    await (app as unknown as { triggersCheck: () => Promise<void> }).triggersCheck();
    expect((await app.inject({ method: "GET", url: "/api/triggers" })).json()[0].lastError.message).toBe("Mailbox: Invalid credentials (Failure)");
  });
});

describe("file triggers", () => {
  it("tell the PC what to watch, and start each new file once on that PC", async () => {
    const pkg = await setup();
    const old = (await post("/api/agent/register", { name: "old-pc", version: "0.3.8" }, agentKey)).json();
    const pc = (await post("/api/agent/register", { name: "scan-pc", version: "0.3.9" }, agentKey)).json();
    const body = { name: "Scanned invoices", kind: "file", packageId: pkg.id, file: { folder: "C:\\Scans", pattern: "*.pdf" } };
    expect((await post("/api/triggers", body)).statusCode).toBe(400); // which PC?
    expect((await post("/api/triggers", { ...body, targetAgentId: old.agentId })).json().error).toContain("0.3.9");
    const trigger = (await post("/api/triggers", { ...body, targetAgentId: pc.agentId })).json();

    const beat = (await post("/api/agent/heartbeat", { agentId: pc.agentId }, agentKey)).json();
    expect(beat.watches).toEqual([{ triggerId: trigger.id, folder: "C:\\Scans", pattern: "*.pdf" }]);
    expect((await post("/api/agent/heartbeat", { agentId: old.agentId }, agentKey)).json().watches).toEqual([]);

    const later = new Date(Date.now() + 60_000).toISOString();
    const file = { triggerId: trigger.id, path: "C:\\Scans\\inv-1.pdf", name: "inv-1.pdf", size: 1200, modifiedAt: later };
    const events = [
      file,
      { ...file, path: "C:\\Scans\\notes.txt", name: "notes.txt" }, // another pattern
      { ...file, path: "C:\\Scans\\old.pdf", name: "old.pdf", modifiedAt: "2020-01-01T00:00:00.000Z" }, // from before the trigger
    ];
    const res = (await post("/api/agent/file-events", { agentId: pc.agentId, events }, agentKey)).json();
    expect(res.started).toHaveLength(1);
    const job = store.data.jobs[res.started[0]]!;
    expect(job.targetAgentId).toBe(pc.agentId);
    expect(job.inputs.trigger).toEqual({ path: "C:\\Scans\\inv-1.pdf", name: "inv-1.pdf", size: 1200, modifiedAt: later });
    // The same file again (e.g. the PC restarted): not again. Another PC cannot report for it.
    expect((await post("/api/agent/file-events", { agentId: pc.agentId, events: [file] }, agentKey)).json().started).toEqual([]);
    expect((await post("/api/agent/file-events", { agentId: old.agentId, events: [{ ...file, size: 5 }] }, agentKey)).json().started).toEqual([]);
  });

  it("match file names and agent versions", () => {
    expect(patternMatches("*.pdf", "Invoice.PDF")).toBe(true);
    expect(patternMatches("inv-??.xlsx", "inv-12.xlsx")).toBe(true);
    expect(patternMatches("inv-??.xlsx", "inv-123.xlsx")).toBe(false);
    expect(patternMatches("*", "a (1).txt")).toBe(true);
    expect(canWatchFiles("0.3.9")).toBe(true);
    expect(canWatchFiles("0.4.0")).toBe(true);
    expect(canWatchFiles("0.3.8")).toBe(false);
    expect(canWatchFiles(undefined)).toBe(false);
  });
});
