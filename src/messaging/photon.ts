import { config } from '../config.ts';
import { one } from '../db/index.ts';
import { setDeliverer } from '../transport/outbox.ts';
import { emailConfigured } from './email.ts';
import { keyword } from './onboarding.ts';
import { markInterrupted, processText } from './pipeline.ts';

// iMessage over Photon Spectrum (spectrum-ts 12.11): an authenticated gRPC event stream, no public webhook.
//   inbound:  app.messages -> parseSpectrumMessage -> processText(phone, text, 'phone', 'imessage:<id>')
//   outbound: the outbox's deliverer -> imessage(app).space.create(await im.user(phone)).send(text)
// https://photon.codes/docs/spectrum-ts/spaces-and-users
// Logs never include message text, phone numbers or credentials.

export type Inbound = { from: string; text: string; providerId: string };
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
    sender?: { id?: unknown };
    content?: { type?: unknown; text?: unknown };
  };
  if (m.platform !== 'imessage' || m.direction !== 'inbound' || typeof m.id !== 'string' || !m.id) return null;
  if (typeof m.sender?.id !== 'string' || !/^\+[1-9]\d{7,14}$/.test(m.sender.id)) return null;
  if (m.content?.type !== 'text' || typeof m.content.text !== 'string') return null;
  return { from: m.sender.id, text: m.content.text, providerId: `imessage:${m.id}` };
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
  const { Spectrum } = await import('spectrum-ts');
  const { imessage } = await import('spectrum-ts/providers/imessage');
  const app = await Spectrum({ projectId, projectSecret, providers: [imessage.config()], options: { logLevel: 'warn' } });
  const im = imessage(app);
  setDeliverer(async (phone, text) => {
    const user = await im.user(phone);
    const space = await im.space.create(user);
    const sent = await space.send(text);
    if (!sent) throw new Error('Photon did not accept the message');
  });

  const handle = async (m: Inbound, space: any, message: any): Promise<void> => {
    try {
      if (await quiet(m)) await onInbound(m);
      else await withMessageIndicators(message, space, () => onInbound(m));
      console.info('Inbound iMessage processed.');
    } catch {
      console.error('Inbound iMessage processing failed; recorded for inspection.');
    }
  };

  const finished = (async () => {
    for await (const [space, message] of app.messages) {
      const m = parseSpectrumMessage(space, message);
      if (!m) continue;
      console.info('Inbound iMessage received.');
      const p = handle(m, space, message);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    }
  })();
  return { stop: () => app.stop(), finished };
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
