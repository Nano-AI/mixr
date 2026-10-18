import { afterEach, expect, test, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { config } from '../src/config.ts';
import { parseSpectrumMessage, startMessaging, withMessageIndicators, type Connection } from '../src/messaging/photon.ts';
import { registerSharedUser, setPhotonFetch } from '../src/messaging/photon-api.ts';
import { createEmailSender, emailConfigured, verificationEmail } from '../src/messaging/email.ts';

// The Spectrum adapter's pure parts, the reconnect loop (with a fake connection), the Photon REST client (fake
// fetch), and the email sender (nodemailer stream transport). Nothing here touches the network.

const original = { ...config };
afterEach(() => {
  Object.assign(config, original);
  setPhotonFetch(null);
});

test('parseSpectrumMessage: inbound phone DMs with text only', () => {
  const event = { platform: 'imessage', direction: 'inbound', id: 'event-1', sender: { id: '+14253694262' }, content: { type: 'text', text: 'hi' } };
  expect(parseSpectrumMessage({ type: 'dm' }, event)).toEqual({ from: '+14253694262', text: 'hi', providerId: 'imessage:event-1' });
  for (const e of [
    null,
    {},
    'text',
    { ...event, direction: 'outbound' },
    { ...event, platform: 'whatsapp' },
    { ...event, id: '' },
    { ...event, id: 42 },
    { ...event, sender: { id: 'email@uw.edu' } },
    { ...event, sender: { id: '14253694262' } },
    { ...event, sender: undefined },
    { ...event, content: { type: 'text', text: 42 } },
    { ...event, content: { type: 'attachment' } },
  ])
    expect(parseSpectrumMessage({ type: 'dm' }, e)).toBeNull();
  expect(parseSpectrumMessage({ type: 'group' }, event)).toBeNull();
  expect(parseSpectrumMessage(null, event)).toBeNull();
});

test('read + typing surround processing, and typing stops even when processing fails', async () => {
  const events: string[] = [];
  const message = { read: async () => void events.push('read') };
  const space = { startTyping: async () => void events.push('start'), stopTyping: async () => void events.push('stop') };
  await expect(
    withMessageIndicators(message, space, async () => {
      events.push('process');
      throw new Error('handler failed');
    }),
  ).rejects.toThrow('handler failed');
  expect(events).toEqual(['read', 'start', 'process', 'stop']);
});

test('indicator failures never block processing', async () => {
  const fail = async () => {
    throw new Error('unavailable');
  };
  let processed = false;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await withMessageIndicators({ read: fail }, { startTyping: fail, stopTyping: fail }, async () => void (processed = true));
  warn.mockRestore();
  expect(processed).toBe(true);
});

test('startMessaging is a no-op on the sim transport', async () => {
  config.transport = 'sim';
  const connect = vi.fn();
  const m = startMessaging({ connect });
  await m.stop();
  await m.finished;
  expect(connect).not.toHaveBeenCalled();
});

test('startMessaging refuses to start Photon without credentials', () => {
  config.transport = 'photon';
  config.photonProjectId = '';
  config.photonProjectSecret = '';
  expect(() => startMessaging()).toThrow(/PROJECT_ID/);
});

test('startMessaging reconnects with backoff when the stream ends or fails, and stop() shuts it down', async () => {
  config.transport = 'photon';
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  let attempts = 0;
  let endLast!: () => void;
  const stopLast = vi.fn(async () => endLast());
  const connect = vi.fn(async (): Promise<Connection> => {
    attempts++;
    if (attempts === 1) throw new Error('UNAVAILABLE: connection refused');
    if (attempts === 2) return { stop: async () => {}, finished: Promise.resolve() }; // stream ended right away
    return { stop: stopLast, finished: new Promise<void>((resolve) => (endLast = resolve)) };
  });
  const m = startMessaging({ connect, minDelayMs: 1, maxDelayMs: 4 });
  await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(3));
  await m.stop();
  await m.finished;
  expect(stopLast).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(3); // no reconnect after stop
  err.mockRestore();
  info.mockRestore();
});

test('registerSharedUser: request shape, success, full, and errors (fake fetch only)', async () => {
  config.photonProjectId = '00000000-0000-0000-0000-000000000000';
  config.photonProjectSecret = 'shh-secret';
  let respond: () => Response = () => new Response('{}');
  const seen: { url: string; init?: RequestInit }[] = [];
  setPhotonFetch((async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return respond();
  }) as typeof fetch);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  respond = () => json(200, { succeed: true, data: { id: 'u-1', assignedPhoneNumber: '+16285550199', phoneNumber: '+14255550100' } });
  expect(await registerSharedUser('+14255550100', 'Ana')).toEqual({ kind: 'ok', id: 'u-1', assignedPhoneNumber: '+16285550199' });
  expect(JSON.parse(String(seen[0].init?.body))).toEqual({ type: 'shared', phoneNumber: '+14255550100', firstName: 'Ana' });

  respond = () => json(402, { succeed: false, data: null, code: 'PLAN_LIMIT', message: 'shared user limit reached' });
  expect((await registerSharedUser('+14255550100')).kind).toBe('full');
  respond = () => json(422, { succeed: false, data: null, code: 'VALIDATION_ERROR', message: 'phoneNumber: max length exceeded' });
  expect((await registerSharedUser('+14255550100')).kind).toBe('error');
  respond = () => json(401, { succeed: false, data: null, code: 'UNAUTHORIZED', message: 'bad credentials shh-secret' });
  const unauthorized = await registerSharedUser('+14255550100');
  expect(unauthorized).toMatchObject({ kind: 'error', status: 401 });
  expect(JSON.stringify(unauthorized)).not.toContain('shh-secret');
  respond = () => new Response('<html>bad gateway</html>', { status: 502 });
  expect(await registerSharedUser('+14255550100')).toMatchObject({ kind: 'error', status: 502 });

  config.photonProjectSecret = '';
  expect((await registerSharedUser('+14255550100')).kind).toBe('error');
});

test('Gmail sender addresses the UW student and includes the code', async () => {
  let envelope: unknown;
  let mime = '';
  const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const env = { EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'mixr.test@example.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop' };
  expect(emailConfigured(env)).toBe(true);
  await createEmailSender(env, async (mail) => {
    const result = await stream.sendMail(mail);
    envelope = result.envelope;
    mime = result.message.toString();
  })('student@uw.edu', '123456');
  expect(envelope).toEqual({ from: 'mixr.test@example.com', to: ['student@uw.edu'] });
  expect(mime).toMatch(/Subject: 123456 is your mixr code/);
  expect(mime).toMatch(/multipart\/alternative/);
  expect(mime).toMatch(/Content-Type: text\/plain/);
  expect(mime).toMatch(/Content-Type: text\/html/);
  expect(mime).toMatch(/10 minutes/);
});

test('verification email: code in subject (first), text and html; user strings escaped; under the Gmail clip', () => {
  const m = verificationEmail('<b>"o\'neil"&co@uw.edu', '123456');
  expect(m.subject).toBe('123456 is your mixr code');
  expect(m.text).toContain('123456');
  expect(m.text).toContain('expires in 10 minutes');
  expect(m.html).toContain('>123456</div>'); // the code alone in its own element, easy to select
  expect(m.html).toContain('your code is 123456'); // hidden preheader
  expect(m.html).toContain('&lt;b&gt;&quot;o&#39;neil&quot;&amp;co@uw.edu');
  expect(m.html).not.toContain('<b>');
  expect(Buffer.byteLength(m.html)).toBeLessThan(100 * 1024);
  expect(verificationEmail('a@uw.edu', '<x>').html).not.toContain('<x>');
});

test('email fails closed: missing config, unknown provider, transport errors', async () => {
  const gmailNoCreds = { EMAIL_PROVIDER: 'gmail', RESEND_API_KEY: 'unused', EMAIL_FROM: 'mixr <a@b.c>' };
  expect(emailConfigured(gmailNoCreds)).toBe(false);
  await expect(createEmailSender(gmailNoCreds)('student@uw.edu', '123456')).rejects.toThrow(/Gmail/);
  expect(emailConfigured({})).toBe(false); // resend by default, unconfigured
  await expect(createEmailSender({})('student@uw.edu', '123456')).rejects.toThrow(/not configured/);
  await expect(createEmailSender({ EMAIL_PROVIDER: 'carrier-pigeon' })('student@uw.edu', '123456')).rejects.toThrow(/provider/i);
  const failing = createEmailSender({ EMAIL_PROVIDER: 'gmail', GMAIL_USER: 'a@example.com', GMAIL_APP_PASSWORD: 'x' }, async () => {
    throw new Error('SMTP rejected');
  });
  await expect(failing('student@uw.edu', '123456')).rejects.toThrow('SMTP rejected');
});
