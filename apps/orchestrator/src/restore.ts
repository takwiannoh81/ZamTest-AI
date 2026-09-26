/**
 * Restores the database from an S3 backup. Stop the orchestrator first:
 *
 *   docker compose stop orchestrator
 *   docker compose run --rm orchestrator node_modules/.bin/tsx apps/orchestrator/src/restore.ts latest
 *   docker compose start orchestrator
 *
 * Pass a specific object key instead of "latest" to restore an older backup.
 * The current data is kept in the data folder first: db.json.before-restore-<time>
 * (with Postgres, a copy of what the database held).
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBackup, loadBackupConfig, s3Target } from "./backup.js";
import { loadConfig } from "./config.js";
import { PostgresPersistence, pgSql } from "./db.js";
import { emptyData } from "./store.js";

const which = process.argv[2] ?? "latest";
const config = loadBackupConfig();
if (!config) {
  console.error("ZAMTEST_BACKUP_S3_BUCKET is not set; nothing to restore from.");
  process.exit(1);
}
const { dataDir, databaseUrl } = loadConfig();
const folder = dataDir ?? ".data";
mkdirSync(folder, { recursive: true });
const file = join(folder, "db.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const { key, data } = await fetchBackup(s3Target(config), config, which);
if (databaseUrl) {
  const db = new PostgresPersistence(await pgSql(databaseUrl));
  await db.init();
  const current = await db.load();
  if (current) {
    const saved = `${file}.before-restore-${stamp}`;
    writeFileSync(saved, JSON.stringify(current));
    console.log(`Current database saved as ${saved}`);
  }
  await db.replaceAll({ ...emptyData(), ...data });
  await db.close();
} else {
  if (existsSync(file)) {
    const saved = `${file}.before-restore-${stamp}`;
    copyFileSync(file, saved);
    console.log(`Current database saved as ${saved}`);
  }
  writeFileSync(`${file}.tmp`, JSON.stringify(data));
  renameSync(`${file}.tmp`, file);
}
console.log(`Restored ${key}: ${Object.keys(data.workflows).length} workflows, ${Object.keys(data.jobs).length} jobs.`);
