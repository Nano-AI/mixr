import { fromVec, one, q } from '../db/index.ts';
import type { EventRow } from '../types.ts';

// Event row helpers shared by waves, RSVPs and host controls.

const EVENT_COLS =
  'id, host_id, title, raw_description, starts_at, location, capacity, hyde_profile, status, wave_number, next_wave_at, thin_pool_notified';

export type EventFull = EventRow & { thinPoolNotified: boolean };

export function rowToEvent(r: Record<string, any>): EventFull {
  return {
    id: r.id,
    hostId: r.host_id,
    title: r.title,
    rawDescription: r.raw_description,
    startsAt: new Date(r.starts_at),
    location: r.location,
    capacity: r.capacity,
    hydeProfile: r.hyde_profile,
    status: r.status,
    waveNumber: r.wave_number,
    nextWaveAt: r.next_wave_at ? new Date(r.next_wave_at) : null,
    thinPoolNotified: r.thin_pool_notified,
  };
}

export const toEventRow = ({ thinPoolNotified: _, ...e }: EventFull): EventRow => e;

export async function loadEvent(id: number): Promise<EventFull | undefined> {
  const r = await one(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [id]);
  return r && rowToEvent(r);
}

export async function loadVectors(id: number): Promise<{ e0: number[]; et: number[] }> {
  const r = await one<{ e0: string; et: string }>(
    'SELECT initial_embedding::text AS e0, current_embedding::text AS et FROM events WHERE id = $1',
    [id],
  );
  return { e0: fromVec(r!.e0)!, et: fromVec(r!.et)! };
}

export async function goingCount(eventId: number): Promise<number> {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM event_invites WHERE event_id = $1 AND status = 'yes'`, [eventId]);
  return r!.n;
}

export async function goingNames(eventId: number): Promise<string[]> {
  const rows = await q<{ name: string | null }>(
    `SELECT u.name FROM event_invites i JOIN users u ON u.id = i.user_id
     WHERE i.event_id = $1 AND i.status = 'yes' ORDER BY i.responded_at, u.id`,
    [eventId],
  );
  return rows.map((r) => r.name ?? '');
}

export async function pendingCount(eventId: number): Promise<number> {
  const r = await one<{ n: number }>(`SELECT count(*)::int AS n FROM event_invites WHERE event_id = $1 AND status = 'invited'`, [eventId]);
  return r!.n;
}

export async function setStatus(eventId: number, status: EventRow['status']): Promise<void> {
  await q('UPDATE events SET status = $2 WHERE id = $1', [eventId, status]);
}

export async function userName(userId: number): Promise<string | null> {
  return (await one<{ name: string | null }>('SELECT name FROM users WHERE id = $1', [userId]))?.name ?? null;
}
