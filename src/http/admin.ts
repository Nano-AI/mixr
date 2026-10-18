import { Hono } from 'hono';
import { getUserByPhone, one, q } from '../db/index.ts';
import { runIn } from '../context.ts';
import { send } from '../transport/index.ts';

// Messaging health for operators. Mounted at /api/admin by server.ts, behind the dashboard login.
//   GET /messages  the last 100 outbound delivery records (never the text)
//   GET /inbound   inbound iMessages that didn't finish: 'failed', or 'processing' (in flight, or cut off by a
//                  crash; never replayed automatically, so ask the person to resend if needed)
//   POST /send     operator message to one real user ({phone, text}); delivered like any mixr text (outbox,
//                  opt-out respected) and returns the delivery record. For support and for unsticking a
//                  conversation; mixr itself still never texts first.

const LIMIT = 100;
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export const adminApi = new Hono();

adminApi.get('/messages', async (c) => {
  const rows = await q(
    `SELECT id, user_id, message_id, dedupe_key, status, attempts, error, even_if_opted_out, created_at, sent_at
       FROM message_jobs ORDER BY id DESC LIMIT $1`,
    [LIMIT],
  );
  return c.json(
    rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      messageId: r.message_id,
      dedupeKey: r.dedupe_key,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      evenIfOptedOut: r.even_if_opted_out,
      createdAt: iso(r.created_at),
      sentAt: iso(r.sent_at),
    })),
  );
});

adminApi.get('/inbound', async (c) => {
  const rows = await q(
    `SELECT provider_id, phone, status, error, received_at FROM inbound_messages WHERE status <> 'done' ORDER BY received_at DESC LIMIT $1`,
    [LIMIT],
  );
  return c.json(rows.map((r) => ({ providerId: r.provider_id, phone: r.phone, status: r.status, error: r.error, receivedAt: iso(r.received_at) })));
});

adminApi.post('/send', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!phone || !text || text.length > 1000) return c.json({ ok: false, error: 'phone and text (<= 1000 chars) are required' }, 400);
  const u = await getUserByPhone(phone);
  if (!u || u.seeded) return c.json({ ok: false, error: 'no real user with that phone' }, 404);
  if (u.optedOut) return c.json({ ok: false, error: 'user opted out (STOP)' }, 409);
  const key = `admin:${u.id}:${Date.now()}`;
  await runIn({ pool: 'real', deliver: true }, () => send(u.id, text, { dedupeKey: key }));
  const job = await one(`SELECT status, attempts, error FROM message_jobs WHERE dedupe_key = $1`, [key]);
  return c.json({ ok: true, delivery: job ?? { status: 'not queued (transport is not photon?)' } });
});
