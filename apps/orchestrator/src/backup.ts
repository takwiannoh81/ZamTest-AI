import { gunzipSync, gzipSync } from "node:zlib";
import { Cron } from "croner";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Data, Store } from "./store.js";
import { nowIso } from "./store.js";

export interface BackupConfig {
  bucket: string;
  prefix: string;
  region?: string;
  cron: string;
  keepDays: number;
}

export function loadBackupConfig(env = process.env): BackupConfig | null {
  const bucket = env.ZAMTEST_BACKUP_S3_BUCKET?.trim();
  if (!bucket) return null;
  let prefix = env.ZAMTEST_BACKUP_S3_PREFIX?.trim() ?? "zamtest/";
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    bucket,
    prefix,
    region: env.ZAMTEST_BACKUP_S3_REGION || env.AWS_REGION || undefined,
    cron: env.ZAMTEST_BACKUP_CRON || "0 3 * * *",
    keepDays: Number(env.ZAMTEST_BACKUP_KEEP_DAYS || 30),
  };
}

/** Storage operations the backup service needs; S3 in production, a fake in tests. */
export interface BackupTarget {
  put(key: string, body: Buffer): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
  remove(keys: string[]): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Credentials come from the standard AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, instance role...). */
export function s3Target(config: BackupConfig): BackupTarget {
  const s3 = new S3Client(config.region ? { region: config.region } : {});
  return {
    async put(key, body) {
      await s3.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: "application/gzip",
          ServerSideEncryption: "AES256",
        }),
      );
    },
    async list(prefix) {
      const out: Array<{ key: string; lastModified: Date }> = [];
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (o.Key && o.LastModified) out.push({ key: o.Key, lastModified: o.LastModified });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: config.bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
    async get(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      return Buffer.from(await res.Body!.transformToByteArray());
    },
  };
}

export interface BackupStatus {
  configured: boolean;
  location?: string;
  schedule?: string;
  keepDays?: number;
  running: boolean;
  lastSuccessAt?: string;
  lastKey?: string;
  lastError?: string;
  lastErrorAt?: string;
  nextRunAt?: string;
}

/** Nightly, encrypted, gzip-compressed snapshots of the database with automatic retention. */
export class BackupService {
  private cron?: Cron;
  private status: BackupStatus;

  constructor(
    private readonly store: Store,
    private readonly config: BackupConfig,
    private readonly target: BackupTarget,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.status = {
      configured: true,
      location: `s3://${config.bucket}/${config.prefix}`,
      schedule: config.cron,
      keepDays: config.keepDays,
      running: false,
    };
  }

  start(): void {
    this.cron = new Cron(this.config.cron, { protect: true }, () => void this.runNow().catch(() => undefined));
  }

  stop(): void {
    this.cron?.stop();
  }

  getStatus(): BackupStatus {
    return { ...this.status, nextRunAt: this.cron?.nextRun()?.toISOString() };
  }

  async runNow(): Promise<string> {
    if (this.status.running) throw new Error("A backup is already running");
    this.status.running = true;
    try {
      // The store lives in memory, so serializing it gives a consistent snapshot.
      const body = gzipSync(Buffer.from(JSON.stringify(this.store.data)));
      const key = `${this.config.prefix}db-${nowIso().replace(/[:.]/g, "-")}.json.gz`;
      await this.target.put(key, body);
      await this.prune();
      this.status = { ...this.status, lastSuccessAt: nowIso(), lastKey: key, lastError: undefined, lastErrorAt: undefined };
      this.log(`Backup written to s3://${this.config.bucket}/${key} (${body.length} bytes)`);
      return key;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status = { ...this.status, lastError: message, lastErrorAt: nowIso() };
      this.log(`Backup failed: ${message}`);
      throw err;
    } finally {
      this.status.running = false;
    }
  }

  private async prune(): Promise<void> {
    if (!(this.config.keepDays > 0)) return;
    const cutoff = Date.now() - this.config.keepDays * 24 * 60 * 60 * 1000;
    const objects = await this.target.list(this.config.prefix);
    const old = objects.filter((o) => /\/?db-[^/]+\.json\.gz$/.test(o.key) && o.lastModified.getTime() < cutoff);
    // Never delete the only backups we have, even if they are old.
    if (old.length && old.length < objects.length) await this.target.remove(old.map((o) => o.key));
  }
}

/** Downloads a backup ("latest" or a key) and returns the parsed database. */
export async function fetchBackup(target: BackupTarget, config: BackupConfig, which: string): Promise<{ key: string; data: Data }> {
  let key = which;
  if (which === "latest") {
    const objects = (await target.list(config.prefix)).filter((o) => o.key.endsWith(".json.gz"));
    objects.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    if (!objects[0]) throw new Error(`No backups found under s3://${config.bucket}/${config.prefix}`);
    key = objects[0].key;
  }
  const data = JSON.parse(gunzipSync(await target.get(key)).toString("utf8")) as Data;
  if (!data || typeof data !== "object" || !("workflows" in data) || !("jobs" in data)) {
    throw new Error(`${key} does not look like a ZamTech AI backup`);
  }
  return { key, data };
}
