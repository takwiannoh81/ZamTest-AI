import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type { ActionContext, ActionHandler } from "@zamtest/core";

interface Credential {
  username: string;
  password: string;
}

async function credential(ctx: ActionContext, name: unknown): Promise<Credential> {
  if (!ctx.services.getAsset) throw new Error("Email actions read their password from a credential asset, which needs the orchestrator");
  const value = (await ctx.services.getAsset(String(name))) as Partial<Credential> | undefined;
  if (!value?.username || !value.password) throw new Error(`Asset "${name}" must be a credential with a username and password`);
  return { username: value.username, password: value.password };
}

function hostPort(server: unknown, defaultPort: number): { host: string; port: number } {
  const [host, port] = String(server).trim().split(":");
  if (!host) throw new Error("Server is required, e.g. smtp.example.com:587");
  return { host, port: port ? Number(port) : defaultPort };
}

const list = (value: unknown) =>
  (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((v) => String(v).trim())
    .filter(Boolean);

export const emailHandlers: Record<string, ActionHandler> = {
  "email.send": async (props, ctx) => {
    const cred = await credential(ctx, props.credential);
    const { host, port } = hostPort(props.server, 587);
    const transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: cred.username, pass: cred.password } });
    const attachments = props.attachments ? list(props.attachments).map((path) => ({ path, filename: basename(path) })) : undefined;
    const info = await transport.sendMail({
      from: props.from ? String(props.from) : cred.username,
      to: list(props.to),
      cc: props.cc ? list(props.cc) : undefined,
      subject: String(props.subject ?? ""),
      ...(props.html ? { html: String(props.body ?? "") } : { text: String(props.body ?? "") }),
      attachments,
    });
    ctx.log("info", `Email sent to ${list(props.to).join(", ")}`);
    return { messageId: info.messageId, accepted: info.accepted };
  },

  "email.read": async (props, ctx) => {
    const cred = await credential(ctx, props.credential);
    const { host, port } = hostPort(props.server, 993);
    const client = new ImapFlow({ host, port, secure: port === 993, auth: { user: cred.username, pass: cred.password }, logger: false });
    await client.connect();
    const lock = await client.getMailboxLock(String(props.folder || "INBOX"));
    try {
      const found = await client.search(props.unreadOnly === false ? { all: true } : { seen: false }, { uid: true });
      const uids = (found || []).slice(-Math.max(1, Number(props.limit ?? 10))).reverse(); // newest first
      const folder = props.attachmentsFolder ? String(props.attachmentsFolder) : undefined;
      if (folder) await mkdir(folder, { recursive: true });
      const messages = [];
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const attachments = [];
        for (const a of mail.attachments) {
          const entry: { filename: string; size: number; path?: string } = { filename: a.filename ?? "attachment", size: a.size };
          if (folder) {
            entry.path = join(folder, `${uid}-${basename(entry.filename)}`);
            await writeFile(entry.path, a.content);
          }
          attachments.push(entry);
        }
        messages.push({
          uid,
          from: mail.from?.text ?? "",
          to: Array.isArray(mail.to) ? mail.to.map((t) => t.text).join(", ") : (mail.to?.text ?? ""),
          subject: mail.subject ?? "",
          date: mail.date?.toISOString(),
          text: mail.text ?? "",
          attachments,
        });
      }
      if (props.markAsRead && uids.length) await client.messageFlagsAdd(uids.map(String).join(","), ["\\Seen"], { uid: true });
      ctx.log("info", `Read ${messages.length} message(s) from ${props.folder || "INBOX"}`);
      return messages;
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  },
};
