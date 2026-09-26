import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Sql } from "../src/db.js";
import { Store } from "../src/store.js";

/** A real Postgres (PGlite, in this process) behind the Sql the store uses. */
function pglite(): { sql: Sql; db: PGlite } {
  const db = new PGlite();
  const sql: Sql = {
    query: async (text, params) => (params ? db.query(text, params) : ((await db.exec(text)).at(-1) ?? { rows: [] })) as never,
    transaction: (fn) => db.transaction((tx) => fn({ query: (text, params) => tx.query(text, params) as never })),
    end: async () => undefined, // the test reopens it
  };
  return { sql, db };
}

const count = async (db: PGlite, table: string) => Number(((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]!).n);
const settle = () => new Promise((r) => setTimeout(r, 400));

describe("Postgres store", () => {
  it("keeps everything across restarts, writing only what changed", async () => {
    const { sql, db } = pglite();
    let store = await Store.open({ dataDir: null, sql, log: () => undefined });
    expect(store.kind).toBe("postgres");
    // A new database gets the default workspace (migrate) straight away.
    expect(await count(db, "records")).toBe(1);

    store.data.workflows.wf_1 = { id: "wf_1", workspaceId: "ws_default", name: "Invoices", definition: {} as never, createdAt: "t", updatedAt: "t" };
    store.data.secrets.unsubscribe = "s3cret";
    store.appendLogs("job_1", [
      { time: "t1", level: "info", message: "one" },
      { time: "t2", level: "info", message: "two \u0000 with a NUL" },
    ]);
    store.save();
    await settle();
    await store.close();

    // A restart: all of it is back.
    store = await Store.open({ dataDir: null, sql, log: () => undefined });
    expect(store.data.workflows.wf_1?.name).toBe("Invoices");
    expect(store.data.secrets.unsubscribe).toBe("s3cret");
    expect(store.data.jobLogs.job_1?.map((l) => [l.seq, l.message])).toEqual([
      [1, "one"],
      [2, "two � with a NUL"],
    ]);

    // Only the changed record is written; a new log line is one row.
    await db.query("UPDATE records SET updated_at = '2000-01-01' ");
    store.data.workflows.wf_1!.name = "Invoices v2";
    store.appendLogs("job_1", [{ time: "t3", level: "info", message: "three" }]);
    store.save();
    await settle();
    const changed = (await db.query<{ id: string }>("SELECT id FROM records WHERE updated_at > '2000-01-01'")).rows.map((r) => r.id);
    expect(changed).toEqual(["wf_1"]);
    expect(await count(db, "list_items")).toBe(3);

    // Logs trimmed at the start, and records deleted, go from the database too.
    store.data.jobLogs.job_1!.splice(0, 2);
    delete store.data.workflows.wf_1;
    store.save();
    await settle();
    await store.close();
    store = await Store.open({ dataDir: null, sql, log: () => undefined });
    expect(store.data.workflows.wf_1).toBeUndefined();
    expect(store.data.jobLogs.job_1?.map((l) => l.message)).toEqual(["three"]);
    // The next line goes on from the last number.
    store.appendLogs("job_1", [{ time: "t4", level: "info", message: "four" }]);
    expect(store.data.jobLogs.job_1?.map((l) => l.seq)).toEqual([3, 4]);
    await store.close();
  });

  it("takes over an existing db.json once, and keeps the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zamtest-db-"));
    writeFileSync(join(dir, "db.json"), JSON.stringify({ workflows: { wf_old: { id: "wf_old", name: "From the file", definition: {}, createdAt: "t", updatedAt: "t" } } }));
    const { sql } = pglite();
    const logged: string[] = [];
    const store = await Store.open({ dataDir: dir, sql, log: (m) => logged.push(m) });
    // Imported, and given the default workspace like any old data.
    expect(store.data.workflows.wf_old).toMatchObject({ name: "From the file", workspaceId: "ws_default" });
    expect(readdirSync(dir).some((f) => f.startsWith("db.json.imported-"))).toBe(true);
    expect(readdirSync(dir)).not.toContain("db.json");
    expect(logged[0]).toMatch(/imported the data of/);
    await store.close();

    // The database is used from now on, even if a db.json appears again.
    writeFileSync(join(dir, "db.json"), JSON.stringify({ workflows: {} }));
    const again = await Store.open({ dataDir: dir, sql, log: () => undefined });
    expect(again.data.workflows.wf_old).toBeDefined();
    await again.close();
  });

  it("runs the whole API on Postgres", async () => {
    const { sql } = pglite();
    const store = await Store.open({ dataDir: null, sql, log: () => undefined });
    const { app } = await buildApp({ config: { ...loadConfig({ ZAMTEST_AGENT_KEY: "k" }), dataDir: null }, store, ai: null });
    const wf = (await app.inject({ method: "POST", url: "/api/workflows", payload: { name: "Hello" } })).json();
    await app.inject({ method: "POST", url: `/api/workflows/${wf.id}/publish`, payload: {} });
    await app.close(); // saves what is left

    const reopened = await Store.open({ dataDir: null, sql, log: () => undefined });
    expect(reopened.data.workflows[wf.id]?.name).toBe("Hello");
    expect(Object.values(reopened.data.packages).map((p) => p.workflowId)).toContain(wf.id);
    // The audit log is kept entry by entry.
    expect(Object.values(reopened.data.audit).flat().length).toBeGreaterThan(0);
    await reopened.close();
  });

  it("works through the pg driver, over the network, as in production", async () => {
    const db = new PGlite();
    const server = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1" });
    await server.start();
    const port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
    try {
      const store = await Store.open({ dataDir: null, databaseUrl, log: () => undefined });
      const name = `O'Brien "quoted" \\ back, {braces}`;
      expect(name).toContain("\\");
      store.data.users.u_1 = { id: "u_1", workspaceId: "ws_default", email: "a@b.c", name, role: "admin", passwordHash: "x", createdAt: "t" } as never;
      const message = `line with 'quotes', {braces} and "double"`;
      store.appendLogs("job_9", [{ time: "t", level: "info", message }]);
      store.save();
      await settle();
      await store.close();
      const again = await Store.open({ dataDir: null, databaseUrl, log: () => undefined });
      expect(again.data.users.u_1?.name).toBe(name);
      expect(again.data.jobLogs.job_9?.[0]?.message).toBe(message);
      await again.close();
    } finally {
      await server.stop();
    }
  });
});
