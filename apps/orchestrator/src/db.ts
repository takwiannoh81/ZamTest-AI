/**
 * Postgres persistence for the Store.
 *
 * The orchestrator keeps its working data in memory (store.data) and changes it
 * synchronously; this class makes Postgres the durable copy. At start, everything
 * is loaded. After changes (store.save(), debounced), only what changed is
 * written, in one transaction:
 *
 * - records: one row per record of each collection (workflows, jobs, users...),
 *   as JSONB, with its workspace. A record whose JSON is unchanged is not written.
 * - list_items: lists that only grow at the end and are trimmed at the start
 *   (job logs, the audit log), one row per entry, so a new log line is one insert.
 * - meta: single values (server secrets, data changes already made).
 *
 * A write that fails is retried at the next save; nothing is marked saved until
 * its transaction committed.
 */
import { createHash } from "node:crypto";
import type { Data } from "./store.js";

/** What the persistence needs from a database: pg in production, PGlite in tests. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: Pick<Sql, "query">) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

/** Postgres through node-postgres (a pool of connections). */
export async function pgSql(url: string): Promise<Sql> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  pool.on("error", (err) => console.error(`[db] ${err.message}`));
  return {
    query: (text, params) => pool.query(text, params) as never,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (text, params) => client.query(text, params) as never });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  collection text NOT NULL,
  id text NOT NULL,
  workspace_id text,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_workspace ON records (collection, workspace_id);
CREATE TABLE IF NOT EXISTS list_items (
  list text NOT NULL,
  key text NOT NULL,
  pos bigint NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (list, key, pos)
);
CREATE TABLE IF NOT EXISTS meta (
  key text PRIMARY KEY,
  data jsonb NOT NULL
);`;

/** Lists stored one entry per row. */
const LISTS = ["jobLogs", "audit"] as const;
/** Single values stored in meta. */
const SINGLES = ["secrets", "migrations"] as const;

/** A list as last written: where its entries are, and the last one (by reference). */
interface ListState {
  /** Position of the first entry still in the database. */
  start: number;
  /** Position the next entry gets. */
  end: number;
  last: unknown;
}

/** Postgres rejects \u0000 in JSONB: it becomes the replacement character. */
const toJson = (value: unknown) => JSON.stringify(value).replace(/(^|[^\\])((?:\\\\)*)\\u0000/g, "$1$2\\ufffd");
const hashOf = (json: string) => createHash("sha1").update(json).digest("base64");
const CHUNK = 500;

export class PostgresPersistence {
  /** Hash of each record as last written, by "<collection>\n<id>". */
  private records = new Map<string, string>();
  private lists = new Map<string, ListState>();
  private singles = new Map<string, string>();
  /** The database has been written to (or loaded from) before. */
  private initialized = false;

  constructor(private readonly sql: Sql) {}

  async init(): Promise<void> {
    await this.sql.query(SCHEMA);
  }

  /** Everything in the database, or null when it has never been written (a new database). */
  async load(): Promise<Partial<Data> | null> {
    const started = await this.sql.query<{ data: unknown }>("SELECT data FROM meta WHERE key = 'initialized'");
    if (!started.rows.length) return null;
    this.initialized = true;
    const data: Record<string, unknown> = {};
    for (const row of (await this.sql.query<{ collection: string; id: string; data: unknown }>("SELECT collection, id, data FROM records")).rows) {
      ((data[row.collection] ??= {}) as Record<string, unknown>)[row.id] = row.data;
      this.records.set(`${row.collection}\n${row.id}`, hashOf(toJson(row.data)));
    }
    const items = await this.sql.query<{ list: string; key: string; pos: string; data: unknown }>("SELECT list, key, pos, data FROM list_items ORDER BY list, key, pos");
    for (const row of items.rows) {
      const list = ((data[row.list] ??= {}) as Record<string, unknown[]>)[row.key] ??= [];
      list.push(row.data);
      const pos = Number(row.pos);
      const state = this.lists.get(`${row.list}\n${row.key}`);
      if (state) Object.assign(state, { end: pos + 1, last: row.data });
      else this.lists.set(`${row.list}\n${row.key}`, { start: pos, end: pos + 1, last: row.data });
    }
    for (const row of (await this.sql.query<{ key: string; data: unknown }>("SELECT key, data FROM meta WHERE key <> 'initialized'")).rows) {
      data[row.key] = row.data;
      this.singles.set(row.key, hashOf(toJson(row.data)));
    }
    return data as Partial<Data>;
  }

  /** Writes what changed since the last write, in one transaction. */
  async write(data: Data): Promise<{ records: number; items: number }> {
    const upserts: Array<[string, string, string | null, string, string]> = []; // collection, id, workspace, json, hash
    const deletes: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const [collection, value] of Object.entries(data)) {
      if ((LISTS as readonly string[]).includes(collection) || (SINGLES as readonly string[]).includes(collection)) continue;
      for (const [id, record] of Object.entries(value as Record<string, unknown>)) {
        const key = `${collection}\n${id}`;
        seen.add(key);
        const json = toJson(record);
        const hash = hashOf(json);
        if (this.records.get(key) === hash) continue;
        const workspace = (record as { workspaceId?: unknown })?.workspaceId;
        upserts.push([collection, id, typeof workspace === "string" ? workspace : null, json, hash]);
      }
    }
    for (const key of this.records.keys()) if (!seen.has(key)) deletes.push(key.split("\n") as [string, string]);

    // Lists: new entries at the end, entries trimmed from the start, lists gone.
    const inserts: Array<[string, string, number, string]> = [];
    const trims: Array<[string, string, number]> = []; // delete positions below
    const nextLists = new Map<string, ListState>();
    for (const list of LISTS) {
      for (const [key, entries] of Object.entries(data[list] ?? {}) as Array<[string, unknown[]]>) {
        const id = `${list}\n${key}`;
        const before = this.lists.get(id);
        let state: ListState;
        const at = before ? entries.lastIndexOf(before.last) : -1;
        if (before && at >= 0) {
          // Entries 0..at are written; the ones before them in the database were trimmed.
          const kept = at + 1;
          const start = before.end - kept;
          if (start > before.start) trims.push([list, key, start]);
          state = { start, end: before.end, last: before.last };
          entries.slice(kept).forEach((entry) => inserts.push([list, key, state.end++, toJson(entry)]));
        } else {
          // New (or replaced): written again from scratch.
          if (before) trims.push([list, key, Number.MAX_SAFE_INTEGER]);
          const start = before ? before.end : 0;
          state = { start, end: start, last: undefined };
          entries.forEach((entry) => inserts.push([list, key, state.end++, toJson(entry)]));
        }
        if (entries.length) state.last = entries.at(-1);
        else state = { start: state.end, end: state.end, last: undefined };
        nextLists.set(id, state);
      }
    }
    for (const id of this.lists.keys()) if (!nextLists.has(id)) trims.push([...(id.split("\n") as [string, string]), Number.MAX_SAFE_INTEGER]);

    const singles: Array<[string, string, string]> = [];
    for (const name of SINGLES) {
      const value = data[name];
      if (value === undefined) continue;
      const json = toJson(value);
      const hash = hashOf(json);
      if (this.singles.get(name) !== hash) singles.push([name, json, hash]);
    }

    if (!upserts.length && !deletes.length && !inserts.length && !trims.length && !singles.length && this.initialized) return { records: 0, items: 0 };

    await this.sql.transaction(async (tx) => {
      for (let i = 0; i < upserts.length; i += CHUNK) {
        const part = upserts.slice(i, i + CHUNK);
        await tx.query(
          `INSERT INTO records (collection, id, workspace_id, data, updated_at)
           SELECT c, i, w, d::jsonb, now() FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(c, i, w, d)
           ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, workspace_id = excluded.workspace_id, updated_at = now()`,
          [part.map((u) => u[0]), part.map((u) => u[1]), part.map((u) => u[2]), part.map((u) => u[3])],
        );
      }
      for (let i = 0; i < deletes.length; i += CHUNK) {
        const part = deletes.slice(i, i + CHUNK);
        await tx.query("DELETE FROM records r USING unnest($1::text[], $2::text[]) AS t(c, i) WHERE r.collection = t.c AND r.id = t.i", [part.map((d) => d[0]), part.map((d) => d[1])]);
      }
      for (const [list, key, below] of trims) {
        await tx.query("DELETE FROM list_items WHERE list = $1 AND key = $2 AND pos < $3", [list, key, below]);
      }
      for (let i = 0; i < inserts.length; i += CHUNK) {
        const part = inserts.slice(i, i + CHUNK);
        await tx.query(
          `INSERT INTO list_items (list, key, pos, data)
           SELECT l, k, p, d::jsonb FROM unnest($1::text[], $2::text[], $3::bigint[], $4::text[]) AS t(l, k, p, d)`,
          [part.map((x) => x[0]), part.map((x) => x[1]), part.map((x) => x[2]), part.map((x) => x[3])],
        );
      }
      for (const [name, json] of singles) {
        await tx.query("INSERT INTO meta (key, data) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET data = excluded.data", [name, json]);
      }
      await tx.query(`INSERT INTO meta (key, data) VALUES ('initialized', to_jsonb(now()::text)) ON CONFLICT (key) DO NOTHING`);
    });

    // Written: remember it.
    for (const [collection, id, , , hash] of upserts) this.records.set(`${collection}\n${id}`, hash);
    for (const [collection, id] of deletes) this.records.delete(`${collection}\n${id}`);
    this.lists = nextLists;
    for (const [name, , hash] of singles) this.singles.set(name, hash);
    this.initialized = true;
    return { records: upserts.length + deletes.length, items: inserts.length };
  }

  /** Replaces everything (restoring a backup). */
  async replaceAll(data: Data): Promise<void> {
    await this.sql.transaction(async (tx) => {
      await tx.query("DELETE FROM records");
      await tx.query("DELETE FROM list_items");
      await tx.query("DELETE FROM meta");
    });
    this.records.clear();
    this.lists.clear();
    this.singles.clear();
    this.initialized = false;
    await this.write(data);
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}
