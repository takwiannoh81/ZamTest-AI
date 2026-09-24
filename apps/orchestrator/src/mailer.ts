/**
 * Sends the platform's own emails (verify your email, reset your password).
 *
 * Configure any SMTP service, e.g. Amazon SES, Microsoft 365, SendGrid:
 *   SMTP_URL    smtps://USER:PASSWORD@email-smtp.us-east-2.amazonaws.com:465
 *               (or smtp://...:587 for STARTTLS; URL-encode special characters)
 *   MAIL_FROM   "ZamTech AI <no-reply@zamtechai.com>"
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface Mail {
  to: string;
  subject: string;
  text: string;
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
    await this.transport.sendMail({ from: this.from, to: mail.to, subject: mail.subject, text: mail.text });
  }
}

export function loadMailer(env = process.env): Mailer | null {
  if (!env.SMTP_URL) return null;
  return new SmtpMailer(env.SMTP_URL, env.MAIL_FROM || "ZamTech AI <no-reply@zamtechai.com>");
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
