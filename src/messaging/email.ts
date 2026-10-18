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
    const { subject, text, html } = verificationEmail(email, code);
    if (p === 'gmail') {
      if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error('Gmail requires GMAIL_USER and GMAIL_APP_PASSWORD');
      const mail: SendMailOptions = { from: { name: 'mixr', address: env.GMAIL_USER }, to: email, subject, text, html };
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
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text, html }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Verification email failed (HTTP ${res.status})`);
  };
}

// The verification email. Hand-written for mail clients: tables, inline styles, no external CSS/JS, far under Gmail's
// 102KB clip. The <style> block only adds extras (dark mode for Apple Mail, phone padding); it all reads without it.
// The subject leads with the code so it shows in the notification banner and inbox list without opening the email.
const CODE_TTL_TEXT = '10 minutes'; // keep in step with CODE_TTL_MS in onboarding.ts
const ICON_URL = 'https://www.joinmixr.club/brand/mixr-email-icon.png';
const SITE_URL = 'https://joinmixr.club';
const SERIF = "Newsreader,Georgia,'Times New Roman',serif";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = 'rgb(34,39,43)';
const MUTED = '#676a71';
const PAGE = '#f5f6fb';
const LINE = '#e6e8f0';
const LILAC = '#b3a8f5'; // solid fallback where gradients are dropped (Outlook)
const GRADIENT = 'linear-gradient(135deg,#94adff 0%,#b3a8f5 38%,#ffb3e0 72%,#ffd6b3 100%)';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (ch) => ENTITIES[ch]!);

export function verificationEmail(email: string, code: string): { subject: string; text: string; html: string } {
  const subject = `${code} is your mixr code`;
  const lead = `expires in ${CODE_TTL_TEXT}. reply with it in your mixr thread.`;
  const ignore = "didn't ask for this? you can ignore this email.";
  const text = `your mixr code: ${code}\n\n${lead}\n\nsent to ${email}. ${ignore}\n\nStarted at the University of Washington · joinmixr.club\n`;
  const c = escapeHtml(code);
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>.serif{font-family:Georgia,serif!important}.sans{font-family:Arial,sans-serif!important}</style><![endif]-->
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0!important;padding:0!important;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
@media (max-width:480px){.pad{padding:32px 24px 28px!important}.code{font-size:34px!important;letter-spacing:8px!important;margin-right:-8px!important}}
@media (prefers-color-scheme:dark){
.bg{background:#121316!important}
.card{background:#1b1d21!important;border-color:#2a2d33!important}
.ink{color:#f1f2f6!important}
.muted{color:#9a9ca4!important}
.codebox{background:#232529!important;border-color:#33363d!important}
}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE}">your code is ${c}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background:${PAGE}">
<tr><td align="center" style="padding:40px 16px">
<!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px">
<tr><td class="card" bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${LINE};border-radius:20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="pad" style="padding:40px 40px 36px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="44" height="44" bgcolor="${LILAC}" style="width:44px;height:44px;border-radius:10px;background-color:${LILAC};background-image:${GRADIENT}"><img src="${ICON_URL}" width="44" height="44" alt="mixr" style="display:block;width:44px;height:44px;border:0;border-radius:10px;color:#ffffff;font:600 13px/44px ${SANS};text-align:center"></td>
</tr></table>
<h1 class="ink serif" style="margin:28px 0 0;font:400 30px/1.15 ${SERIF};letter-spacing:-0.02em;color:${INK}">your mixr code</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0">
<tr><td class="codebox" align="center" bgcolor="${PAGE}" style="padding:22px 12px;background:${PAGE};border:1px solid ${LINE};border-radius:14px">
<div class="code ink sans" style="font:600 40px/1 ${SANS};letter-spacing:12px;margin-right:-12px;color:${INK};font-variant-numeric:tabular-nums">${c}</div>
</td></tr>
</table>
<p class="ink sans" style="margin:24px 0 0;font:400 16px/1.5 ${SANS};color:${INK}">${escapeHtml(lead)}</p>
<p class="muted sans" style="margin:12px 0 0;font:400 14px/1.5 ${SANS};color:${MUTED}">sent to ${escapeHtml(email)}. ${escapeHtml(ignore)}</p>
</td></tr>
</table>
</td></tr>
<tr><td align="center" class="muted serif" style="padding:24px 16px 0;font:400 14px/1.5 ${SERIF};color:${MUTED}">Started at the University of Washington&nbsp;&middot;&nbsp;<a class="muted" href="${SITE_URL}" style="color:${MUTED};text-decoration:none">joinmixr.club</a></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
  return { subject, text, html };
}
