/**
 * Sends the platform's own emails (verify your email, reset your password).
 *
 * Configure any SMTP service, e.g. Amazon SES, Microsoft 365, SendGrid:
 *   SMTP_URL    smtps://USER:PASSWORD@email-smtp.us-east-2.amazonaws.com:465
 *               (or smtp://...:587 for STARTTLS; URL-encode special characters)
 *   MAIL_FROM   "ZamTech AI <no-reply@zamtechai.com>"
 * Google Workspace: smtps://you%40company.com:APPPASSWORD@smtp.gmail.com:465 (an app password).
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** A formatted version (product updates); mail programs that cannot show it use the text. */
  html?: string;
  /** Extra headers, e.g. List-Unsubscribe for one-click unsubscribe. */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private transport: Transporter;

  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }

  async send(mail: Mail): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html, headers: mail.headers });
  }

  /** Signs in to the SMTP server without sending anything. */
  async check(): Promise<void> {
    await this.transport.verify();
  }
}

/**
 * Reads SMTP_URL. Spaces are dropped (app passwords are shown with spaces). A value
 * that is not a usable address never stops the server: `problem` says why email is off,
 * without repeating the password.
 */
export function readSmtpUrl(value: string | undefined): { url?: string; host?: string; problem?: string } {
  if (!value) return {};
  const url = value.replace(/\s+/g, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { problem: "SMTP_URL is not a valid address; it should look like smtps://USER:PASSWORD@smtp.example.com:465 (with @ in the user name written as %40)" };
  }
  if (parsed.protocol !== "smtp:" && parsed.protocol !== "smtps:") return { problem: "SMTP_URL must start with smtps:// or smtp://" };
  if (!parsed.hostname) return { problem: "SMTP_URL has no server name" };
  if (!parsed.username || !parsed.password) return { problem: `SMTP_URL for ${parsed.hostname} has no user name or password` };
  return { url, host: parsed.hostname };
}

let lastProblem: string | undefined;
/** Why email is off although SMTP_URL is set (for the startup log). */
export const mailerProblem = () => lastProblem;

export function loadMailer(env = process.env): SmtpMailer | null {
  const { url, problem } = readSmtpUrl(env.SMTP_URL);
  lastProblem = problem;
  if (!url) return null;
  try {
    return new SmtpMailer(url, env.MAIL_FROM || "ZamTech AI <no-reply@zamtechai.com>");
  } catch (err) {
    lastProblem = `SMTP_URL could not be used: ${(err as Error).message.split(url).join("***")}`;
    return null;
  }
}

/** Plain-text emails, short and in English (the Portal is translated; mail is not yet). */
export const emails = {
  verify: (name: string, link: string): Omit<Mail, "to"> => ({
    subject: "Confirm your email for ZamTech AI",
    text: `Hello ${name},\n\nPlease confirm your email address to start using ZamTech AI:\n\n${link}\n\nThe link works for 24 hours. If you did not create an account, ignore this email.\n\nZamTech AI`,
  }),
  reset: (name: string, link: string): Omit<Mail, "to"> => ({
    subject: "Reset your ZamTech AI password",
    text: `Hello ${name},\n\nSomeone (hopefully you) asked to reset your ZamTech AI password. Choose a new one here:\n\n${link}\n\nThe link works for 1 hour. If you did not ask for this, ignore this email; your password stays the same.\n\nZamTech AI`,
  }),
  approval: (name: string, what: string, requestedBy: string, link: string): Omit<Mail, "to"> => ({
    subject: `Approval needed: ${what} to Production`,
    text: `Hello ${name},\n\n${requestedBy} asks to put ${what} into Production. Review it here:\n\n${link}\n\nZamTech AI`,
  }),
};
