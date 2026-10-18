import { q, one, getUser } from '../db/index.ts';
import { publish } from '../bus.ts';
import { now } from '../clock.ts';
import { queueDelivery } from './outbox.ts';

// The seam between mixr and a phone. Every message is logged here (the dashboard reads it); outbound texts to
// real users are additionally queued for iMessage delivery by the outbox when the context allows it.

export type SendOpts = {
  dedupeKey?: string; // one logical notification = one key, so retries and replays never double-text
  evenIfOptedOut?: boolean; // only the STOP acknowledgement
};

export async function send(userId: number, text: string, opts: SendOpts = {}): Promise<void> {
  const messageId = await log(userId, 'out', text);
  await queueDelivery(userId, messageId, text, opts);
}

// via: 'dashboard' when someone typed it in the simulator rather than on a phone.
export async function recordInbound(userId: number, text: string, via: 'phone' | 'dashboard' = 'phone'): Promise<void> {
  await log(userId, 'in', text, via);
}

async function log(userId: number, direction: 'in' | 'out', text: string, via = 'system'): Promise<number> {
  const t = (await now()).toISOString();
  const r = await one<{ id: number }>('INSERT INTO messages (user_id, direction, text, sim_time, via) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
    userId,
    direction,
    text,
    t,
    direction === 'out' ? 'system' : via,
  ]);
  const u = await getUser(userId);
  publish({ type: 'message', userId, phone: u?.phone ?? '', direction, text, simTime: t });
  return r!.id;
}

export async function history(userId: number, limit = 30): Promise<{ direction: 'in' | 'out'; text: string; simTime: string }[]> {
  const rows = await q<{ direction: 'in' | 'out'; text: string; sim_time: string }>(
    'SELECT direction, text, sim_time FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
    [userId, limit],
  );
  return rows.reverse().map((r) => ({ direction: r.direction, text: r.text, simTime: new Date(r.sim_time).toISOString() }));
}
