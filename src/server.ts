import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { getUserByPhone, q, reset } from './db/index.ts';
import { now } from './clock.ts';
import { publish, subscribe } from './bus.ts';
import { advance } from './jobs/index.ts';
import { history } from './transport/index.ts';
import { handleInbound } from './agent/index.ts';
// Imported for their side effects too: each registers its job handlers at load time.
import './profiles/index.ts';
import './relay/index.ts';
import './events/index.ts';

const KEEPALIVE_MS = 15_000; // tune: SSE ping interval

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const app = new Hono();

app.use('/api/*', cors({ origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null) }));

app.onError((e, c) => c.json({ ok: false, error: errMsg(e) }, 500));

app.get('/api/state', async (c) => {
  const [users, events, invites, intros, llmRows, embedRow, attendees] = await Promise.all([
    q(`SELECT id, phone, name, state, canonical_profile, snoozed_until, seeded FROM users ORDER BY id`),
    q(
      `SELECT e.id, e.host_id, h.name AS host_name, e.title, e.raw_description, e.starts_at, e.location, e.capacity, e.status,
              e.wave_number, e.next_wave_at, e.hyde_profile,
              (SELECT count(*)::int FROM event_invites i WHERE i.event_id = e.id AND i.status = 'yes') AS going,
              (1 - (e.initial_embedding <=> e.current_embedding))::float8 AS cos_to_e0
         FROM events e JOIN users h ON h.id = e.host_id ORDER BY e.id`,
    ),
    q(
      `SELECT i.event_id, i.user_id, u.name, i.wave, i.status, i.pitch, i.invited_at, i.responded_at, i.source
         FROM event_invites i JOIN users u ON u.id = i.user_id ORDER BY i.event_id, i.wave, i.invited_at, i.user_id`,
    ),
    q(
      `SELECT x.id, r.name AS requester_name, t.name AS target_name, x.reason, x.status
         FROM intros x JOIN users r ON r.id = x.requester_id JOIN users t ON t.id = x.target_id ORDER BY x.id`,
    ),
    q<{ purpose: string; n: number; input: number; output: number }>(
      `SELECT coalesce(data->>'purpose', 'unknown') AS purpose, count(*)::int AS n,
              coalesce(sum((data->'usage'->>'input_tokens')::int), 0)::int AS input,
              coalesce(sum((data->'usage'->>'output_tokens')::int), 0)::int AS output
         FROM traces WHERE kind = 'llm' GROUP BY 1`,
    ),
    q<{ tokens: number }>(`SELECT coalesce(sum((data->>'tokens')::int), 0)::int AS tokens FROM traces WHERE kind = 'embed'`),
    q(
      `SELECT a.event_id, a.user_id, u.name, a.role, a.joined_at, a.source
         FROM event_attendees a JOIN users u ON u.id = a.user_id
        ORDER BY a.event_id, a.role = 'guest', a.joined_at NULLS LAST, a.user_id`,
    ),
  ]);

  const invitesByEvent = new Map<number, unknown[]>();
  for (const i of invites) {
    const list = invitesByEvent.get(i.event_id) ?? [];
    list.push({ userId: i.user_id, name: i.name, wave: i.wave, status: i.status, pitch: i.pitch, invitedAt: iso(i.invited_at), respondedAt: iso(i.responded_at), source: i.source });
    invitesByEvent.set(i.event_id, list);
  }

  const attendeesByEvent = new Map<number, unknown[]>();
  for (const a of attendees) {
    const list = attendeesByEvent.get(a.event_id) ?? [];
    list.push({ userId: a.user_id, name: a.name, role: a.role, joinedAt: iso(a.joined_at), source: a.source });
    attendeesByEvent.set(a.event_id, list);
  }

  return c.json({
    now: (await now()).toISOString(),
    users: users.map((u) => ({
      id: u.id,
      phone: u.phone,
      name: u.name,
      state: u.state,
      profile: u.canonical_profile,
      snoozedUntil: iso(u.snoozed_until),
      seeded: u.seeded,
    })),
    events: events.map((e) => ({
      id: e.id,
      hostId: e.host_id,
      hostName: e.host_name,
      title: e.title,
      description: e.raw_description,
      startsAt: iso(e.starts_at),
      location: e.location,
      capacity: e.capacity,
      status: e.status,
      waveNumber: e.wave_number,
      nextWaveAt: iso(e.next_wave_at),
      hydeProfile: e.hyde_profile,
      going: e.going,
      cosToE0: Number(e.cos_to_e0),
      invites: invitesByEvent.get(e.id) ?? [],
      attendees: attendeesByEvent.get(e.id) ?? [], // host + confirmed guests
    })),
    intros: intros.map((x) => ({ id: x.id, requesterName: x.requester_name, targetName: x.target_name, reason: x.reason, status: x.status })),
    usage: {
      llmCalls: llmRows.reduce((s, r) => s + r.n, 0),
      byPurpose: Object.fromEntries(llmRows.map((r) => [r.purpose, r.n])),
      inputTokens: llmRows.reduce((s, r) => s + r.input, 0),
      outputTokens: llmRows.reduce((s, r) => s + r.output, 0),
      embedTokens: embedRow[0]?.tokens ?? 0,
    },
  });
});

app.get('/api/messages/:phone', async (c) => {
  const u = await getUserByPhone(c.req.param('phone'));
  return c.json(u ? await history(u.id, 1000) : []);
});

app.post('/api/inbound', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!phone || !text) return c.json({ ok: false, error: 'phone and text are required' }, 400);
  try {
    await handleInbound(phone, text);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ ok: false, error: errMsg(e) });
  } finally {
    publish({ type: 'state' });
  }
});

app.post('/api/clock/advance', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const minutes = Number(body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return c.json({ ok: false, error: 'minutes must be a positive number' }, 400);
  const jobsRan = await advance(minutes * 60_000);
  publish({ type: 'state' });
  return c.json({ now: (await now()).toISOString(), jobsRan });
});

app.get('/api/traces', async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 300) || 300, 1), 5000);
  const kind = c.req.query('kind');
  const rows = kind
    ? await q(`SELECT id, sim_time, kind, ref_id, data FROM traces WHERE kind = $1 ORDER BY id DESC LIMIT $2`, [kind, limit])
    : await q(`SELECT id, sim_time, kind, ref_id, data FROM traces ORDER BY id DESC LIMIT $1`, [limit]);
  return c.json(rows.map((r) => ({ id: r.id, simTime: iso(r.sim_time), kind: r.kind, refId: r.ref_id, data: r.data })));
});

app.get('/api/projection', async (c) => {
  const { projection } = await import('./projection.ts');
  return c.json(await projection());
});

app.get('/api/stream', (c) =>
  streamSSE(c, async (stream) => {
    const write = (data: string, event?: string) => stream.writeSSE({ data, event }).catch(() => {});
    const unsub = subscribe((e) => void write(JSON.stringify(e)));
    const ping = setInterval(() => void write('ping', 'ping'), KEEPALIVE_MS);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    unsub();
  }),
);

app.post('/api/reset', async (c) => {
  await reset();
  publish({ type: 'clock', now: (await now()).toISOString() });
  publish({ type: 'state' });
  return c.json({ ok: true });
});

app.post('/api/seed', async (c) => {
  const { seed } = await import('./seed.ts');
  const users = await seed();
  publish({ type: 'state' });
  return c.json({ ok: true, users });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serve({ fetch: app.fetch, port: config.port }, (info) => console.log(`mixr server on http://localhost:${info.port}`));
}
