import { createServer as httpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db.ts';
import './state.ts';
import { consent, setStep } from './onboarding.ts';
import { sendMessage } from './send.ts';
export function createServer(
  ready: () => boolean,
  adminToken = process.env.ADMIN_TOKEN,
) {
  const origins = (
    process.env.JOIN_ORIGINS ??
    'https://joinmixr.club,https://www.joinmixr.club'
  )
    .split(',')
    .map((o) => o.trim());
  const allowed = (o = '') =>
    origins.includes(o) ||
    (process.env.NODE_ENV !== 'production' &&
      /^http:\/\/localhost(:\d+)?$/.test(o));
  // ponytail: in-memory per-process limit; move to DB if we run >1 instance
  const hits = new Map<string, number[]>();
  return httpServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/join' && ['OPTIONS', 'POST'].includes(req.method!)) {
      res.setHeader('Vary', 'Origin');
      if (allowed(req.headers.origin))
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin!);
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.statusCode = 204;
        res.end();
        return;
      }
      const ip =
        String(req.headers['x-forwarded-for'] ?? '')
          .split(',')[0]
          .trim() ||
        req.socket.remoteAddress ||
        '';
      const now = Date.now();
      const recent = (hits.get(ip) ?? []).filter((t) => now - t < 600_000);
      if (hits.size > 10_000) hits.clear();
      hits.set(ip, [...recent, now]);
      if (recent.length >= 5) {
        res.statusCode = 429;
        res.end('{"error":"Too many tries. Text us instead."}');
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) {
          res.statusCode = 413;
          res.setHeader('Connection', 'close');
          res.end('{"error":"Request too large."}');
          return;
        }
      }
      let raw = '';
      try {
        const phone = JSON.parse(body)?.phone;
        if (typeof phone === 'string') raw = phone.trim();
      } catch {}
      // ponytail: bare 10/11-digit numbers assume US (+1); other countries must type +E.164
      const digits = raw.replace(/\D/g, '');
      const phone = raw.startsWith('+')
        ? '+' + digits
        : digits.length === 10
          ? '+1' + digits
          : digits.length === 11 && digits[0] === '1'
            ? '+' + digits
            : '';
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        res.statusCode = 400;
        res.end('{"error":"Enter a US phone number."}');
        return;
      }
      try {
        db.prepare(
          'INSERT INTO users(phone) VALUES (?) ON CONFLICT(phone) DO NOTHING',
        ).run(phone);
        const user = db.prepare('SELECT * FROM users WHERE phone=?').get(phone)!;
        // join: dedupe key means /join texts a given number at most once, ever.
        if (user.step === 'new' && !user.opted_out) {
          setStep(Number(user.id), 'consent');
          await sendMessage(Number(user.id), consent, `join:${phone}`);
        }
      } catch {
        console.error('Join request failed.');
        res.statusCode = 500;
        res.end('{"error":"Something went wrong. Text us instead."}');
        return;
      }
      // Same answer for every valid number so this cannot probe who is registered.
      res.statusCode = 202;
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.statusCode = ready() ? 200 : 503;
      res.end(JSON.stringify({ ready: ready() }));
      return;
    }
    if (
      req.method === 'GET' &&
      ['/admin/messages', '/admin/inbound'].includes(url.pathname)
    ) {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${adminToken ?? ''}`);
      if (
        !adminToken ||
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        res.statusCode = 401;
        res.end('{"error":"Unauthorized"}');
        return;
      }
      const rows =
        url.pathname === '/admin/messages'
          ? db
              .prepare(
                'SELECT id,user_id,dedupe_key,status,attempts,error,created_at,sent_at FROM message_jobs ORDER BY id DESC LIMIT 100',
              )
              .all()
          : db
              .prepare(
                "SELECT provider_id,status,error FROM inbound_processing WHERE status<>'done' LIMIT 100",
              )
              .all();
      res.end(JSON.stringify(rows));
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"Not found"}');
  });
}
