import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

// The built dashboard (web/dist, from `npm --prefix web run build`) at /dashboard/. Host-agnostic: redirects and
// asset URLs are paths only. The page itself is public (it holds no data); everything it loads from /api is
// behind requireAdmin, and the page shows its own login.

const BASE = '/dashboard';
const DIST = fileURLToPath(new URL('../../web/dist/', import.meta.url));
const IMMUTABLE = 'public, max-age=31536000, immutable'; // Vite fingerprints every file under assets/
const REVALIDATE = 'no-cache';

const cache =
  (value: string): MiddlewareHandler =>
  async (c, next) => {
    c.header('Cache-Control', value);
    await next();
  };

export function createDashboardStatic(root: string = DIST): Hono {
  const strip = (path: string) => path.slice(BASE.length) || '/';
  let files: MiddlewareHandler | null = null; // created on first use, so an unbuilt dashboard doesn't log at startup
  const serveFiles: MiddlewareHandler = async (c, next) => {
    if (!existsSync(root)) return next();
    files ??= serveStatic({ root, rewriteRequestPath: strip });
    return files(c, next);
  };

  const index = async (c: Context) => {
    let html: string;
    try {
      html = await readFile(join(root, 'index.html'), 'utf8');
    } catch {
      c.header('Cache-Control', 'no-store');
      return c.text('Dashboard not built. Run: npm --prefix web run build', 503);
    }
    c.header('Cache-Control', REVALIDATE);
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(html);
  };

  const r = new Hono();
  r.get('/', (c) => c.redirect(`${BASE}/`));
  r.get(BASE, (c) => c.redirect(`${BASE}/`));
  r.get(`${BASE}/`, index);
  // A missing asset is a 404, not the SPA page (a script tag fed HTML fails confusingly).
  r.get(`${BASE}/assets/*`, cache(IMMUTABLE), serveFiles, (c) => {
    c.header('Cache-Control', 'no-store');
    return c.text('Not found', 404);
  });
  // Other files in dist (favicon etc.), else the SPA page for client-side paths.
  r.get(`${BASE}/*`, cache(REVALIDATE), serveFiles, index);
  return r;
}

// Mount at '/', after every other route: it owns GET /, /dashboard and /dashboard/*.
export const dashboardStatic = createDashboardStatic();
