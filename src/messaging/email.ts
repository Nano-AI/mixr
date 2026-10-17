import nodemailer from 'nodemailer';
import type { SendMailOptions } from 'nodemailer';

type Environment = Record<string, string | undefined>;
type SendMail = (mail: SendMailOptions) => Promise<unknown>;

export function emailConfigured(env: Environment = process.env): boolean {
  const provider = env.EMAIL_PROVIDER ?? 'resend';
  if (provider === 'gmail') return !!env.GMAIL_USER && !!env.GMAIL_APP_PASSWORD;
  if (provider === 'resend') return !!env.RESEND_API_KEY && !!env.EMAIL_FROM;
  return false;
}

export function createEmailSender(
  env: Environment = process.env,
  sendMail?: SendMail,
) {
  return async (email: string, code: string): Promise<void> => {
    const provider = env.EMAIL_PROVIDER ?? 'resend';
    const subject = 'Your Mixr verification code';
    const text = `Your Mixr code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`;
    if (provider === 'gmail') {
      if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD)
        throw Error('Gmail requires GMAIL_USER and GMAIL_APP_PASSWORD');
      const mail = {
        from: { name: 'Mixr', address: env.GMAIL_USER },
        to: email,
        subject,
        text,
      };
      if (sendMail) {
        await sendMail(mail);
        return;
      }
      const transport = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
          user: env.GMAIL_USER,
          pass: env.GMAIL_APP_PASSWORD.replace(/\s/g, ''),
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      try {
        const result = await transport.sendMail(mail);
        if (!result.accepted.length || result.rejected.length)
          throw Error('Gmail did not accept the verification email');
      } finally {
        transport.close();
      }
      return;
    }
    if (provider !== 'resend')
      throw Error('Unknown EMAIL_PROVIDER; use gmail or resend');
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM)
      throw Error('Verification email is not configured');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [email],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw Error(`Verification email failed (HTTP ${response.status})`);
  };
}
export const sendCode = createEmailSender();
