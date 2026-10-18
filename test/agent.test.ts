import { beforeEach, expect, test, vi } from 'vitest';
import { fresh, makeUser, axis, T0 } from './helpers.ts';
import { getUserByPhone, one, q, toVec } from '../src/db/index.ts';
import type { AgentRequest, AgentResponse, FakeLlm } from '../src/llm/index.ts';

// Module contracts are owned by other agents; mock them so this tests only the agent loop.
vi.mock('../src/profiles/index.ts', () => ({
  buildProfile: vi.fn(async (userId: number, braindump: string, name?: string) => {
    const { q } = await import('../src/db/index.ts');
    const text = `Core Interests:\n[1] ${braindump}`;
    await q(`UPDATE users SET name = coalesce($2, name), state = 'active', canonical_profile = $3 WHERE id = $1`, [userId, name ?? null, text]);
    return text;
  }),
  editProfile: vi.fn(async () => 'Core Interests:\n[1] edited'),
  setProfileText: vi.fn(),
  evolveFromRsvp: vi.fn(),
}));
vi.mock('../src/events/index.ts', () => ({
  createEvent: vi.fn(),
  respondToInvite: vi.fn(async () => ({ outcome: 'accepted', detail: 'fri 7pm at odegaard' })),
  manageEvent: vi.fn(async () => 'status text'),
  discoverEvents: vi.fn(async () => []),
  openInvitesFor: vi.fn(async () => []),
  hostedEventsFor: vi.fn(async () => []),
  joinEvent: vi.fn(),
}));
vi.mock('../src/matching/index.ts', () => ({
  recall: vi.fn(),
  rerank: vi.fn(),
  findPeople: vi.fn(async () => []),
}));
vi.mock('../src/relay/index.ts', () => ({
  requestIntro: vi.fn(async (r: number, t: number, reason: string) => ({ id: 1, requesterId: r, targetId: t, reason, status: 'target_asked', targetMessage: null })),
  respondToIntro: vi.fn(),
  pendingIntrosFor: vi.fn(async () => []),
  IntroLimitError: class extends Error {},
  groundedNote: vi.fn(() => undefined),
}));

const { handleInbound, MAX_LLM_CALLS } = await import('../src/agent/index.ts');
const profiles = await import('../src/profiles/index.ts');
const events = await import('../src/events/index.ts');
const relay = await import('../src/relay/index.ts');

let fake: FakeLlm;
beforeEach(async () => {
  fake = await fresh();
  vi.clearAllMocks();
});

type Step = (req: AgentRequest) => AgentResponse;
// Scripted agent: the n-th call runs steps[n]; records every request.
function script(...steps: Step[]): AgentRequest[] {
  const seen: AgentRequest[] = [];
  fake.agentHandler = (req) => {
    seen.push(structuredClone(req));
    const step = steps[seen.length - 1];
    if (!step) throw new Error(`unexpected agent call #${seen.length}`);
    return step(req);
  };
  return seen;
}
const call = (name: string, args: unknown, id = 'c1'): AgentResponse => ({ text: '', calls: [{ call_id: id, name, arguments: JSON.stringify(args) }] });
const say = (text: string): Step => () => ({ text, calls: [] });

async function outbox(phone: string): Promise<string[]> {
  const rows = await q<{ text: string }>(
    `SELECT m.text FROM messages m JOIN users u ON u.id = m.user_id WHERE u.phone = $1 AND m.direction = 'out' ORDER BY m.id`,
    [phone],
  );
  return rows.map((r) => r.text);
}

const outputs = (req: AgentRequest) =>
  req.input.filter((i): i is { type: 'function_call_output'; call_id: string; output: string } => 'type' in i && i.type === 'function_call_output');

test('onboarding: save_profile call, output fed back, reply sent, user created and traced', async () => {
  const seen = script(
    () => call('save_profile', { name: 'maya lopez', braindump: 'tennis 4.5 and catan' }),
    (req) => {
      const fc = req.input.find((i) => 'type' in i && i.type === 'function_call');
      expect(fc).toMatchObject({ call_id: 'c1', name: 'save_profile' });
      const out = outputs(req);
      expect(out).toHaveLength(1);
      expect(out[0].call_id).toBe('c1');
      expect(JSON.parse(out[0].output)).toMatchObject({ ok: true, name: 'Maya Lopez' });
      return { text: "got it maya! i'll text you when something fits", calls: [] };
    },
  );
  await handleInbound('+15550001111', "hey i'm maya lopez, i play tennis (4.5) and love catan");

  expect(seen).toHaveLength(2);
  // the inbound message, then the context block last
  expect(seen[0].input.at(-1)).toMatchObject({ role: 'developer' });
  expect((seen[0].input.at(-1) as any).content).toContain('2026-10-20T12:00:00-07:00');
  expect((seen[0].input.at(-1) as any).content).toContain('Tuesday');
  expect((seen[0].input.at(-1) as any).content).toContain('FIRST text');
  expect(seen[0].input.at(-2)).toEqual({ role: 'user', content: "hey i'm maya lopez, i play tennis (4.5) and love catan" });
  expect(seen[0].instructions).toContain('mixr');
  // strict schemas
  for (const t of seen[0].tools) {
    const p = t.parameters as any;
    expect(p.additionalProperties).toBe(false);
    expect([...p.required].sort()).toEqual(Object.keys(p.properties).sort());
  }

  expect(profiles.buildProfile).toHaveBeenCalledWith(expect.any(Number), 'tennis 4.5 and catan', 'Maya Lopez');
  const u = await getUserByPhone('+15550001111');
  expect(u).toMatchObject({ name: 'Maya Lopez', state: 'active' });
  expect(await outbox('+15550001111')).toEqual(["got it maya! i'll text you when something fits"]);

  const tr = await one<{ data: any }>(`SELECT data FROM traces WHERE kind = 'agent' AND ref_id = $1`, [u!.id]);
  expect(tr!.data.phone).toBe('+15550001111');
  expect(tr!.data.toolCalls[0]).toMatchObject({ name: 'save_profile', args: { name: 'maya lopez' }, result: { ok: true } });
  expect(tr!.data.reply).toContain('got it');
});

test('save_profile needs a full name: a bare first name is sent back to ask for the last name', async () => {
  const seen = script(
    () => call('save_profile', { name: 'Maya', braindump: 'tennis' }, 'a'),
    () => call('save_profile', { name: null, braindump: 'tennis' }, 'b'),
    () => call('save_profile', { name: 'maya 🙂', braindump: 'tennis' }, 'c'),
    say('and your last name?'),
  );
  await handleInbound('+15550005555', "i'm maya, i play tennis");
  const out = seen.slice(1).map((r) => JSON.parse(outputs(r).at(-1)!.output));
  expect(out[0].error).toMatch(/only a first name.*last name/);
  expect(out[1].error).toMatch(/full name \(first and last\)/);
  expect(out[2].error).toMatch(/full name/);
  expect(profiles.buildProfile).not.toHaveBeenCalled();
  expect(seen[0].instructions).toMatch(/full name \(first and last\)/);
  expect(seen[0].tools.find((t) => t.name === 'save_profile')!.parameters).toMatchObject({ properties: { name: { description: expect.stringMatching(/full name, first and last/) } } });

  // A first name that matches the full name on file keeps it; the context tells the agent what to call them.
  await q(`UPDATE users SET name = 'Maya Lopez' WHERE phone = '+15550005555'`);
  const again = script(() => call('save_profile', { name: 'maya', braindump: 'tennis' }), say('saved!'));
  await handleInbound('+15550005555', 'tennis 4.0');
  expect(JSON.parse(outputs(again[1])[0].output)).toMatchObject({ ok: true, name: 'Maya Lopez' });
  expect(profiles.buildProfile).toHaveBeenCalledWith(expect.any(Number), 'tennis', undefined);
  expect((again[0].input.at(-1) as any).content).toContain("name=Maya Lopez (full name on file, don't ask for it again; call them Maya)");
});

test('tool exceptions, bad JSON and unknown tools come back as {error}', async () => {
  vi.mocked(profiles.buildProfile).mockRejectedValueOnce(new Error('boom'));
  const seen = script(
    () => ({
      text: '',
      calls: [
        { call_id: 'a', name: 'save_profile', arguments: JSON.stringify({ name: 'Al Diaz', braindump: 'chess' }) },
        { call_id: 'b', name: 'nope', arguments: '{}' },
        { call_id: 'c', name: 'edit_profile', arguments: '{not json' },
      ],
    }),
    say('hmm something broke, try again?'),
  );
  await handleInbound('+15550002222', 'hi');
  const out = outputs(seen[1]).map((o) => JSON.parse(o.output));
  expect(out[0].error).toContain('boom');
  expect(out[1].error).toContain('unknown tool');
  expect(out[2].error).toContain('JSON');
  expect(await outbox('+15550002222')).toEqual(['hmm something broke, try again?']);
});

test('max iterations guard stops after 6 calls and still replies', async () => {
  let n = 0;
  fake.agentHandler = () => (n++, call('discover_events', { query: 'x' }, `c${n}`));
  await handleInbound('+15550003333', 'loop forever');
  expect(n).toBe(MAX_LLM_CALLS);
  // the last response's calls are not executed
  expect(events.discoverEvents).toHaveBeenCalledTimes(MAX_LLM_CALLS - 1);
  const sent = await outbox('+15550003333');
  expect(sent).toHaveLength(1);
});

test('empty final text sends nothing', async () => {
  script(say('   '));
  await handleInbound('+15550004444', 'ok');
  expect(await outbox('+15550004444')).toEqual([]);
});

test('manage_event only for events the user hosts; respond_to_invite only for their invites', async () => {
  const hostId = await makeUser('Sam', 'board games');
  const meId = await makeUser('Jo', 'board games');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  const v = toVec(axis(0));
  const ev = await one<{ id: number }>(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, created_at)
     VALUES ($1, 'Catan', 'catan', $2, 'HUB', 4, 'x', $3, $3, $2) RETURNING id`,
    [hostId, new Date(T0.getTime() + 86_400_000).toISOString(), v],
  );
  const seen = script(
    () => ({
      text: '',
      calls: [
        { call_id: 'm', name: 'manage_event', arguments: JSON.stringify({ event_id: ev!.id, action: 'cancel', n: null }) },
        { call_id: 'r', name: 'respond_to_invite', arguments: JSON.stringify({ event_id: ev!.id, response: 'yes' }) },
      ],
    }),
    say('ok'),
  );
  await handleInbound(phone, 'cancel catan and also yes');
  const out = outputs(seen[1]).map((o) => JSON.parse(o.output));
  expect(out[0].error).toMatch(/don't host/);
  expect(out[1].error).toMatch(/no invite/);
  expect(events.manageEvent).not.toHaveBeenCalled();
  expect(events.respondToInvite).not.toHaveBeenCalled();

  // with an invite row it goes through
  await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at) VALUES ($1, $2, 1, 'p', $3)`, [ev!.id, meId, T0.toISOString()]);
  const seen2 = script(() => call('respond_to_invite', { event_id: ev!.id, response: 'no_busy' }), say('no worries'));
  await handleInbound(phone, "can't make it");
  expect(events.respondToInvite).toHaveBeenCalledWith(meId, ev!.id, 'no_busy');
  expect(seen2).toHaveLength(1); // the RSVP's scripted copy is the reply; no second model call
});

test('request_intro rejects self and unknown users, accepts an active other user', async () => {
  const meId = await makeUser('Jo', 'tennis');
  const otherId = await makeUser('Kai', 'tennis');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  const seen = script(
    () => ({
      text: '',
      calls: [
        { call_id: 'a', name: 'request_intro', arguments: JSON.stringify({ target_user_id: meId, reason: 'x' }) },
        { call_id: 'b', name: 'request_intro', arguments: JSON.stringify({ target_user_id: 9999, reason: 'x' }) },
        { call_id: 'c', name: 'request_intro', arguments: JSON.stringify({ target_user_id: otherId, reason: 'tennis partner' }) },
      ],
    }),
    say("i'll ask kai"),
  );
  await handleInbound(phone, 'intro me to kai');
  const out = outputs(seen[1]).map((o) => JSON.parse(o.output));
  expect(out[0].error).toBeTruthy();
  expect(out[1].error).toBeTruthy();
  expect(out[2]).toMatchObject({ ok: true, target: 'Kai' });
  expect(relay.requestIntro).toHaveBeenCalledTimes(1);
  expect(relay.requestIntro).toHaveBeenCalledWith(meId, otherId, 'tennis partner');
});

test('snooze sets and clears snoozed_until', async () => {
  const meId = await makeUser('Jo', 'tennis');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  script(() => call('snooze', { until: '2026-10-26T09:00:00-07:00' }), say('paused till monday'));
  await handleInbound(phone, 'pause until monday');
  let r = await one<{ s: string | null }>('SELECT snoozed_until AS s FROM users WHERE id = $1', [meId]);
  expect(new Date(r!.s!).toISOString()).toBe(new Date('2026-10-26T09:00:00-07:00').toISOString());

  script(() => call('snooze', { until: null }), say("welcome back"));
  await handleInbound(phone, "i'm back");
  r = await one<{ s: string | null }>('SELECT snoozed_until AS s FROM users WHERE id = $1', [meId]);
  expect(r!.s).toBeNull();
});

test("an action with mixr's own confirmation is sent as-is, with no second model call", async () => {
  const meId = await makeUser('Jo', 'tennis');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  const seen = script(() => call('snooze', { until: null }), say('model should not be asked again'));
  await handleInbound(phone, "i'm back");
  expect(seen).toHaveLength(1);
  expect(['welcome back, texts are back on', "you're back on. hmu anytime"]).toContain((await outbox(phone)).at(-1));

  // A question in their text doesn't change that: the model decides. No text from it -> the canned reply.
  script(() => call('snooze', { until: null }));
  await handleInbound(phone, "i'm back! anything fun this week?");
  expect(['welcome back, texts are back on', "you're back on. hmu anytime"]).toContain((await outbox(phone)).at(-1));
});

test('action + text in the same response: the model chose to say something, so its text goes out instead of the canned reply', async () => {
  const meId = await makeUser('Jo', 'tennis');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  const seen = script(() => ({ ...call('snooze', { until: null }), text: "you're back on. catan is fri 7pm at odegaard" }));
  await handleInbound(phone, "i'm back. when's catan?");
  expect(seen).toHaveLength(1);
  expect(await outbox(phone)).toEqual(["you're back on. catan is fri 7pm at odegaard"]);
});

test('context block lists open invites with ids and recent find_people results', async () => {
  const meId = await makeUser('Jo', 'tennis');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  vi.mocked(events.openInvitesFor).mockResolvedValue([
    { id: 42, title: 'Catan night', description: 'chill', startsAt: '2026-10-23T19:00:00-07:00', location: 'Odegaard', spotsLeft: 2, goingCount: 1, hostName: 'Sam Lee', inviteStatus: 'invited' },
  ]);
  const { findPeople } = await import('../src/matching/index.ts');
  vi.mocked(findPeople).mockResolvedValue([{ userId: 77, name: 'Kai Smith', reason: 'also plays 4.5' }]);
  script(() => call('find_people', { request: 'tennis' }), say('kai plays 4.5, want an intro?'));
  await handleInbound(phone, 'anyone to play tennis with?');

  const seen = script(say('ok'));
  await handleInbound(phone, 'yes kai');
  const ctx = (seen[0].input.at(-1) as any).content as string;
  expect(ctx).toContain('event_id 42');
  expect(ctx).toContain('Catan night');
  expect(ctx).toContain('Fri, Oct 23');
  expect(ctx).toContain('host Sam |');
  expect(ctx).toContain('user_id 77: Kai');
  expect(ctx).not.toContain('Smith');
  // history replayed: in → user, out → assistant
  expect(seen[0].input.slice(0, -1)).toEqual([
    { role: 'user', content: 'anyone to play tennis with?' },
    // an activity search always surfaces hosting; the scripted reply didn't, so the fallback line was added
    { role: 'assistant', content: 'kai plays 4.5, want an intro? or i can host an event for this, just say the word.' },
    { role: 'user', content: 'yes kai' },
  ]);
});

test('per-phone serialization: texts from one phone never overlap', async () => {
  let active = 0;
  let maxActive = 0;
  const order: string[] = [];
  fake.agentHandler = (async (req: AgentRequest) => {
    const last = ([...req.input].reverse().find((i) => 'role' in i && i.role === 'user') as any).content as string;
    active++;
    maxActive = Math.max(maxActive, active);
    order.push(`start ${last}`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`end ${last}`);
    active--;
    return { text: `re: ${last}`, calls: [] };
  }) as any;
  await Promise.all([handleInbound('+15550005555', 'one'), handleInbound('+15550005555', 'two'), handleInbound('+15550005555', 'three')]);
  expect(maxActive).toBe(1);
  expect(order).toEqual(['start one', 'end one', 'start two', 'end two', 'start three', 'end three']);
  expect(await outbox('+15550005555')).toEqual(['re: one', 're: two', 're: three']);
});

test('a failing turn rejects but does not block the next text from that phone', async () => {
  fake.agentHandler = () => {
    throw new Error('llm down');
  };
  await expect(handleInbound('+15550006666', 'hi')).rejects.toThrow('llm down');
  script(say('back!'));
  await handleInbound('+15550006666', 'hi again');
  expect(await outbox('+15550006666')).toEqual(['back!']);
});

test('a reply that narrates tool calls is never sent: the model is asked once more, then a fallback', async () => {
  const { looksInternal } = await import('../src/agent/index.ts');
  expect(looksInternal('[find_people and discover_events both called in parallel]')).toBe(true);
  expect(looksInternal('let me run find_people for you')).toBe(true);
  expect(looksInternal('found 3 people into hackathons! want an intro?')).toBe(false);

  let n = 0;
  fake.agentHandler = () => (++n === 1 ? { text: '[find_people and discover_events both called in parallel]', calls: [] } : { text: 'here are two hackathon people!', calls: [] });
  await handleInbound('+15550007001', 'show me hackathon people');
  expect(await outbox('+15550007001')).toEqual(['here are two hackathon people!']);

  fake.agentHandler = () => ({ text: '[tool call: find_people]', calls: [] });
  await handleInbound('+15550007002', 'hi');
  const out = await outbox('+15550007002');
  expect(out).toHaveLength(1);
  expect(out[0]).not.toMatch(/find_people|\[/);
});

test('an accepted intro is confirmed once: the relay already texted them, so the agent does not narrate it', async () => {
  const intro = { id: 7, requesterId: 99, targetId: 0, reason: 'hackathon teammates', status: 'target_asked', targetMessage: null };
  vi.mocked(relay.pendingIntrosFor).mockImplementation(async () => [intro as any]);
  vi.mocked(relay.respondToIntro).mockImplementation(async (targetId: number) => {
    const { send } = await import('../src/transport/index.ts');
    await send(targetId, "done, here's Jordan's number: +14255550000. have fun");
    return { ...intro, targetId, status: 'connected' } as any;
  });
  try {
    // already_texted alone: nothing more goes out, and the model isn't asked again.
    const seen = script(() => call('respond_to_intro', { intro_id: 7, accept: true, message: null }));
    await handleInbound('+15550008001', 'yes');
    expect(seen).toHaveLength(1);
    const trace = await one<{ data: { toolCalls: { result: unknown }[] } }>(`SELECT data FROM traces WHERE kind = 'agent' ORDER BY id DESC LIMIT 1`);
    expect(trace!.data.toolCalls[0].result).toMatchObject({ ok: true, status: 'connected', already_texted: expect.any(String) });
    expect(await outbox('+15550008001')).toEqual(["done, here's Jordan's number: +14255550000. have fun"]);

    // already_texted + text in the same response (they also asked something): the text goes out.
    script(() => ({ ...call('respond_to_intro', { intro_id: 7, accept: true, message: null }), text: 'catan is fri 7pm at odegaard' }));
    await handleInbound('+15550008002', "sure! when's catan again?");
    expect((await outbox('+15550008002')).at(-1)).toBe('catan is fri 7pm at odegaard');
  } finally {
    vi.mocked(relay.pendingIntrosFor).mockImplementation(async () => []);
    vi.mocked(relay.respondToIntro).mockReset();
  }
});

test('the prompt asks for short, lowercase, one-question texts with no recap or sales talk', async () => {
  const seen = script(say('hey'));
  await handleInbound('+15550008101', 'hi');
  const p = seen[0].instructions;
  expect(p).toMatch(/160 characters/);
  expect(p).toMatch(/one question/i);
  expect(p).toMatch(/lowercase/);
  expect(p).toMatch(/recap/i);
  expect(p).not.toMatch(/bad:/); // only good examples: quoting bad ones primes the model
  expect(p.match(/<example>/g)!.length).toBeGreaterThanOrEqual(3);
  expect(p).toMatch(/Never write "i'll lmk"/);
  expect(p).not.toMatch(/get back to them/);
  expect(p).not.toMatch(/handle all the texting/);
  const { HOST_OFFER_HINT } = await import('../src/agent/tools.ts');
  expect(HOST_OFFER_HINT).not.toMatch(/handle all the texting/);
  expect(p).not.toMatch(/tell them you passed it along/);
  expect(p).toMatch(/they\/them/); // never guess a pronoun from a name
  expect(p).not.toMatch(/ask if he's down to hit/);
  const hint = seen[0].tools.find((t) => t.name === 'request_intro')!.parameters as any;
  expect(hint.properties.reason.description).toMatch(/not a sentence|noun phrase/i);
});

test('replies are tidied: lowercase openers, runaway length clipped at a sentence', async () => {
  const { tidy } = await import('../src/agent/index.ts');
  expect(tidy("Got it: photography and poker. Nobody's around yet. I'll text you when someone fits.")).toBe(
    "got it: photography and poker. nobody's around yet. i'll text you when someone fits.",
  );
  // Names and acronyms stay as they are.
  expect(tidy('Jordan is down! AI hackathon at the HUB, Sam.')).toBe('Jordan is down! AI hackathon at the HUB, Sam.');
  expect(tidy('Bet, asked Casey. Ngl that sounds fun. Lowkey jealous. Fr.')).toBe('bet, asked Casey. ngl that sounds fun. lowkey jealous. fr.');
  // Formatting only: tidy never decides content, so no sentence is dropped.
  expect(tidy("bet, asked Casey. i'll leave the trash talk out. i'll get back to you when they answer.")).toBe(
    "bet, asked Casey. i'll leave the trash talk out. i'll get back to you when they answer.",
  );
  expect(tidy('Only one thing on the calendar. Tonight works, Maya. Maybe UW has more.')).toBe('only one thing on the calendar. tonight works, Maya. maybe UW has more.');
  expect(tidy("i'll get back to you")).toBe("i'll get back to you");
  expect(tidy("you're in. i'll lyk if anything changes")).toBe("you're in. i'll lyk if anything changes");
  const long = 'this is a sentence that goes on for a while. '.repeat(20).trim();
  const out = tidy(long);
  expect(out.length).toBeLessThanOrEqual(480);
  expect(out.endsWith('.')).toBe(true);

  script(say('Got it. Want me to look for a poker partner?'));
  await handleInbound('+15550008201', 'poker, competitive');
  expect(await outbox('+15550008201')).toEqual(['got it. want me to look for a poker partner?']);
});

test('tidy lowercases question openers mid-reply (production: "...before i can match you well. Are you casual...")', async () => {
  const { tidy } = await import('../src/agent/index.ts');
  expect(tidy('got it, Maya. Are you casual or competitive? Do you want a study group?')).toBe(
    'got it, Maya. are you casual or competitive? do you want a study group?',
  );
});

test('read-only tool calls in one turn run together; results go back in the order they were asked', async () => {
  const meId = await makeUser('Jo', 'soccer');
  const phone = (await one<{ phone: string }>('SELECT phone FROM users WHERE id = $1', [meId]))!.phone;
  const { findPeople } = await import('../src/matching/index.ts');
  let active = 0;
  let maxActive = 0;
  const slow = async <T>(v: T, ms: number): Promise<T> => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise((r) => setTimeout(r, ms));
    active--;
    return v;
  };
  vi.mocked(events.discoverEvents).mockImplementationOnce(() => slow([], 30));
  vi.mocked(findPeople).mockImplementationOnce(() => slow([{ userId: 5, name: 'Kai Smith', reason: 'plays soccer' }], 5));
  const seen = script(
    () => ({
      text: '',
      calls: [
        { call_id: 'a', name: 'discover_events', arguments: JSON.stringify({ query: 'pickup soccer' }) },
        { call_id: 'b', name: 'find_people', arguments: JSON.stringify({ request: 'pickup soccer' }) },
      ],
    }),
    say('no games yet, but kai plays. want me to ask him, or host a soccer event?'),
  );
  await handleInbound(phone, 'any pickup soccer?');
  expect(maxActive).toBe(2);
  const out = outputs(seen[1]);
  expect(out.map((o) => o.call_id)).toEqual(['a', 'b']);
  expect(JSON.parse(out[0].output)).toEqual({ events: [], campus_events: [] });
  expect(JSON.parse(out[1].output).matches[0]).toMatchObject({ user_id: 5, name: 'Kai' });
});
