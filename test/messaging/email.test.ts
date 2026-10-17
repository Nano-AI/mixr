import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import {
  createEmailSender,
  emailConfigured,
} from '../../src/messaging/email.ts';

test('Gmail sender addresses the UW student and includes the verification code', async () => {
  let envelope: unknown;
  let mime = '';
  const stream = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
  const sender = createEmailSender(
    {
      EMAIL_PROVIDER: 'gmail',
      GMAIL_USER: 'mixr.test@gmail.com',
      GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
    },
    async (mail) => {
      const result = await stream.sendMail(mail);
      envelope = result.envelope;
      mime = result.message.toString();
    },
  );
  await sender('student@uw.edu', '123456');
  assert.deepEqual(envelope, {
    from: 'mixr.test@gmail.com',
    to: ['student@uw.edu'],
  });
  assert.match(mime, /Subject: Your Mixr verification code/);
  assert.match(mime, /123456/);
  assert.match(mime, /10 minutes/);
});
test('missing Gmail credentials fail closed, and provider choice does not silently fall back', async () => {
  const env = {
    EMAIL_PROVIDER: 'gmail',
    RESEND_API_KEY: 'unused',
    EMAIL_FROM: 'Mixr <sender@example.com>',
  };
  assert.equal(emailConfigured(env), false);
  await assert.rejects(
    createEmailSender(env)('student@uw.edu', '123456'),
    /Gmail/,
  );
  await assert.rejects(
    createEmailSender({ EMAIL_PROVIDER: 'unknown' })(
      'student@uw.edu',
      '123456',
    ),
    /provider/i,
  );
});
test('mail transport failure does not report successful verification delivery', async () => {
  const sender = createEmailSender(
    {
      EMAIL_PROVIDER: 'gmail',
      GMAIL_USER: 'mixr.test@gmail.com',
      GMAIL_APP_PASSWORD: 'abcdefghijklmnop',
    },
    async () => {
      throw Error('SMTP rejected');
    },
  );
  await assert.rejects(sender('student@uw.edu', '123456'), /SMTP rejected/);
});
