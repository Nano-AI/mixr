import { config } from '../config.ts';
import { db, q } from '../db/index.ts';

// Start the real pool over: every real user (website + iMessage), everything they touched, and their Photon
// shared-line registrations. Demo users are untouched. Run with the server STOPPED (PGlite allows one process).

export async function resetRealDb(): Promise<{ users: number }> {
  const [{ n }] = await q<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE NOT seeded');
  await (await db()).exec(
    `DELETE FROM screenings WHERE user_id IN (SELECT id FROM users WHERE NOT seeded)
       OR requirement_id IN (SELECT r.id FROM requirements r JOIN users u ON u.id = r.owner_id WHERE NOT u.seeded);
     DELETE FROM requirements WHERE owner_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM blocks WHERE blocker_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM event_invites WHERE user_id IN (SELECT id FROM users WHERE NOT seeded)
       OR event_id IN (SELECT e.id FROM events e JOIN users u ON u.id = e.host_id WHERE NOT u.seeded);
     DELETE FROM intros WHERE requester_id IN (SELECT id FROM users WHERE NOT seeded) OR target_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM message_jobs WHERE user_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM email_codes WHERE user_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM events WHERE host_id IN (SELECT id FROM users WHERE NOT seeded);
     DELETE FROM inbound_messages;
     DELETE FROM jobs WHERE pool = 'real';
     DELETE FROM traces WHERE pool = 'real' AND kind NOT IN ('llm', 'embed');
     DELETE FROM users WHERE NOT seeded;`,
  );
  return { users: n };
}

// Removes one real user (by phone) and everything tied to them. Demo users can't be targeted. Server STOPPED.
export async function deleteRealUser(phone: string): Promise<{ deleted: boolean }> {
  const u = (await q<{ id: number; seeded: boolean }>('SELECT id, seeded FROM users WHERE phone = $1', [phone]))[0];
  if (!u) return { deleted: false };
  if (u.seeded) throw new Error('that number belongs to a demo user; refusing');
  const id = u.id;
  await q(`DELETE FROM screenings WHERE user_id = $1 OR requirement_id IN (SELECT id FROM requirements WHERE owner_id = $1)`, [id]);
  await q(`DELETE FROM requirements WHERE owner_id = $1`, [id]);
  await q(`DELETE FROM blocks WHERE blocker_id = $1`, [id]);
  await q(`DELETE FROM event_invites WHERE user_id = $1 OR event_id IN (SELECT id FROM events WHERE host_id = $1)`, [id]);
  await q(`DELETE FROM intros WHERE requester_id = $1 OR target_id = $1`, [id]);
  await q(`DELETE FROM message_jobs WHERE user_id = $1`, [id]);
  await q(`DELETE FROM email_codes WHERE user_id = $1`, [id]);
  await q(`DELETE FROM messages WHERE user_id = $1`, [id]);
  await q(`DELETE FROM events WHERE host_id = $1`, [id]);
  await q(`DELETE FROM inbound_messages WHERE phone = $1`, [phone]);
  await q(`DELETE FROM traces WHERE kind = 'agent' AND ref_id = $1 AND pool = 'real'`, [id]);
  await q(`DELETE FROM users WHERE id = $1`, [id]);
  return { deleted: true };
}

const API = 'https://spectrum.photon.codes';

// Deletes every user registered on the Photon project (frees the shared-line slots).
export async function resetPhotonUsers(fetchImpl: typeof fetch = fetch): Promise<{ deleted: string[] }> {
  if (!config.photonProjectId || !config.photonProjectSecret) throw new Error('PROJECT_ID / PROJECT_SECRET not set');
  const auth = 'Basic ' + Buffer.from(`${config.photonProjectId}:${config.photonProjectSecret}`).toString('base64');
  const base = `${API}/projects/${config.photonProjectId}/users`;
  const list = await fetchImpl(`${base}/`, { headers: { Authorization: auth } });
  if (!list.ok) throw new Error(`Photon list users failed (HTTP ${list.status})`);
  const users = ((await list.json()) as { data: { users: { id: string; phoneNumber: string }[] } }).data.users;
  const deleted: string[] = [];
  for (const u of users) {
    const r = await fetchImpl(`${base}/${u.id}/`, { method: 'DELETE', headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`Photon delete user ..${u.phoneNumber.slice(-4)} failed (HTTP ${r.status})`);
    deleted.push(`..${u.phoneNumber.slice(-4)}`);
  }
  return { deleted };
}
