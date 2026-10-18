import { Hono } from 'hono';
import { q } from '../db/index.ts';

// Messaging health for operators. Mounted at /api/admin by server.ts, behind the dashboard login.
//   GET /messages  the last 100 outbound delivery records (never the text)
//   GET /inbound   inbound iMessages that didn't finish: 'failed', or 'processing' (in flight, or cut off by a
//                  crash; never replayed automatically, so ask the person to resend if needed)

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
