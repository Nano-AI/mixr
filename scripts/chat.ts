import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { handleInbound } from '../src/messaging/router.ts';
import { tick } from '../src/messaging/services.ts';
import { retryFailed } from '../src/messaging/send.ts';
let phone = '+15550000001';
const input = createInterface({ input: process.stdin, output: process.stdout });
console.info(
  'Mixr local chat. /as +15550000002 changes identity; /tick runs maintenance; /quit exits. Real email verification is required.',
);
for await (const text of input) {
  if (text === '/quit') break;
  if (text.startsWith('/as ')) {
    const candidate = text.slice(4).trim();
    if (/^\+[1-9]\d{7,14}$/.test(candidate)) phone = candidate;
    else console.info('Use an E.164 phone number.');
  } else if (text === '/tick') {
    await retryFailed();
    await tick(new Date());
  } else
    await handleInbound({
      from: phone,
      text,
      providerId: `console:${randomUUID()}`,
    });
}
input.close();
