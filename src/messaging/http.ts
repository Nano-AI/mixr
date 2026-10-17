import { createServer as httpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db.ts';
import './state.ts';
export function createServer(
  ready: () => boolean,
  adminToken = process.env.ADMIN_TOKEN,
) {
  return httpServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://localhost');
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
