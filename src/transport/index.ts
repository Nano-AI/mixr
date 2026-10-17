import { q, getUser } from '../db/index.ts';
import { publish } from '../bus.ts';
import { now } from '../clock.ts';

// The seam between mixr and a phone. Today it's the simulator (messages table + SSE to the dashboard).
// A Photon/SMS adapter later only has to deliver `send` and call agent.handleInbound for incoming texts.

export async function send(userId: number, text: string): Promise<void> {
  await log(userId, 'out', text);
}

export async function recordInbound(userId: number, text: string): Promise<void> {
  await log(userId, 'in', text);
}

async function log(userId: number, direction: 'in' | 'out', text: string): Promise<void> {
  const t = (await now()).toISOString();
  await q('INSERT INTO messages (user_id, direction, text, sim_time) VALUES ($1, $2, $3, $4)', [userId, direction, text, t]);
  const u = await getUser(userId);
  publish({ type: 'message', userId, phone: u?.phone ?? '', direction, text, simTime: t });
}

export async function history(userId: number, limit = 30): Promise<{ direction: 'in' | 'out'; text: string; simTime: string }[]> {
  const rows = await q<{ direction: 'in' | 'out'; text: string; sim_time: string }>(
    'SELECT direction, text, sim_time FROM messages WHERE user_id = $1 ORDER BY id DESC LIMIT $2',
    [userId, limit],
  );
  return rows.reverse().map((r) => ({ direction: r.direction, text: r.text, simTime: new Date(r.sim_time).toISOString() }));
}
