import { test, expect, afterEach, vi } from 'vitest';
import { axis, fresh } from './helpers.ts';
import { q, toVec } from '../src/db/index.ts';
import { poolContext, runIn } from '../src/context.ts';
import { config } from '../src/config.ts';
import { send } from '../src/transport/index.ts';
import { retryPending, setDeliverer, type RichContent } from '../src/transport/outbox.ts';
import { deliver, parseSpectrumMessage, rememberService, type Sdk, type SpaceLike } from '../src/messaging/photon.ts';
import { getUser } from '../src/db/index.ts';
import { contextBlock } from '../src/agent/context.ts';
import { processText } from '../src/messaging/pipeline.ts';
import { fakeEmbed } from '../src/llm/embed.ts';
import { requestIntro, respondToIntro } from '../src/relay/index.ts';
import { confetti, handleInbound } from '../src/agent/index.ts';

// Native iMessage extras: rich content rides on outbound jobs, the Photon deliverer builds the SDK object and
// falls back to the plain text. Photon is never called: a capturing deliverer, or deliver() with a fake space.

const real = poolContext('real');
afterEach(() => {
  config.transport = 'sim';
  setDeliverer(null);
});

type Sent = { phone: string; text: string; content: RichContent | null };
function capture(): Sent[] {
  config.transport = 'photon';
  const sent: Sent[] = [];
  setDeliverer(async (phone, text, content) => void sent.push({ phone, text, content }));
  return sent;
}

async function realUser(name = 'Real Riley', fields: { assigned?: string } = {}) {
  const v = (await fakeEmbed(['tennis']))[0];
  const r = await q<{ id: number; phone: string }>(
    `INSERT INTO users (phone, name, state, canonical_profile, embedding, seeded, assigned_number) VALUES ($1, $2, 'active', 'tennis', $3, false, $4) RETURNING id, phone`,
    [`+1206${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`, name, toVec(v), fields.assigned ?? null],
  );
  return r[0];
}

// A fake SDK: builders return tagged objects; `fail` makes a builder throw.
function fakeSdk(fail: string[] = []): Sdk {
  const b =
    (kind: string) =>
    (...args: unknown[]) => {
      if (fail.includes(kind)) throw new Error(`${kind} rejected`);
      return { kind, args };
    };
  return {
    contact: b('contact'),
    effect: b('effect'),
    reaction: b('reaction'),
    reply: b('reply'),
    richlink: b('richlink'),
    nativeContactCard: b('nativeContactCard'),
    confetti: 'confetti-id',
  };
}
function fakeSpace(opts: { messages?: Record<string, unknown>; reject?: string[] } = {}) {
  const sent: unknown[] = [];
  const space: SpaceLike = {
    send: async (c: unknown) => {
      const kind = typeof c === 'string' ? 'text' : (c as { kind: string }).kind;
      if (opts.reject?.includes(kind)) throw new Error(`${kind} refused by Photon`);
      sent.push(c);
      return { id: 'out-1' };
    },
    getMessage: async (id: string) => opts.messages?.[id],
  };
  return { space, sent };
}

test('outbox: rich content is stored with the job and reaches the deliverer; dedupe and retries unchanged', async () => {
  await fresh();
  const sent = capture();
  const u = await realUser();
  const content: RichContent = { kind: 'effect', effect: 'confetti' };
  await runIn(real, () => send(u.id, "you're in!", { dedupeKey: 'k1', content }));
  await runIn(real, () => send(u.id, "you're in!", { dedupeKey: 'k1', content })); // same notification
  expect(sent).toEqual([{ phone: u.phone, text: "you're in!", content }]);
  const [job] = await q<{ text: string; content: unknown }>('SELECT text, content FROM message_jobs');
  expect(job).toEqual({ text: "you're in!", content });

  // A failed rich send retries with its content; plain sends carry null.
  let fail = true;
  const later: Sent[] = [];
  setDeliverer(async (phone, text, c) => {
    if (fail) throw new Error('network down');
    later.push({ phone, text, content: c });
  });
  await runIn(real, () => send(u.id, 'card', { content: { kind: 'contact', first: 'Ana', phone: '+14255550100' } }));
  await runIn(real, () => send(u.id, 'plain'));
  fail = false;
  await retryPending();
  expect(later.map((s) => [s.text, s.content?.kind ?? null])).toEqual([
    ['card', 'contact'],
    ['plain', null],
  ]);
});

test('deliver: plain text, rich content, and the text fallback when Photon rejects the rich form', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sdk = fakeSdk();

  let s = fakeSpace();
  await deliver(s.space, 'hello', null, sdk);
  expect(s.sent).toEqual(['hello']);

  s = fakeSpace();
  await deliver(s.space, 'yay', { kind: 'effect', effect: 'confetti' }, sdk);
  expect(s.sent).toEqual([{ kind: 'effect', args: ['yay', 'confetti-id'] }]);

  // The SDK builder throws -> plain text.
  s = fakeSpace();
  await deliver(s.space, 'fallback', { kind: 'effect', effect: 'confetti' }, fakeSdk(['effect']));
  expect(s.sent).toEqual(['fallback']);

  // Photon rejects the send -> plain text.
  s = fakeSpace({ reject: ['contact'] });
  await deliver(s.space, "here's Ana: +14255550100", { kind: 'contact', first: 'Ana', phone: '+14255550100', caption: "here's Ana" }, sdk);
  expect(s.sent).toEqual(["here's Ana", "here's Ana: +14255550100"]);

  // A kind the deliverer doesn't support -> plain text.
  s = fakeSpace();
  await deliver(s.space, 'pick a time: fri / sat', { kind: 'poll', title: 'pick a time', options: ['fri', 'sat'] }, sdk);
  expect(s.sent).toEqual(['pick a time: fri / sat']);

  // A caption identical to the text isn't sent twice when the rich part fails.
  s = fakeSpace({ reject: ['richlink'] });
  await deliver(s.space, 'help text', { kind: 'richlink', url: 'https://www.joinmixr.club', caption: 'help text' }, sdk);
  expect(s.sent).toEqual(['help text']);

  // A tapback whose target can't be found -> plain text (the emoji).
  s = fakeSpace();
  await deliver(s.space, '👍', { kind: 'reaction', emoji: '👍', targetId: 'imessage:gone' }, sdk);
  expect(s.sent).toEqual(['👍']);

  // Share Name and Photo is best effort: errors are swallowed, nothing replaces it.
  s = fakeSpace({ reject: ['nativeContactCard'] });
  await expect(deliver(s.space, '[share name and photo]', { kind: 'share_contact' }, sdk)).resolves.toBeUndefined();
  expect(s.sent).toEqual([]);

  // Only a failed plain send rejects (the outbox retries it).
  s = fakeSpace({ reject: ['text'] });
  await expect(deliver(s.space, 'x', { kind: 'effect', effect: 'confetti' }, fakeSdk(['effect']))).rejects.toThrow(/refused/);
  warn.mockRestore();
});

test('confetti only on the reply confirming a seat they just got', async () => {
  const fake = await fresh();
  const sent = capture();
  const host = await realUser('Hana Host');
  const guest = await realUser('Gus Guest');
  const v = toVec(axis(0));
  const [ev] = await q<{ id: number }>(
    `INSERT INTO events (host_id, title, raw_description, starts_at, location, capacity, hyde_profile, initial_embedding, current_embedding, wave_number, created_at)
     VALUES ($1, 'catan night', 'd', $2, 'the hub', 3, 'h', $3, $3, 1, now()) RETURNING id`,
    [host.id, new Date(Date.now() + 48 * 3600_000).toISOString(), v],
  );
  await q(`INSERT INTO event_invites (event_id, user_id, wave, pitch, invited_at) VALUES ($1, $2, 1, 'p', now())`, [ev.id, guest.id]);
  let n = 0;
  fake.agentHandler = () =>
    ++n % 2 === 1
      ? { text: '', calls: [{ call_id: `c${n}`, name: 'respond_to_invite', arguments: JSON.stringify({ event_id: ev.id, response: 'yes' }) }] }
      : { text: "you're in! catan night at the hub", calls: [] };
  await handleInbound(guest.phone, 'yes!', 'phone');
  expect(sent.find((s) => s.phone === guest.phone)).toMatchObject({ phone: guest.phone, content: { kind: 'effect', effect: 'confetti' } });
  expect(sent.find((s) => s.phone === host.phone)?.content).toBeNull(); // the host's update stays plain
  // Saying yes again ("already in") is not a new confirmation.
  await handleInbound(guest.phone, 'yes', 'phone');
  expect(sent.filter((s) => s.phone === guest.phone).map((s) => s.content)).toEqual([{ kind: 'effect', effect: 'confetti' }, null]);
  expect(confetti([{ name: 'respond_to_invite', args: {}, result: { outcome: 'waitlisted', detail: 'catan night just filled up' } }])).toBe(false);
});

test('react: the agent tapbacks the text it is answering and sends no reply', async () => {
  const fake = await fresh();
  const sent = capture();
  const u = await realUser();
  let calls = 0;
  fake.agentHandler = () => (calls++, { text: '', calls: [{ call_id: 'c1', name: 'react', arguments: JSON.stringify({ emoji: '❤️' }) }] });
  expect(await processText(u.phone, 'thanks!!', 'phone', 'imessage:GUID-1')).toBe('done');
  expect(calls).toBe(1); // no follow-up model call for a text reply
  expect(sent).toEqual([{ phone: u.phone, text: '❤️', content: { kind: 'reaction', emoji: '❤️', targetId: 'imessage:GUID-1' } }]);

  // Outside the allowed set: an error back to the model, which then replies normally.
  calls = 0;
  fake.agentHandler = () =>
    ++calls === 1 ? { text: '', calls: [{ call_id: 'c2', name: 'react', arguments: JSON.stringify({ emoji: '🔥' }) }] } : { text: 'haha ok', calls: [] };
  await processText(u.phone, 'lol', 'phone', 'imessage:GUID-2');
  expect(sent.at(-1)).toEqual({ phone: u.phone, text: 'haha ok', content: null });
});

test('react + text: the tapback on their latest text goes first, then the reply, in one model call', async () => {
  const fake = await fresh();
  const sent = capture();
  const u = await realUser();
  let calls = 0;
  fake.agentHandler = () => (calls++, { text: 'see you there!', calls: [{ call_id: 'c1', name: 'react', arguments: JSON.stringify({ emoji: '❤️' }) }] });
  await processText(u.phone, 'yesss count me in! what should i bring?', 'phone', 'imessage:GUID-3');
  expect(calls).toBe(1);
  expect(sent).toEqual([
    { phone: u.phone, text: '❤️', content: { kind: 'reaction', emoji: '❤️', targetId: 'imessage:GUID-3' } },
    { phone: u.phone, text: 'see you there!', content: null },
  ]);
});

test('react + canned reply in one round: tapback, then the canned confirmation; a second tapback is refused', async () => {
  const fake = await fresh();
  const sent = capture();
  const u = await realUser();
  const until = new Date(Date.now() + 3 * 86_400_000).toISOString();
  let calls = 0;
  fake.agentHandler = () => (
    calls++,
    {
      text: '',
      calls: [
        { call_id: 'c1', name: 'react', arguments: JSON.stringify({ emoji: '😂' }) },
        { call_id: 'c2', name: 'react', arguments: JSON.stringify({ emoji: '❤️' }) },
        { call_id: 'c3', name: 'snooze', arguments: JSON.stringify({ until }) },
      ],
    }
  );
  await processText(u.phone, 'lmao midterms are killing me, pause texts for a few days', 'phone', 'imessage:GUID-4');
  expect(calls).toBe(1); // react's result has no reply, the refused second react is skipped; snooze's reply is sent as-is
  expect(sent.map((s) => s.content?.kind ?? null)).toEqual(['reaction', null]);
  expect(sent[0].text).toBe('😂');
  expect(sent[1].text).toMatch(/pausing texts|no texts from me/);
});

test('deliver: tapbacks and inline replies resolve their target message by provider id', async () => {
  const target = { id: 'GUID-1' };
  const s = fakeSpace({ messages: { 'GUID-1': target } });
  await deliver(s.space, '👍', { kind: 'reaction', emoji: '👍', targetId: 'imessage:GUID-1' }, fakeSdk());
  await deliver(s.space, "you're in!", { kind: 'reply', targetId: 'imessage:GUID-1' }, fakeSdk());
  expect(s.sent).toEqual([
    { kind: 'reaction', args: ['👍', target] },
    { kind: 'reply', args: ["you're in!", target] },
  ]);
});

test('parseSpectrumMessage: an inline reply to an older message is a threaded text', () => {
  const event = { platform: 'imessage', direction: 'inbound', id: 'r-1', sender: { id: '+14253694262' } };
  expect(parseSpectrumMessage({ type: 'dm' }, { ...event, content: { type: 'reply', content: { type: 'text', text: 'yes!' }, target: {} } })).toEqual({
    from: '+14253694262',
    text: 'yes!',
    providerId: 'imessage:r-1',
    threaded: true,
  });
  expect(parseSpectrumMessage({ type: 'dm' }, { ...event, content: { type: 'reply', content: { type: 'attachment' } } })).toBeNull();
});

test("accepted intro: each side gets the other's contact card (first + last name, phone), the numbered text as fallback", async () => {
  await fresh();
  const sent = capture();
  const maya = await realUser('Maya Lopez');
  const jordan = await realUser('Jordan de la Cruz');
  await runIn(real, async () => respondToIntro(jordan.id, (await requestIntro(maya.id, jordan.id, 'tennis')).id, true, 'saturdays work'));
  const toMaya = sent.find((s) => s.phone === maya.phone)!;
  const toJordan = sent.filter((s) => s.phone === jordan.phone).at(-1)!;
  expect(toMaya).toEqual({
    phone: maya.phone,
    text: `Jordan's down. they said: "saturdays work". here's their number: ${jordan.phone}`,
    content: { kind: 'contact', first: 'Jordan', last: 'de la Cruz', phone: jordan.phone, caption: `Jordan's down. they said: "saturdays work". here's their contact`, captionEffect: 'confetti' },
  });
  expect(toJordan).toEqual({
    phone: jordan.phone,
    text: `done, here's Maya's number: ${maya.phone}. have fun`,
    content: { kind: 'contact', first: 'Maya', last: 'Lopez', phone: maya.phone, caption: "done, here's Maya's contact. have fun", captionEffect: 'confetti' },
  });
});

test('deliver: a caption with captionEffect goes out with confetti, then the card; plain caption if the effect fails', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const card: RichContent = { kind: 'contact', first: 'Maya', phone: '+14255550100', caption: "done, here's Maya's contact", captionEffect: 'confetti' };
  let s = fakeSpace();
  await deliver(s.space, "done, here's Maya's number: +14255550100", card, fakeSdk());
  expect(s.sent.map((c) => (c as { kind: string }).kind)).toEqual(['effect', 'contact']);
  expect(s.sent[0]).toEqual({ kind: 'effect', args: ["done, here's Maya's contact", 'confetti-id'] });
  s = fakeSpace({ reject: ['effect'] });
  await deliver(s.space, "done, here's Maya's number: +14255550100", card, fakeSdk());
  expect(s.sent.map((c) => (typeof c === 'string' ? c : (c as { kind: string }).kind))).toEqual(["done, here's Maya's contact", 'contact']);
  warn.mockRestore();
});

test("intro accepted in the target's turn: the swap carries the only effect, the agent's reply stays plain", async () => {
  const fake = await fresh();
  const sent = capture();
  const maya = await realUser('Maya Lopez');
  const jordan = await realUser('Jordan Kim');
  const intro = await runIn(real, () => requestIntro(maya.id, jordan.id, 'tennis'));
  let n = 0;
  fake.agentHandler = () =>
    ++n === 1
      ? { text: '', calls: [{ call_id: 'c1', name: 'respond_to_intro', arguments: JSON.stringify({ intro_id: intro.id, accept: true, message: null }) }] }
      : { text: 'courts by the IMA are open til 10', calls: [] };
  await handleInbound(jordan.phone, 'yes! where are the courts?', 'phone');
  const toJordan = sent.filter((s) => s.phone === jordan.phone);
  expect(toJordan.map((s) => s.content?.captionEffect ?? (s.content?.kind === 'effect' ? 'effect' : null))).toEqual([null, 'confetti', null]);
  expect(toJordan.at(-1)).toEqual({ phone: jordan.phone, text: 'courts by the IMA are open til 10', content: null });
  expect(sent.find((s) => s.phone === maya.phone)?.content?.captionEffect).toBe('confetti');
});

test('confetti on the reply that finishes onboarding, not on a later profile redo or an ordinary reply', async () => {
  const fake = await fresh();
  const sent = capture();
  const u = await realUser('Casey Nguyen');
  await q(`UPDATE users SET state = 'onboarding' WHERE id = $1`, [u.id]);
  let n = 0;
  fake.agentHandler = () =>
    ++n % 2 === 1
      ? { text: '', calls: [{ call_id: `c${n}`, name: 'save_profile', arguments: JSON.stringify({ name: 'Casey Nguyen', braindump: 'tennis and catan' }) }] }
      : { text: "you're all set. i'll text you when something fits", calls: [] };
  await handleInbound(u.phone, 'tennis and catan, casual', 'phone');
  expect(sent.at(-1)).toMatchObject({ phone: u.phone, content: { kind: 'effect', effect: 'confetti' } });
  await handleInbound(u.phone, 'actually redo it, tennis and catan', 'phone'); // already active: no confetti
  expect(sent.at(-1)!.content).toBeNull();
  fake.agentHandler = () => ({ text: 'nice', calls: [] });
  await handleInbound(u.phone, 'cool', 'phone');
  expect(sent.at(-1)).toEqual({ phone: u.phone, text: 'nice', content: null });
});

test('service: stored from the inbound sender.service, refreshed on change, unknown keeps it; the context line shows it', async () => {
  await fresh();
  const u = await realUser();
  const msg = (service?: string) =>
    parseSpectrumMessage(
      { type: 'dm' },
      { platform: 'imessage', direction: 'inbound', id: 's-1', sender: { id: u.phone, ...(service ? { service } : {}) }, content: { type: 'text', text: 'hi' } },
    )!;
  const service = async () => (await getUser(u.id))!.service;

  expect(await service()).toBeNull();
  expect((await contextBlock((await getUser(u.id))!, new Date())).split('\n').find((l) => l.startsWith('user:'))).toMatch(/\| service=unknown$/);
  expect(msg('RCS').service).toBe('rcs');
  await rememberService(msg('RCS'));
  expect(await service()).toBe('rcs');
  await rememberService(msg('unknown')); // Photon couldn't tell: keep what we know
  await rememberService(msg());
  expect(await service()).toBe('rcs');
  await rememberService(msg('iMessage')); // switched back to an iPhone
  expect(await service()).toBe('imessage');
  await rememberService(msg('SMS'));
  expect(await service()).toBe('sms');
  expect(await contextBlock((await getUser(u.id))!, new Date())).toContain('| service=sms');
});

test('deliver per service: iMessage gets everything, RCS keeps tapbacks only, SMS is plain text', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const sdk = fakeSdk();
  const target = { id: 'GUID-9' };
  const reaction: RichContent = { kind: 'reaction', emoji: '❤️', targetId: 'imessage:GUID-9' };
  const effect: RichContent = { kind: 'effect', effect: 'confetti' };
  const contact: RichContent = { kind: 'contact', first: 'Ana', phone: '+14255550100', caption: "here's Ana", captionEffect: 'confetti' };
  const share: RichContent = { kind: 'share_contact' };
  const link: RichContent = { kind: 'richlink', url: 'https://www.joinmixr.club', caption: 'help text' };
  const run = async (service: 'imessage' | 'rcs' | 'sms' | null, text: string, content: RichContent, opts: { reject?: string[] } = {}) => {
    const s = fakeSpace({ messages: { 'GUID-9': target }, ...opts });
    await deliver(s.space, text, content, sdk, service);
    return s.sent;
  };

  for (const service of ['imessage', null] as const) {
    expect(await run(service, '❤️', reaction)).toEqual([{ kind: 'reaction', args: ['❤️', target] }]);
    expect(await run(service, 'yay', effect)).toEqual([{ kind: 'effect', args: ['yay', 'confetti-id'] }]);
    expect((await run(service, "here's Ana: +14255550100", contact)).map((c) => (c as { kind: string }).kind)).toEqual(['effect', 'contact']);
    expect(await run(service, '[share name and photo]', share)).toEqual([{ kind: 'nativeContactCard', args: [] }]);
  }

  expect(await run('rcs', '❤️', reaction)).toEqual([{ kind: 'reaction', args: ['❤️', target] }]);
  expect(await run('rcs', '❤️', reaction, { reject: ['reaction'] })).toEqual([]); // no bare emoji
  expect(await run('rcs', 'yay', effect)).toEqual(['yay']);
  expect(await run('rcs', "here's Ana: +14255550100", contact)).toEqual(["here's Ana: +14255550100"]);
  expect(await run('rcs', '[share name and photo]', share)).toEqual([]);
  expect(await run('rcs', 'help text', link)).toEqual(['help text\nhttps://www.joinmixr.club']);
  expect(await run('rcs', "you're in!", { kind: 'reply', targetId: 'imessage:GUID-9' })).toEqual(["you're in!"]);

  expect(await run('sms', '❤️', reaction)).toEqual([]);
  expect(await run('sms', 'yay', effect)).toEqual(['yay']);
  expect(await run('sms', "here's Ana: +14255550100", contact)).toEqual(["here's Ana: +14255550100"]);
  expect(await run('sms', '[share name and photo]', share)).toEqual([]);
  expect(await run('sms', 'see https://www.joinmixr.club', { kind: 'richlink', url: 'https://www.joinmixr.club' })).toEqual(['see https://www.joinmixr.club']);
  warn.mockRestore();
});
