import { Hono } from 'hono';

// Public, unauthenticated routes: the website's join endpoint and the health check.

export const publicApi = new Hono();

let ready = false;
export const setReady = (v: boolean): void => void (ready = v);

publicApi.get('/health', (c) => c.json({ ready }, ready ? 200 : 503));
