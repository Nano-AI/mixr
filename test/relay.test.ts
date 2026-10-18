import { test, expect } from 'vitest';
import { fresh, makeUser } from './helpers.ts';
import { requestIntro, respondToIntro, pendingIntrosFor } from '../src/relay/index.ts';
import { getUser, q } from '../src/db/index.ts';
import { advance } from '../src/jobs/index.ts';
import { HOUR } from '../src/clock.ts';

const texts = async (userId: number) => (await q<{ text: string }>(`SELECT text FROM messages WHERE user_id = $1 AND direction = 'out' ORDER BY id`, [userId])).map((r) => r.text);

async function pair() {
  await fresh();
  const req = await makeUser('Maya Lopez', 'tennis');
  const tgt = await makeUser('Jordan Lee', 'tennis');
  return { req, tgt, reqUser: (await getUser(req))!, tgtUser: (await getUser(tgt))! };
}

test('request asks the target with first names and no phone numbers', async () => {
  const { req, tgt, reqUser, tgtUser } = await pair();
  const intro = await requestIntro(req, tgt, 'a 4.5 tennis hitting partner.');
  expect(intro).toMatchObject({ requesterId: req, targetId: tgt, status: 'target_asked', targetMessage: null });
  const [m] = await texts(tgt);
  expect(m).toBe('hey Jordan! Maya on campus is looking for a 4.5 tennis hitting partner. want me to connect you two?');
  expect(m).not.toContain(reqUser.phone);
  expect(m).not.toContain('Lopez');
  expect(await texts(req)).toEqual([]);
  expect((await pendingIntrosFor(tgt)).map((i) => i.id)).toEqual([intro.id]);
  expect(await pendingIntrosFor(req)).toEqual([]);
  void tgtUser;
});

test('duplicate request returns the open intro without re-texting', async () => {
  const { req, tgt } = await pair();
  const a = await requestIntro(req, tgt, 'tennis');
  const b = await requestIntro(req, tgt, 'tennis');
  expect(b.id).toBe(a.id);
  expect(await texts(tgt)).toHaveLength(1);
});

test('accept → connected, both numbers shared, message relayed; expiry later is a no-op', async () => {
  const { req, tgt, reqUser, tgtUser } = await pair();
  const intro = await requestIntro(req, tgt, 'tennis');
  const done = await respondToIntro(tgt, intro.id, true, 'down for saturday morning');
  expect(done).toMatchObject({ status: 'connected', targetMessage: 'down for saturday morning' });
  const [toReq] = await texts(req);
  expect(toReq).toBe(`Jordan is down! they said: "down for saturday morning". their number: ${tgtUser.phone}`);
  const toTgt = await texts(tgt);
  expect(toTgt[1]).toContain(reqUser.phone);
  expect(toTgt[1]).toContain('Maya');
  expect(await pendingIntrosFor(tgt)).toEqual([]);

  await advance(25 * HOUR);
  const [row] = await q<{ status: string }>('SELECT status FROM intros WHERE id = $1', [intro.id]);
  expect(row.status).toBe('connected');
  expect(await texts(req)).toHaveLength(1);
});

test('decline → declined, requester told gently, no numbers shared', async () => {
  const { req, tgt, reqUser, tgtUser } = await pair();
  const intro = await requestIntro(req, tgt, 'tennis');
  const done = await respondToIntro(tgt, intro.id, false);
  expect(done.status).toBe('declined');
  const [toReq] = await texts(req);
  expect(toReq).toContain('Jordan');
  expect(toReq).not.toContain(tgtUser.phone);
  expect((await texts(tgt)).join(' ')).not.toContain(reqUser.phone);
  // answering again is a no-op
  expect((await respondToIntro(tgt, intro.id, true)).status).toBe('declined');
});

test('only the target can answer', async () => {
  const { req, tgt } = await pair();
  const intro = await requestIntro(req, tgt, 'tennis');
  await expect(respondToIntro(req, intro.id, true)).rejects.toThrow();
});

test('expires after 24h via the expire_intro job', async () => {
  const { req, tgt, tgtUser } = await pair();
  const intro = await requestIntro(req, tgt, 'tennis');
  await advance(23 * HOUR);
  expect((await pendingIntrosFor(tgt)).length).toBe(1);
  await advance(2 * HOUR);
  const [row] = await q<{ status: string }>('SELECT status FROM intros WHERE id = $1', [intro.id]);
  expect(row.status).toBe('expired');
  const [toReq] = await texts(req);
  expect(toReq).toContain('Jordan');
  expect(toReq).not.toContain(tgtUser.phone);
  expect((await respondToIntro(tgt, intro.id, true)).status).toBe('expired');
});

test('intro ask reads right whatever shape the reason comes in (sentence, "is into", noun phrase)', async () => {
  const { introLine } = await import('../src/relay/index.ts');
  // The real transcript: the reason was a sentence about the requester, and the template named them twice.
  const { req, tgt } = await pair();
  await requestIntro(req, tgt, 'Maya is into hackathons and AI startups, and wants to meet someone building side projects.');
  expect((await texts(tgt))[0]).toBe('hey Jordan! Maya is into hackathons and AI startups, and wants to meet someone building side projects. want me to connect you two?');

  expect(introLine('Maya Lopez', 'a 4.5 tennis hitting partner.')).toBe('Maya on campus is looking for a 4.5 tennis hitting partner');
  expect(introLine('Maya Lopez', 'A chess partner')).toBe('Maya on campus is looking for a chess partner');
  expect(introLine('Maya Lopez', 'someone to play poker with')).toBe('Maya on campus is looking for someone to play poker with');
  expect(introLine('Maya Lopez', 'is into chess and poker')).toBe('Maya is into chess and poker');
  expect(introLine('Maya Lopez', 'into chess and poker')).toBe('Maya is into chess and poker');
  expect(introLine('Maya Lopez', "maya's into jazz piano")).toBe('Maya is into jazz piano');
  expect(introLine('Maya Lopez', 'Maya’s into jazz piano')).toBe('Maya is into jazz piano');
  expect(introLine('Maya Lopez', 'looking for a climbing buddy')).toBe('Maya is looking for a climbing buddy');
  expect(introLine('Maya Lopez', 'wants a doubles partner')).toBe('Maya wants a doubles partner');
  // Never leak the last name, even if the agent wrote the full name into the reason.
  expect(introLine('Maya Lopez', 'Maya Lopez wants a climbing buddy')).toBe('Maya wants a climbing buddy');
  expect(introLine('Maya Lopez', 'AI startup cofounders')).toBe('Maya on campus is looking for AI startup cofounders');
});
