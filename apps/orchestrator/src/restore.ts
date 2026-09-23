/**
 * Restores the database from an S3 backup. Stop the orchestrator first:
 *
 *   docker compose stop orchestrator
 *   docker compose run --rm orchestrator node_modules/.bin/tsx apps/orchestrator/src/restore.ts latest
 *   docker compose start orchestrator
 *
 * Pass a specific object key instead of "latest" to restore an older backup.
 * The current database is kept next to it as db.json.before-restore-<time>.
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBackup, loadBackupConfig, s3Target } from "./backup.js";

const which = process.argv[2] ?? "latest";
const config = loadBackupConfig();
if (!config) {
  console.error("ZAMTEST_BACKUP_S3_BUCKET is not set; nothing to restore from.");
  process.exit(1);
}
const dataDir = process.env.ZAMTEST_DATA_DIR ?? ".data";
mkdirSync(dataDir, { recursive: true });
const file = join(dataDir, "db.json");

const { key, data } = await fetchBackup(s3Target(config), config, which);
if (existsSync(file)) {
  const saved = `${file}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(file, saved);
  console.log(`Current database saved as ${saved}`);
}
writeFileSync(`${file}.tmp`, JSON.stringify(data));
renameSync(`${file}.tmp`, file);
console.log(`Restored ${key}: ${Object.keys(data.workflows).length} workflows, ${Object.keys(data.jobs).length} jobs.`);
