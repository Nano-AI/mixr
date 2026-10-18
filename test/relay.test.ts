import { test, expect } from 'vitest';
import { fresh, makeUser, T0 } from './helpers.ts';
import { requestIntro, respondToIntro, pendingIntrosFor, INTRO_LIMIT, IntroLimitError } from '../src/relay/index.ts';
import { runTool } from '../src/agent/tools.ts';
import { getUser, q } from '../src/db/index.ts';
import { advance } from '../src/jobs/index.ts';
import { HOUR, setNow } from '../src/clock.ts';

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
  expect(toReq).toBe(`Jordan's down. they said: "down for saturday morning". here's their number: ${tgtUser.phone}`);
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

test("an intro note is relayed only when it's the target's own words from the text they sent", async () => {
  const { groundedNote } = await import('../src/relay/index.ts');
  const accept = async (inbound: string, message: string | null) => {
    const { req, tgt } = await pair();
    const intro = await requestIntro(req, tgt, 'league duo');
    const { result } = await runTool(tgt, 'respond_to_intro', JSON.stringify({ intro_id: intro.id, accept: true, message }), inbound);
    expect(result).toMatchObject({ status: 'connected' });
    return (await texts(req))[0];
  };
  // The real thread: a bare "Yes!" and a note the model wrote itself.
  expect(await accept('Yes!', "Casey's in for League duo ranked. Say hi!")).not.toMatch(/said/);
  expect(await accept('Yes!', 'yes')).not.toMatch(/said/);
  expect(await accept('Yes!', null)).not.toMatch(/said/);
  expect(await accept('sure, tell her i play saturdays', 'i play saturdays')).toContain('they said: "i play saturdays".');

  expect(groundedNote('I play Saturdays.', 'sure!! tell her i play saturdays')).toBe('I play Saturdays.');
  expect(groundedNote('sure', 'sure, sounds good')).toBeUndefined(); // only the acceptance
  expect(groundedNote('i play sat', 'i play saturdays')).toBeUndefined(); // whole words only
  expect(groundedNote('i play saturdays', undefined)).toBeUndefined(); // no inbound, no quote
});

test('swap texts are short, and a quoted note never ends in a stray period', async () => {
  const run = async (note: string | undefined, accept = true) => {
    const { req, tgt, reqUser, tgtUser } = await pair();
    await respondToIntro(tgt, (await requestIntro(req, tgt, 'tennis')).id, accept, note);
    return { toReq: (await texts(req))[0], toTgt: (await texts(tgt))[1], reqUser, tgtUser };
  };
  let r = await run(undefined);
  expect(r.toReq).toBe(`Jordan's down. here's their number: ${r.tgtUser.phone}`);
  expect(r.toTgt).toBe(`done, here's Maya's number: ${r.reqUser.phone}. have fun`);
  r = await run('say hi!');
  expect(r.toReq).toBe(`Jordan's down. they said: "say hi". here's their number: ${r.tgtUser.phone}`);
  r = await run('free saturday?');
  expect(r.toReq).toBe(`Jordan's down. they said: "free saturday?" here's their number: ${r.tgtUser.phone}`);
  r = await run(undefined, false);
  expect(r.toReq).toBe("Jordan can't right now, no worries. i'll keep an eye out for someone else for you.");
});

test('scripted texts about another student never guess a pronoun', async () => {
  const copy = await import('../src/events/copy.ts');
  const e = { title: 'catan night', when: 'Fri 7:00 PM', location: 'odegaard 220' };
  const { req, tgt } = await pair();
  const a = await requestIntro(req, tgt, 'tennis');
  await respondToIntro(tgt, a.id, true, 'i play saturdays');
  const third = await makeUser('Casey Lin', 'league');
  await respondToIntro(third, (await requestIntro(req, third, 'league')).id, false);
  const fourth = await makeUser('Ivan Petrov', 'chess');
  await requestIntro(req, fourth, 'chess');
  await advance(25 * HOUR); // expiry text
  const all = [
    ...(await texts(req)),
    ...(await texts(tgt)),
    ...(await texts(third)),
    ...(await texts(fourth)),
    copy.inviteText('thought of you.', e, 2),
    copy.hostGuestIn('Casey', e.title, 2, 4, true),
    copy.hostGuestOut('Casey', e.title, 1, 4),
    copy.guestAccepted(e, 'Casey'),
    copy.guestEventCancelled('Casey', e),
    copy.headsUp(['Casey']),
  ];
  expect(all.length).toBeGreaterThan(10);
  for (const t of all) expect(t).not.toMatch(/\b(he|she|his|her|him|hers)\b/i);
});

test('at most INTRO_LIMIT intro requests per requester in a rolling 24h; repeats do not count', async () => {
  const { req, tgt } = await pair();
  const others = await Promise.all(['Ana Kim', 'Ben Wu', 'Cy Park'].map((n) => makeUser(n, 'tennis')));
  expect(INTRO_LIMIT).toBe(3);

  await requestIntro(req, tgt, 'tennis');
  await requestIntro(req, tgt, 'tennis'); // same open intro, not a second request
  await requestIntro(req, others[0], 'tennis');
  await requestIntro(req, others[1], 'tennis');
  await expect(requestIntro(req, others[2], 'tennis')).rejects.toBeInstanceOf(IntroLimitError);
  expect(await texts(others[2])).toEqual([]);

  // Through the tool: an error telling the model what to say, with hosting as the way out.
  const { result } = await runTool(req, 'request_intro', JSON.stringify({ target_user_id: others[2], reason: 'a tennis partner' }));
  expect((result as { error: string }).error).toMatch(/reach out to 3 people today.*host an event/);

  await setNow(new Date(T0.getTime() + 24 * HOUR));
  expect((await requestIntro(req, others[2], 'tennis')).status).toBe('target_asked');
});
