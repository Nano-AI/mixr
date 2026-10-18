import { test, expect, afterEach, vi } from 'vitest';
import { fresh } from './helpers.ts';
import { q, toVec } from '../src/db/index.ts';
import { poolContext, runIn } from '../src/context.ts';
import { config } from '../src/config.ts';
import { send } from '../src/transport/index.ts';
import { retryPending, setDeliverer, type RichContent } from '../src/transport/outbox.ts';
import { deliver, type Sdk, type SpaceLike } from '../src/messaging/photon.ts';
import { fakeEmbed } from '../src/llm/embed.ts';

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
