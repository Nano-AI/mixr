import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { dashboardApi } from './http/dashboard.ts';
import { publicApi, setReady } from './http/public.ts';
import { requireAdmin } from './http/auth.ts';
import { startTicker, stopTicker } from './runtime.ts';
// Imported for their side effects too: each registers its job handlers at load time.
import './profiles/index.ts';
import './relay/index.ts';
import './events/index.ts';

// The monolith: public routes (website join, health), the admin-only dashboard API, and the background ticker.
// Hostname-agnostic: it serves whatever Host it's reached on (a tunnel subdomain or api.joinmixr.club).

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const app = new Hono();

app.onError((e, c) => c.json({ ok: false, error: errMsg(e) }, 500));

app.route('/', publicApi);

app.use('/api/*', cors({ origin: (o) => (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : null), credentials: true }));
app.use('/api/*', requireAdmin);
app.route('/api', dashboardApi);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`mixr listening on ${config.host}:${info.port} (transport: ${config.transport})`);
  });
  startTicker();
  setReady(true);
  const stop = () => {
    setReady(false);
    stopTicker();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
