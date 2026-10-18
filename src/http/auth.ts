import type { MiddlewareHandler } from 'hono';

// Admin login for the dashboard and /api/*. (Placeholder: lets everything through until implemented.)
export const requireAdmin: MiddlewareHandler = async (_c, next) => {
  await next();
};
