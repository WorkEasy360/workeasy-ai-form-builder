import { createTransport } from "nodemailer";

/**
 * Notification email (docs/05 §6) through a trusted SMTP relay (Mailpit
 * locally). Messages are plain text built from fixed templates:
 * no HTML, so nothing a respondent typed can inject markup, and recipients
 * come only from the integration's fixed list, never from answers. A message
 * the relay accepted is "accepted", not "delivered": bounces arrive later.
 */
export interface MailerSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: string;
}

export interface Mailer {
  send(message: { to: string[]; subject: string; text: string; messageId: string }): Promise<MailResult>;
}

export type MailResult = { ok: true } | { ok: false; code: string; retryable: boolean; statusCode?: number | undefined };

/** Removes line breaks and control characters, so a value cannot add headers. */
export function headerSafe(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code >= 32 && code !== 127) out += ch;
    else if (!out.endsWith(" ")) out += " ";
  }
  return out.trim().slice(0, max);
}

export function createMailer(settings: MailerSettings): Mailer {
  const transport = createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    async send(message) {
      try {
        await transport.sendMail({
          from: settings.from,
          to: message.to,
          subject: headerSafe(message.subject),
          text: message.text,
          messageId: message.messageId,
        });
        return { ok: true };
      } catch (err) {
        const e = err as { responseCode?: number; code?: string };
        if (typeof e.responseCode === "number") {
          // 4xx: try later; 5xx: the relay refused for good.
          return { ok: false, code: `smtp_${e.responseCode}`, retryable: e.responseCode < 500, statusCode: e.responseCode };
        }
        return { ok: false, code: e.code === "EAUTH" ? "smtp_auth_failed" : "smtp_unavailable", retryable: e.code !== "EAUTH" };
      }
    },
  };
}
