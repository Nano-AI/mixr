import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { one, q } from '../db/index.ts';
import { setDeliverer, type RichContent } from '../transport/outbox.ts';
import type { Service } from '../types.ts';
import { emailConfigured } from './email.ts';
import { keyword } from './onboarding.ts';
import { markInterrupted, processText } from './pipeline.ts';

// iMessage over Photon Spectrum (spectrum-ts 12.11): an authenticated gRPC event stream, no public webhook.
//   inbound:  app.messages -> parseSpectrumMessage -> processText(phone, text, 'phone', 'imessage:<id>')
//   outbound: the outbox's deliverer -> imessage(app).space.create(await im.user(phone)) -> deliver(): text, or the
//             job's rich content (contact card, effect...) with the text as fallback
// https://photon.codes/docs/spectrum-ts/spaces-and-users
// Logs never include message text, phone numbers or credentials.

// threaded: the student replied inline to an earlier message (e.g. an old invite); our answer threads under it.
// service: what Apple says the text came in on (absent when Photon reports 'unknown' or nothing).
export type Inbound = { from: string; text: string; providerId: string; threaded?: true; service?: Service };
export type Connection = { stop: () => Promise<void>; finished: Promise<void> };

const BACKOFF_MIN_MS = 1_000; // tune: first reconnect delay
const BACKOFF_MAX_MS = 60_000; // tune: longest reconnect delay
const STABLE_MS = 60_000; // tune: a connection that lived this long resets the backoff

// Phone-number DMs only: group chats and email-based iMessage identities are ignored (no onboarding details in a
// group, no merging identities by email).
export function parseSpectrumMessage(space: unknown, message: unknown): Inbound | null {
  if (!space || typeof space !== 'object' || (space as { type?: unknown }).type !== 'dm') return null;
  if (!message || typeof message !== 'object') return null;
  const m = message as {
    platform?: unknown;
    direction?: unknown;
    id?: unknown;
    sender?: { id?: unknown; service?: unknown };
    content?: { type?: unknown; text?: unknown; content?: { type?: unknown; text?: unknown } };
  };
  if (m.platform !== 'imessage' || m.direction !== 'inbound' || typeof m.id !== 'string' || !m.id) return null;
  if (typeof m.sender?.id !== 'string' || !/^\+[1-9]\d{7,14}$/.test(m.sender.id)) return null;
  const service = SERVICES.get(m.sender.service);
  const base = { from: m.sender.id, providerId: `imessage:${m.id}`, ...(service ? { service } : {}) };
  if (m.content?.type === 'text' && typeof m.content.text === 'string') return { ...base, text: m.content.text };
  // An inline reply is a text too (before, it was dropped as unsupported content).
  const inner = m.content?.type === 'reply' ? m.content.content : undefined;
  if (inner?.type === 'text' && typeof inner.text === 'string') return { ...base, text: inner.text, threaded: true };
  return null;
}

// Photon's sender.service (advanced-imessage ChatServiceType, mapped from the proto Message.sender
// SingleServiceAddressInfo.service enum: 1 iMessage, 2 SMS, 3 RCS) -> ours. 'unknown' maps to nothing.
const SERVICES = new Map<unknown, Service>([
  ['iMessage', 'imessage'],
  ['RCS', 'rcs'],
  ['SMS', 'sms'],
]);

// Keep users.service in step with what their latest text came in on (e.g. they switched to Android).
export async function rememberService(m: Inbound): Promise<void> {
  if (m.service) await q('UPDATE users SET service = $2 WHERE phone = $1 AND service IS DISTINCT FROM $2', [m.from, m.service]);
}

// Read receipt + typing while we work. Cosmetic: an unsupported indicator never breaks message handling, and
// typing is always cleared, even when processing fails.
export async function withMessageIndicators(
  message: { read(): Promise<void> },
  space: { startTyping(): Promise<void>; stopTyping(): Promise<void> },
  process: () => Promise<void>,
): Promise<void> {
  const attempt = async (action: () => Promise<void>, label: string) => {
    try {
      await action();
    } catch {
      console.warn(`${label} unavailable; continuing.`);
    }
  };
  await attempt(() => message.read(), 'Read receipt');
  await attempt(() => space.startTyping(), 'Typing indicator');
  try {
    await process();
  } finally {
    await attempt(() => space.stopTyping(), 'Typing cleanup');
  }
}

// Duplicates and texts we'll deliberately ignore (opted out, not START) get no read receipt or typing.
async function quiet(m: Inbound): Promise<boolean> {
  if (await one('SELECT 1 FROM inbound_messages WHERE provider_id = $1', [m.providerId])) return true;
  const u = await one<{ opted_out: boolean }>('SELECT opted_out FROM users WHERE phone = $1', [m.from]);
  return !!u?.opted_out && keyword(m.text) !== 'START';
}

const defaultHandler = async (m: Inbound): Promise<void> => void (await processText(m.from, m.text, 'phone', m.providerId));

// Handlers still running (a slow agent turn shouldn't hold up other people's texts); drained on stop.
const inflight = new Set<Promise<void>>();

// One Spectrum connection. `finished` settles when the stream ends or fails; handlers may still be running.
export async function connectPhoton(onInbound: (m: Inbound) => Promise<void> = defaultHandler): Promise<Connection> {
  const { photonProjectId: projectId, photonProjectSecret: projectSecret } = config;
  if (!projectId || !projectSecret) throw new Error('Set PROJECT_ID and PROJECT_SECRET before starting Photon');
  // Loaded lazily: tests and the sim transport never pull in the SDK.
  const core = await import('spectrum-ts');
  const { imessage, effect, nativeContactCard } = await import('spectrum-ts/providers/imessage');
  const app = await core.Spectrum({ projectId, projectSecret, providers: [imessage.config()], options: { logLevel: 'warn' } });
  const im = imessage(app);
  const sdk: Sdk = { ...core, effect, nativeContactCard, confetti: imessage.effect.message.confetti };
  // Phone -> provider id of the inline reply being handled right now: plain texts to them thread under it.
  const threads = new Map<string, string>();
  setDeliverer(async (phone, text, content) => {
    const user = await im.user(phone);
    const space = await im.space.create(user);
    const thread = threads.get(phone);
    const u = await one<{ service: Service | null }>('SELECT service FROM users WHERE phone = $1', [phone]);
    await deliver(space as unknown as SpaceLike, text, content ?? (thread ? { kind: 'reply', targetId: thread } : null), sdk, u?.service ?? null);
  });

  const handle = async (m: Inbound, space: any, message: any): Promise<void> => {
    if (m.threaded) threads.set(m.from, m.providerId);
    try {
      await rememberService(m); // before: this turn's replies already go out per service
      if (await quiet(m)) await onInbound(m);
      else await withMessageIndicators(message, space, () => onInbound(m));
      console.info('Inbound iMessage processed.');
    } catch {
      console.error('Inbound iMessage processing failed; recorded for inspection.');
    } finally {
      await rememberService(m).catch(() => {}); // again: a first-ever text only creates the user in onInbound
      if (threads.get(m.from) === m.providerId) threads.delete(m.from);
    }
  };

  const finished = (async () => {
    for await (const [space, message] of app.messages) {
      const m = parseSpectrumMessage(space, message);
      if (!m) {
        console.info(`iMessage event ignored: ${describeIgnored(space, message)}`);
        continue;
      }
      console.info('Inbound iMessage received.');
      const p = handle(m, space, message);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  })();
  return { stop: () => app.stop(), finished };
}

// The SDK's content builders, injected so tests never load the SDK.
type Builder = (...args: any[]) => unknown;
export type Sdk = Record<'contact' | 'effect' | 'reaction' | 'reply' | 'richlink' | 'nativeContactCard', Builder> & { confetti: string };
export type SpaceLike = { send(...content: unknown[]): Promise<unknown>; getMessage(id: string): Promise<unknown> };

// mixr's contact photo (256px JPEG). Missing (e.g. an old checkout) = the card goes out without a photo.
const MIXR_PHOTO = fileURLToPath(new URL('../../landing/brand/mixr-contact.jpg', import.meta.url));

// One outbound job. Plain text unless the job carries rich content; if building or sending that throws, or the
// kind isn't supported, the plain text goes out instead (logged). Only a failed plain send rejects (-> outbox retry).
//
// Per service (users.service, from the student's last inbound text; null = unknown). Android texts the same line
// over RCS or SMS, where most iMessage extras don't exist:
//   kind           imessage / unknown            rcs                          sms
//   reaction       tapback (fallback: emoji)     tapback (fallback: nothing)  nothing
//   effect         text + confetti               text                         text
//   contact        caption + vCard               text (carries the number)    text
//   share_contact  Share Name and Photo          skipped                      skipped
//   reply          threaded text                 plain text                   plain text
//   richlink       link preview                  text + URL                   text + URL
// iOS 18 RCS carries emoji reactions to Android; screen effects and Share Name and Photo are iMessage-only.
// Unknown keeps the try-rich-then-fall-back behavior. docs/messaging-operations.md has the same table.
export async function deliver(space: SpaceLike, text: string, content: RichContent | null, sdk: Sdk, service: Service | null = null): Promise<void> {
  const plain = async (body: string) => {
    if (!(await space.send(body))) throw new Error('Photon did not accept the message');
  };
  if (!content) return plain(text);
  if (service === 'sms' || (service === 'rcs' && content.kind !== 'reaction')) {
    if (content.kind === 'reaction' || content.kind === 'share_contact') return; // never a bare emoji or an empty card
    return plain(content.kind === 'richlink' && !text.includes(content.url) ? `${text}\n${content.url}` : text);
  }
  if (content.kind === 'share_contact') {
    // Best effort: never retried, never replaced by text.
    try {
      await space.send(sdk.nativeContactCard());
    } catch (e) {
      console.warn(`Share Name and Photo failed (${redact(e)}); ignored.`);
    }
    return;
  }
  // A caption with confetti; the plain caption if Photon won't take the effect.
  const withEffect = async (body: string) => {
    try {
      if (await space.send(sdk.effect(body, sdk.confetti))) return;
    } catch (e) {
      console.warn(`iMessage effect failed (${redact(e)}); sending plain text instead.`);
    }
    await plain(body);
  };
  let captionSent = false;
  try {
    const target = async (id: string | null) => {
      const m = id ? await space.getMessage(id.replace(/^imessage:/, '')) : undefined;
      if (!m) throw new Error('target message not found');
      return m;
    };
    let rich: unknown;
    switch (content.kind) {
      case 'contact': {
        const { first, last, phone, mixrPhoto } = content;
        rich = sdk.contact({
          name: { first, ...(last ? { last } : {}), formatted: [first, last].filter(Boolean).join(' ') },
          phones: [{ value: phone, type: 'mobile' }],
          ...(mixrPhoto && existsSync(MIXR_PHOTO) ? { photo: { mimeType: 'image/jpeg', read: () => readFile(MIXR_PHOTO) } } : {}),
        });
        break;
      }
      case 'effect':
        rich = sdk.effect(text, sdk.confetti);
        break;
      case 'reaction':
        rich = sdk.reaction(content.emoji, await target(content.targetId));
        break;
      case 'reply':
        rich = sdk.reply(text, await target(content.targetId));
        break;
      case 'richlink':
        rich = sdk.richlink(content.url);
        break;
      default:
        throw new Error(`unsupported content kind '${content.kind}'`);
    }
    if (content.caption) {
      await (content.captionEffect ? withEffect(content.caption) : plain(content.caption));
      captionSent = true;
    }
    if (!(await space.send(rich))) throw new Error('not accepted');
  } catch (e) {
    if (service === 'rcs') return void console.warn(`RCS ${content.kind} failed (${redact(e)}); dropped.`); // only reactions get here
    console.warn(`iMessage ${content.kind} failed (${redact(e)}); sending plain text instead.`);
    if (captionSent && content.caption === text) return; // the text already went out as the caption
    await plain(text);
  }
}

const redact = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replaceAll(config.photonProjectSecret || '\u0000', '[redacted]').slice(0, 300);

export type StartOptions = { connect?: () => Promise<Connection>; minDelayMs?: number; maxDelayMs?: number };

// Starts inbound/outbound iMessage when TRANSPORT=photon (otherwise a no-op). Keeps the stream up: when it ends
// or fails it reconnects with exponential backoff instead of exiting. stop() closes the stream and waits for
// in-flight texts; `finished` settles after stop().
export function startMessaging(opts: StartOptions = {}): Connection {
  if (!emailConfigured()) console.warn('UW email verification is not configured (EMAIL_PROVIDER etc.); onboarding will stop at the email step.');
  if (config.transport !== 'photon') {
    return { stop: async () => {}, finished: markInterrupted().then(() => {}, () => {}) };
  }
  if (!opts.connect && (!config.photonProjectId || !config.photonProjectSecret)) throw new Error('TRANSPORT=photon needs PROJECT_ID and PROJECT_SECRET');
  const connect = opts.connect ?? (() => connectPhoton());
  const minDelay = opts.minDelayMs ?? BACKOFF_MIN_MS;
  const maxDelay = opts.maxDelayMs ?? BACKOFF_MAX_MS;

  let stopping = false;
  let current: Connection | undefined;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const finished = (async () => {
    // Before the first new message can arrive: anything left 'processing' was cut off by the last shutdown.
    const interrupted = await markInterrupted().catch(() => 0);
    if (interrupted) console.warn(`${interrupted} inbound message(s) were interrupted by the last shutdown; see /api/admin/inbound.`);
    let delay = minDelay;
    while (!stopping) {
      const started = Date.now();
      try {
        current = await connect();
        if (stopping) {
          await current.stop().catch(() => {}); // stop() arrived while we were connecting
          break;
        }
        console.info('Photon connected; waiting for iMessages.');
        await current.finished;
        if (!stopping) console.error('Photon stream ended; reconnecting.');
      } catch (e) {
        if (!stopping) console.error(`Photon connection failed (${redact(e)}); reconnecting.`);
      }
      if (stopping) break;
      setDeliverer(null); // texts wait as 'pending' (the ticker retries them) until we're connected again
      if (Date.now() - started >= STABLE_MS) delay = minDelay;
      await sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
    await Promise.allSettled([...inflight]);
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await current?.stop().catch(() => {});
      await finished;
      setDeliverer(null);
    },
    finished,
  };
}

// Why an event wasn't treated as a student's text, without logging content or full handles: e.g. the sender's
// iMessage is set to send from their Apple ID email instead of their phone number (Photon's most common gotcha).
export function describeIgnored(space: unknown, message: unknown): string {
  const s = space as { type?: unknown } | null;
  const m = message as { platform?: unknown; direction?: unknown; sender?: { id?: unknown }; content?: { type?: unknown } } | null;
  const id = typeof m?.sender?.id === 'string' ? m.sender.id : '';
  const sender = /^\+[1-9]\d{7,14}$/.test(id) ? `phone ..${id.slice(-4)}` : id.includes('@') ? 'an email handle (not a phone number)' : id ? 'an unrecognized handle' : 'no sender';
  return `space=${String(s?.type)} direction=${String(m?.direction)} platform=${String(m?.platform)} content=${String(m?.content?.type)} sender=${sender}`;
}
