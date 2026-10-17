import { emailConfigured } from './messaging/email.ts';
import { db } from './db.ts';
import { handleInbound } from './messaging/router.ts';
import { connectPhoton } from './messaging/photon.ts';
import { retryFailed } from './messaging/send.ts';
import { createServer } from './messaging/http.ts';
import { integrationStatus, tick } from './messaging/services.ts';
import { moveCompletedProfilesToChat } from './messaging/state.ts';

const transport = process.env.TRANSPORT ?? 'photon';
if (!['console', 'photon'].includes(transport))
  throw Error('TRANSPORT must be console or photon');
process.env.TRANSPORT = transport;
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.ADMIN_TOKEN || !process.env.DB_PATH)
)
  throw Error('Production requires ADMIN_TOKEN and persistent DB_PATH');
let ready = false;
const server = createServer(() => ready);
let connection: Awaited<ReturnType<typeof connectPhoton>> | undefined;
let stopping = false;
let working: Promise<void> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
async function maintenance() {
  if (working) return working;
  working = (async () => {
    await retryFailed();
    await tick(new Date());
  })();
  try {
    await working;
  } catch {
    console.error('Maintenance failed; will retry next minute.');
  } finally {
    working = undefined;
  }
}
async function stop() {
  if (stopping) return;
  stopping = true;
  ready = false;
  if (interval) clearInterval(interval);
  const deadline = setTimeout(() => process.exit(1), 15000).unref();
  await connection?.stop();
  // SDK stream closure does not drain our asynchronous handler.
  await connection?.finished.catch(() => {});
  await working;
  server.close(() => {
    db.close();
    clearTimeout(deadline);
  });
  server.closeIdleConnections();
}
process.once('SIGINT', () => {
  void stop();
});
process.once('SIGTERM', () => {
  void stop();
});
try {
  const resumed = moveCompletedProfilesToChat();
  if (resumed) console.info('Completed profiles moved from deferred scheduling to chat:', resumed);
  db.prepare(
    "UPDATE inbound_processing SET status='failed',error='Process interrupted; inspect before replay' WHERE status='processing'",
  ).run();
  if (transport === 'photon') connection = await connectPhoton(handleInbound);
  ready = true;
  server.on('error', () => {
    console.error('HTTP listener failed.');
    process.exitCode = 1;
    void stop();
  });
  server.listen(
    Number(process.env.PORT ?? 3000),
    process.env.HOST ?? '127.0.0.1',
    () =>
      console.info(
        `Mixr ready (${transport}); health endpoint on port ${process.env.PORT ?? 3000}.`,
      ),
  );
  console.info('Teammate modules available:', integrationStatus);
  console.info('Conversation configuration:', {
    provider: process.env.LLM === 'fake' ? 'offline fake' : 'Claude',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    keyPresent: !!process.env.ANTHROPIC_API_KEY?.trim(),
    dailyRequestCap: process.env.CLAUDE_DAILY_REQUEST_LIMIT || '50',
  });
  if (!emailConfigured())
    console.warn(
      'Email verification is unconfigured; onboarding will wait at email verification.',
    );
  interval = setInterval(() => {
    void maintenance();
  }, 60_000);
  if (connection)
    connection.finished.then(
      () => {
        if (!stopping) {
          console.error('Photon stream ended.');
          process.exitCode = 1;
          void stop();
        }
      },
      () => {
        console.error('Photon stream failed.');
        process.exitCode = 1;
        void stop();
      },
    );
} catch {
  console.error(
    'Mixr startup failed. Check credentials, database path, and Photon access.',
  );
  process.exitCode = 1;
  await stop();
}
