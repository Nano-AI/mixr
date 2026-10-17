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
    () => call('save_profile', { name: 'Maya', braindump: 'tennis 4.5 and catan' }),
    (req) => {
      const fc = req.input.find((i) => 'type' in i && i.type === 'function_call');
      expect(fc).toMatchObject({ call_id: 'c1', name: 'save_profile' });
      const out = outputs(req);
      expect(out).toHaveLength(1);
      expect(out[0].call_id).toBe('c1');
      expect(JSON.parse(out[0].output)).toMatchObject({ ok: true, name: 'Maya' });
      return { text: "got it maya! i'll text you when something fits", calls: [] };
    },
  );
  await handleInbound('+15550001111', "hey i'm maya, i play tennis (4.5) and love catan");

  expect(seen).toHaveLength(2);
  // the inbound message, then the context block last
  expect(seen[0].input.at(-1)).toMatchObject({ role: 'developer' });
  expect((seen[0].input.at(-1) as any).content).toContain('2026-10-20T12:00:00-07:00');
  expect((seen[0].input.at(-1) as any).content).toContain('Tuesday');
  expect((seen[0].input.at(-1) as any).content).toContain('FIRST text');
  expect(seen[0].input.at(-2)).toEqual({ role: 'user', content: "hey i'm maya, i play tennis (4.5) and love catan" });
  expect(seen[0].instructions).toContain('mixr');
  // strict schemas
  for (const t of seen[0].tools) {
    const p = t.parameters as any;
    expect(p.additionalProperties).toBe(false);
    expect([...p.required].sort()).toEqual(Object.keys(p.properties).sort());
  }

  expect(profiles.buildProfile).toHaveBeenCalledWith(expect.any(Number), 'tennis 4.5 and catan', 'Maya');
  const u = await getUserByPhone('+15550001111');
  expect(u).toMatchObject({ name: 'Maya', state: 'active' });
  expect(await outbox('+15550001111')).toEqual(["got it maya! i'll text you when something fits"]);

  const tr = await one<{ data: any }>(`SELECT data FROM traces WHERE kind = 'agent' AND ref_id = $1`, [u!.id]);
  expect(tr!.data.phone).toBe('+15550001111');
  expect(tr!.data.toolCalls[0]).toMatchObject({ name: 'save_profile', args: { name: 'Maya' }, result: { ok: true } });
  expect(tr!.data.reply).toContain('got it');
});

test('tool exceptions, bad JSON and unknown tools come back as {error}', async () => {
  vi.mocked(profiles.buildProfile).mockRejectedValueOnce(new Error('boom'));
  const seen = script(
    () => ({
      text: '',
      calls: [
        { call_id: 'a', name: 'save_profile', arguments: JSON.stringify({ name: 'Al', braindump: 'chess' }) },
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
  expect(JSON.parse(outputs(seen2[1])[0].output)).toMatchObject({ outcome: 'accepted' });
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
    { role: 'assistant', content: 'kai plays 4.5, want an intro?' },
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
