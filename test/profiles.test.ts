import { test, expect, describe } from 'vitest';
import { fresh, makeUser, axis, T0 } from './helpers.ts';
import { buildProfile, editProfile, evolveFromRsvp, setProfileText, profileSlots, appendSlot } from '../src/profiles/index.ts';
import { getOrCreateUser, getUser, q, toVec } from '../src/db/index.ts';
import { fakeEmbed } from '../src/llm/embed.ts';
import { schedule, runDue } from '../src/jobs/index.ts';
import type { JsonRequest } from '../src/llm/index.ts';

const TENNIS = 'Core Interests:\n[1] Competitive tennis, varsity match play, USTA 4.5, tournament sets (Level: Advanced).';

async function makeEvent(hostId: number, title: string, description: string, hyde: string): Promise<number> {
  const v = toVec(axis(5));
  const r = await q<{ id: number }>(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, created_at)
     VALUES ($1, $2, $3, $4, 'IMA', 4, $5, $6, $6, $7) RETURNING id`,
    [hostId, title, description, new Date(T0.getTime() + 86_400_000).toISOString(), hyde, v, T0.toISOString()],
  );
  return r[0].id;
}

function assertStrictSchema(s: any): void {
  if (s.type === 'object') {
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    for (const p of Object.values(s.properties)) assertStrictSchema(p);
  }
  if (s.type === 'array') assertStrictSchema(s.items);
}

describe('helpers', () => {
  test('profileSlots and appendSlot', () => {
    expect(profileSlots('Core Interests:\n[1] A thing.\n[2] B thing.')).toEqual(['A thing.', 'B thing.']);
    expect(appendSlot('Core Interests:\n[1] A thing.', 'bouldering')).toBe('Core Interests:\n[1] A thing.\n[2] bouldering.');
    expect(appendSlot(null, 'jazz piano')).toBe('Core Interests:\n[1] jazz piano.');
  });
});

describe('buildProfile', () => {
  test('fallback: wraps braindump, sets name + active, embedding matches embed(text)', async () => {
    await fresh();
    const u = await getOrCreateUser('+12065550000');
    expect(u.state).toBe('onboarding');
    const text = await buildProfile(u.id, 'i play tennis and like board games', 'Maya Lopez');
    expect(text).toBe('Core Interests:\n[1] i play tennis and like board games');
    const after = (await getUser(u.id))!;
    expect(after.name).toBe('Maya Lopez');
    expect(after.state).toBe('active');
    expect(after.canonicalProfile).toBe(text);
    const [e] = await fakeEmbed([text]);
    after.embedding!.forEach((x, i) => expect(x).toBeCloseTo(e[i], 5));
    const tr = await q(`SELECT data FROM traces WHERE kind = 'profile_update'`);
    expect(tr).toHaveLength(1);
  });

  test('LLM path: uses canonicalize_profile output with a strict schema', async () => {
    const fake = await fresh();
    let req: JsonRequest | undefined;
    fake.onJson('canonicalize_profile', (r) => ((req = r), { profile_text: TENNIS }));
    const u = await getOrCreateUser('+12065550001');
    const text = await buildProfile(u.id, 'i play varsity tennis');
    expect(text).toBe(TENNIS);
    expect(req!.input).toContain('i play varsity tennis');
    expect(req!.system).toContain('Core Interests:');
    assertStrictSchema(req!.schema);
    const after = (await getUser(u.id))!;
    expect(after.name).toBeNull();
    expect(after.canonicalProfile).toBe(TENNIS);
  });

  test('LLM error falls back', async () => {
    const fake = await fresh();
    fake.onJson('canonicalize_profile', () => {
      throw new Error('boom');
    });
    const u = await getOrCreateUser('+12065550002');
    expect(await buildProfile(u.id, 'chess')).toBe('Core Interests:\n[1] chess');
  });
});

describe('editProfile', () => {
  test('fallback appends a slot and re-embeds', async () => {
    await fresh();
    const id = await makeUser('Sam', TENNIS);
    const text = await editProfile(id, 'Indoor bouldering');
    expect(text).toBe(`${TENNIS}\n[2] Indoor bouldering.`);
    const [e] = await fakeEmbed([text]);
    const u = (await getUser(id))!;
    expect(u.embedding![0]).toBeCloseTo(e[0], 5);
    expect(u.canonicalProfile).toBe(text);
  });

  test('LLM path gets current profile + change', async () => {
    const fake = await fresh();
    const out = 'Core Interests:\n[1] Indoor bouldering, V4 problems (Level: Intermediate).';
    let input = '';
    fake.onJson('edit_profile', (r) => ((input = r.input), { profile_text: out }));
    const id = await makeUser('Sam', TENNIS);
    expect(await editProfile(id, 'remove tennis, add bouldering')).toBe(out);
    expect(input).toContain(TENNIS);
    expect(input).toContain('remove tennis, add bouldering');
  });
});

describe('setProfileText', () => {
  test('writes text and vector together', async () => {
    await fresh();
    const id = await makeUser('Ana', 'x', axis(0));
    const u = await setProfileText(id, 'jazz piano');
    expect(u.canonicalProfile).toBe('jazz piano');
    const [e] = await fakeEmbed(['jazz piano']);
    expect(u.embedding![0]).toBeCloseTo(e[0], 5);
  });
});

describe('evolveFromRsvp', () => {
  test('fallback (no handler) is a no-op', async () => {
    await fresh();
    const host = await makeUser('Host', 'hosting');
    const id = await makeUser('Jo', TENNIS);
    const ev = await makeEvent(host, 'Catan night', 'board games', 'Target Attendee:\n[1] board games');
    const before = (await getUser(id))!;
    await evolveFromRsvp(id, ev);
    const after = (await getUser(id))!;
    expect(after.canonicalProfile).toBe(before.canonicalProfile);
    expect(after.embedding).toEqual(before.embedding);
  });

  test('no_update leaves embedding unchanged even if text differs', async () => {
    const fake = await fresh();
    fake.onJson('evolve_profile', () => ({ action: 'no_update', profile_text: 'something else', note: 'covered' }));
    const host = await makeUser('Host', 'hosting');
    const id = await makeUser('Jo', TENNIS);
    const ev = await makeEvent(host, 'Tennis ladder', 'match play', 'Target Attendee:\n[1] tennis');
    const before = (await getUser(id))!;
    await evolveFromRsvp(id, ev);
    const after = (await getUser(id))!;
    expect(after.canonicalProfile).toBe(TENNIS);
    expect(after.embedding).toEqual(before.embedding);
    const [t] = await q<{ data: any }>(`SELECT data FROM traces WHERE kind = 'profile_update'`);
    expect(t.data.action).toBe('no_update');
  });

  test('append changes text + embedding; input includes event and past yes events', async () => {
    const fake = await fresh();
    const appended = `${TENNIS}\n[2] Tabletop board games, Settlers of Catan, social game nights (Vibe: Casual).`;
    let input = '';
    fake.onJson('evolve_profile', (r) => ((input = r.input), { action: 'append', profile_text: appended, note: 'new interest' }));
    const host = await makeUser('Host', 'hosting');
    const id = await makeUser('Jo', TENNIS);
    const past = await makeEvent(host, 'Doubles social', 'tennis', 'Target Attendee:\n[1] tennis');
    await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, status, invited_at) VALUES ($1, $2, 1, 'p', 'yes', $3)`, [past, id, T0.toISOString()]);
    const ev = await makeEvent(host, 'Catan night', 'settlers of catan', 'Target Attendee:\n[1] Catan HYDE');
    const before = (await getUser(id))!;
    await evolveFromRsvp(id, ev);
    const after = (await getUser(id))!;
    expect(after.canonicalProfile).toBe(appended);
    expect(after.embedding).not.toEqual(before.embedding);
    expect(input).toContain('Catan night');
    expect(input).toContain('Catan HYDE');
    expect(input).toContain('Doubles social');
    const [t] = await q<{ data: any }>(`SELECT data FROM traces WHERE kind = 'profile_update'`);
    expect(t.data).toMatchObject({ action: 'append', before: TENNIS, after: appended });
  });

  test('runs as the evolve_profile job', async () => {
    const fake = await fresh();
    fake.onJson('evolve_profile', () => ({ action: 'refine', profile_text: 'Core Interests:\n[1] refined.', note: 'n' }));
    const host = await makeUser('Host', 'hosting');
    const id = await makeUser('Jo', TENNIS);
    const ev = await makeEvent(host, 'Tennis', 'd', 'h');
    await schedule('evolve_profile', { userId: id, eventId: ev }, T0);
    expect(await runDue()).toBe(1);
    expect((await getUser(id))!.canonicalProfile).toBe('Core Interests:\n[1] refined.');
  });
});
