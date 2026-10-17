import { Spectrum } from 'spectrum-ts';
import { imessage } from 'spectrum-ts/providers/imessage';
import { db } from '../db.ts';
import type { Inbound } from '../types.ts';
import { setTransport } from './transport.ts';

// Spectrum 12.11 uses authenticated cloud credentials and a gRPC event stream.
// No public webhook or invented webhook-signature contract is needed.
// Outbound: imessage(app).space.create(await im.user(phone)).send(text).
// https://photon.codes/docs/spectrum-ts/spaces-and-users
export function parseSpectrumMessage(
  space: unknown,
  message: unknown,
): Inbound | null {
  if (
    !space ||
    typeof space !== 'object' ||
    !('type' in space) ||
    space.type !== 'dm'
  )
    return null;
  if (!message || typeof message !== 'object') return null;
  const m = message as {
    platform?: unknown;
    direction?: unknown;
    id?: unknown;
    sender?: { id?: unknown };
    content?: { type?: unknown; text?: unknown };
  };
  if (
    m.platform !== 'imessage' ||
    m.direction !== 'inbound' ||
    typeof m.id !== 'string' ||
    !m.id
  )
    return null;
  if (
    typeof m.sender?.id !== 'string' ||
    !/^\+[1-9]\d{7,14}$/.test(m.sender.id)
  )
    return null;
  if (m.content?.type !== 'text' || typeof m.content.text !== 'string')
    return null;
  return {
    from: m.sender.id,
    text: m.content.text,
    providerId: `imessage:${m.id}`,
  };
}
// Indicators are cosmetic: unsupported APIs must never break message handling.
export async function withMessageIndicators(
  message: { read(): Promise<void> },
  space: { startTyping(): Promise<void>; stopTyping(): Promise<void> },
  processMessage: () => Promise<void>,
): Promise<void> {
  const attempt = async (action: () => Promise<void>, label: string) => {
    try {
      await action();
    } catch {
      console.warn(`${label} unavailable; continuing conversation.`);
    }
  };
  await attempt(() => message.read(), 'Read receipt');
  await attempt(() => space.startTyping(), 'Typing indicator');
  try {
    await processMessage();
  } finally {
    await attempt(() => space.stopTyping(), 'Typing cleanup');
  }
}

export async function connectPhoton(
  handleInbound: (m: Inbound) => Promise<void>,
) {
  if (!process.env.PROJECT_ID || !process.env.PROJECT_SECRET)
    throw Error('Set PROJECT_ID and PROJECT_SECRET before starting Photon');
  const app = await Spectrum({
    projectId: process.env.PROJECT_ID,
    projectSecret: process.env.PROJECT_SECRET,
    providers: [imessage.config()],
    options: { logLevel: 'warn' },
  });
  const im = imessage(app);
  setTransport(async (phone, text) => {
    const user = await im.user(phone);
    const space = await im.space.create(user);
    const sent = await space.send(text);
    if (!sent) throw Error('Photon did not return a sent message');
  });
  const finished = (async () => {
    for await (const [space, message] of app.messages) {
      const inbound = parseSpectrumMessage(space, message);
      if (inbound) {
        const duplicate = db
          .prepare('SELECT 1 FROM inbound_messages WHERE provider_id=?')
          .get(inbound.providerId);
        const user = db
          .prepare('SELECT opted_out FROM users WHERE phone=?')
          .get(inbound.from);
        if (
          duplicate ||
          (user?.opted_out &&
            !/^START(?:\s|[!.?]|$)/i.test(inbound.text.trim()))
        ) {
          await handleInbound(inbound);
        } else {
          await withMessageIndicators(message, space, () =>
            handleInbound(inbound),
          );
        }
        console.info('Inbound iMessage processed.');
      }
    }
  })();
  return { stop: () => app.stop(), finished };
}
