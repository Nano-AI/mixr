import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';
import '../config.ts'; // loads .env into process.env outside tests

// UW email verification codes, over Gmail SMTP (465, TLS, app password) or Resend's HTTP API.
// Fails closed: unconfigured or rejected delivery throws, and the caller never treats the address as verified.
// Codes never appear in logs or error messages.

type Environment = Record<string, string | undefined>;
type SendMail = (mail: SendMailOptions) => Promise<unknown>;
export type CodeSender = (email: string, code: string) => Promise<void>;

const SMTP_CONNECT_MS = 15_000; // tune:
const SMTP_SOCKET_MS = 20_000; // tune:
const RESEND_TIMEOUT_MS = 15_000; // tune:

const provider = (env: Environment): string => env.EMAIL_PROVIDER ?? 'resend';

export function emailConfigured(env: Environment = process.env): boolean {
  const p = provider(env);
  if (p === 'gmail') return !!env.GMAIL_USER && !!env.GMAIL_APP_PASSWORD;
  if (p === 'resend') return !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
  return false;
}

// sendMail: test seam for the Gmail path (receives the composed message instead of opening an SMTP connection).
export function createEmailSender(env: Environment = process.env, sendMail?: SendMail): CodeSender {
  return async (email: string, code: string): Promise<void> => {
    const p = provider(env);
    const subject = 'Your mixr verification code';
    const text = `Your mixr code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`;
    if (p === 'gmail') {
      if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error('Gmail requires GMAIL_USER and GMAIL_APP_PASSWORD');
      const mail: SendMailOptions = { from: { name: 'mixr', address: env.GMAIL_USER }, to: email, subject, text };
      if (sendMail) {
        await sendMail(mail);
        return;
      }
      const transport = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s/g, '') },
        connectionTimeout: SMTP_CONNECT_MS,
        greetingTimeout: SMTP_CONNECT_MS,
        socketTimeout: SMTP_SOCKET_MS,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      try {
        const result = await transport.sendMail(mail);
        if (!result.accepted.length || result.rejected.length) throw new Error('Gmail did not accept the verification email');
      } finally {
        transport.close();
      }
      return;
    }
    if (p !== 'resend') throw new Error('Unknown EMAIL_PROVIDER; use gmail or resend');
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error('Verification email is not configured (RESEND_API_KEY, EMAIL_FROM)');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Verification email failed (HTTP ${res.status})`);
  };
}
