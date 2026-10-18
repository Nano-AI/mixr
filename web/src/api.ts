// Typed client for the mixr server API (see docs/spec.md "Server API") plus the shared SSE stream.
import { useEffect, useRef, useSyncExternalStore } from 'react';

// ---- Domain types (mirror src/types.ts + the /api/state JSON shape) ----

export type TraceKind = 'recall' | 'rerank' | 'wave' | 'rocchio' | 'profile_update' | 'agent' | 'llm' | 'embed' | 'job' | 'hyde' | 'requirement' | 'block';
export const TRACE_KINDS: TraceKind[] = ['recall', 'rerank', 'wave', 'rocchio', 'profile_update', 'agent', 'llm', 'embed', 'job', 'hyde', 'requirement', 'block'];

export type InviteStatus = 'invited' | 'yes' | 'no_busy' | 'no_vibe' | 'expired' | 'waitlisted' | 'cancelled' | 'withdrawn';
export type EventStatus = 'open' | 'full' | 'closed' | 'cancelled';
export type IntroStatus = 'proposed' | 'target_asked' | 'connected' | 'declined' | 'expired';

// demo: seeded fixtures + numbers created in the dashboard (simulated clock, nothing ever delivered).
// real: joined via the website + iMessage (wall-clock time). Acting as one keeps replies in the dashboard.
export type Pool = 'demo' | 'real';
export type OnboardingStep = 'consent' | 'name' | 'email' | 'verify';

export type ApiUser = {
  id: number;
  phone: string;
  name: string | null;
  state: 'onboarding' | 'active';
  profile: string | null;
  snoozedUntil: string | null;
  seeded: boolean;
  pool?: Pool;
  step?: OnboardingStep | null; // real users mid-onboarding, before the agent takes over
  emailVerified?: boolean;
  optedOut?: boolean;
  assignedNumber?: string | null; // the number this user texts mixr at
  joinedVia?: string | null; // 'web' | 'imessage' | 'demo'
  joinedAt?: string | null;
  blocks?: { name: string; matches: number[] }[];
  requirements?: ApiRequirement[]; // standing (people-matching) preferences
};

/** A user's pool. Unknown numbers (a fresh pane before its first text) are demo: the dashboard creates them there. */
export const poolOf = (u: Pick<ApiUser, 'pool' | 'seeded'> | null | undefined): Pool => u?.pool ?? (u && !u.seeded ? 'real' : 'demo');

export type ApiRequirement = {
  id: number;
  ownerId: number;
  eventId: number | null;
  kind: 'person' | 'text';
  person: string | null;
  criterion: string | null;
  strength: 'must' | 'prefer';
  said: string;
};

export type ApiScreening = { userId: number; name: string | null; requirementId: number; verdict: 'pass' | 'fail' | 'unknown'; reason: string | null };

export type ApiInvite = {
  userId: number;
  name: string | null;
  wave: number;
  status: InviteStatus;
  pitch: string | null;
  invitedAt: string | null;
  respondedAt: string | null;
  source?: 'invite' | 'discover';
};

// Someone going to an event: the host plus every guest who said yes (server: event_attendees view).
export type ApiAttendee = {
  userId: number;
  name: string | null;
  role: 'host' | 'guest';
  joinedAt: string | null;
  source: 'host' | 'invite' | 'discover';
};

export type ApiEvent = {
  id: number;
  hostId: number;
  hostName: string | null;
  pool?: Pool; // the host's pool
  title: string;
  description: string;
  startsAt: string;
  location: string;
  capacity: number;
  status: EventStatus;
  waveNumber: number;
  nextWaveAt: string | null;
  hydeProfile: string;
  going: number;
  cosToE0: number | null;
  invites: ApiInvite[];
  attendees?: ApiAttendee[];
  requirements?: ApiRequirement[];
  screenings?: ApiScreening[];
};

export type ApiIntro = { id: number; requesterName: string | null; targetName: string | null; reason: string; status: IntroStatus };

export type Usage = {
  llmCalls: number;
  byPurpose: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  embedTokens: number;
};

export type AppState = { now: string; users: ApiUser[]; events: ApiEvent[]; intros: ApiIntro[]; usage: Usage };

// delivery (outbound): the iMessage job's status, or not_delivered when nothing was queued (demo users, and replies
// while the dashboard acts as a real user).
export type Delivery = 'sent' | 'pending' | 'failed' | 'suppressed' | 'not_delivered';
export type Message = {
  direction: 'in' | 'out';
  text: string;
  simTime: string;
  via?: string; // inbound: 'phone' (their own phone) | 'dashboard' (typed here); outbound: 'system'
  delivery?: Delivery;
  deliveryError?: string | null;
};

export type TraceEntry = { id: number | string; simTime: string; kind: TraceKind; refId: number | null; data: unknown };

export type ProjectionPoint = {
  id: number | string;
  label: string;
  kind: 'user' | 'event0' | 'eventT';
  eventId?: number;
  x: number;
  y: number;
};

export type BusEvent =
  | { type: 'message'; userId: number; phone: string; direction: 'in' | 'out'; text: string; simTime: string }
  | { type: 'trace'; kind: TraceKind; refId: number | null; data: unknown; simTime: string }
  | { type: 'clock'; now: string }
  | { type: 'state' }
  | { type: 'reset' } // everything was wiped: close phone panes
  | { type: 'resync' }; // messages changed in bulk (seeding, reconnect): reload open panes

// ---- auth ----
// checking: asking /auth/me · signed-in: valid session · open: server has no ADMIN_TOKEN (local dev)
// signed-out: show the login · misconfigured: production server without ADMIN_TOKEN (everything locked)
// unknown: couldn't ask (server down); render the app, which retries and drops to the login on a 401.

export type AuthStatus = 'checking' | 'signed-in' | 'open' | 'signed-out' | 'misconfigured' | 'unknown';

let authStatus: AuthStatus = 'checking';
const authListeners = new Set<() => void>();

function setAuth(s: AuthStatus) {
  if (s === authStatus) return;
  authStatus = s;
  if (s === 'signed-out' || s === 'misconfigured') closeStream();
  authListeners.forEach((fn) => fn());
}

export function useAuth(): AuthStatus {
  return useSyncExternalStore(
    (cb) => {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
    () => authStatus,
  );
}

/** Thrown by API calls that failed because the dashboard isn't signed in; the login screen takes over. */
export class AuthError extends Error {}

const NOT_CONFIGURED = /ADMIN_TOKEN/;
// Marks requests as coming from the dashboard (the server refuses cookie-authenticated writes without it).
const DASHBOARD_HEADER = { 'x-mixr-dashboard': '1' };

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function checkAuth(): Promise<AuthStatus> {
  // Server unreachable (or a dev proxy error): keep what we knew; on first load, fall through to the app.
  const unreachable = () => authStatus === 'checking' && setAuth('unknown');
  try {
    const res = await fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    const j = await readJson(res);
    if (res.status === 503 && NOT_CONFIGURED.test(String(j?.error ?? ''))) setAuth('misconfigured');
    else if (!res.ok || !j) unreachable();
    else setAuth(j.open ? 'open' : j.authenticated ? 'signed-in' : 'signed-out');
  } catch {
    unreachable();
  }
  return authStatus;
}

export type LoginResult = { ok: true } | { ok: false; error: string };

export async function login(token: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...DASHBOARD_HEADER },
      body: JSON.stringify({ token }),
    });
  } catch {
    return { ok: false, error: 'Can’t reach the server. Check your connection and try again.' };
  }
  const j = await readJson(res);
  if (res.ok) {
    setAuth(j?.open ? 'open' : 'signed-in');
    return { ok: true };
  }
  if (res.status === 429) {
    const secs = Number(j?.retryAfter ?? res.headers.get('retry-after') ?? 0);
    const mins = Math.max(1, Math.ceil(secs / 60));
    return { ok: false, error: `Too many attempts from this network. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  if (res.status === 503 && NOT_CONFIGURED.test(String(j?.error ?? ''))) {
    setAuth('misconfigured');
    return { ok: false, error: 'This server has no ADMIN_TOKEN set.' };
  }
  if (res.status === 401) return { ok: false, error: 'That token didn’t work.' };
  return { ok: false, error: String(j?.error ?? `Sign-in failed (${res.status}).`) };
}

export async function logout(): Promise<void> {
  try {
    await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: DASHBOARD_HEADER });
  } finally {
    setAuth('signed-out');
  }
}

// ---- fetch ----
let lastAuthRecheck = 0;
// Paths are root-relative: the dashboard is served by the API server itself, on whatever hostname it's reached at.

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? DASHBOARD_HEADER : { 'content-type': 'application/json', ...DASHBOARD_HEADER },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status === 401) {
    setAuth('signed-out');
    throw new AuthError('Signed out');
  }
  if (res.status === 503 && NOT_CONFIGURED.test(text)) {
    setAuth('misconfigured');
    throw new AuthError('ADMIN_TOKEN not set');
  }
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string; message?: string };
      msg = j.error ?? j.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`${method} ${path} → ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`);
  }
  // The server is back after an unknown start: learn whether a login is in play (throttled).
  if (authStatus === 'unknown' && Date.now() - lastAuthRecheck > 10_000) {
    lastAuthRecheck = Date.now();
    void checkAuth();
  }
  return (text ? JSON.parse(text) : null) as T;
}

export const api = {
  state: () => request<AppState>('GET', '/api/state'),
  messages: (phone: string) => request<Message[]>('GET', `/api/messages/${encodeURIComponent(phone)}`),
  inbound: (phone: string, text: string) => request<{ ok: boolean }>('POST', '/api/inbound', { phone, text }),
  advance: (minutes: number) => request<{ now: string; jobsRan: number }>('POST', '/api/clock/advance', { minutes }),
  traces: (limit = 300, kind?: TraceKind) =>
    request<TraceEntry[]>('GET', `/api/traces?limit=${limit}${kind ? `&kind=${kind}` : ''}`),
  projection: () => request<{ points: ProjectionPoint[] }>('GET', '/api/projection'),
  reset: () => request<unknown>('POST', '/api/reset'),
  seed: () => request<unknown>('POST', '/api/seed'),
};

// ---- SSE: one EventSource for the whole app, auto-reconnecting ----

export type StreamStatus = 'connecting' | 'open' | 'reconnecting';
type Listener = (e: BusEvent) => void;

const listeners = new Set<Listener>();
const statusListeners = new Set<() => void>();
let status: StreamStatus = 'connecting';
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let everOpened = false;
let lastHeard = 0;

// A proxied stream can go silent without erroring (e.g. the backend restarted behind Vite). The server pings
// every 10s; if nothing arrives for this long, drop the connection and open a fresh one.
const STALE_MS = 25_000;
setInterval(() => {
  if (source && status === 'open' && Date.now() - lastHeard > STALE_MS) {
    source.close();
    source = null;
    setStatus('reconnecting');
    if (listeners.size) connect();
  }
}, 5_000);

function setStatus(s: StreamStatus) {
  if (s === status) return;
  status = s;
  statusListeners.forEach((fn) => fn());
}

function dispatch(e: BusEvent) {
  listeners.forEach((fn) => {
    try {
      fn(e);
    } catch (err) {
      console.error('bus listener failed', err);
    }
  });
}

function closeStream() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
  everOpened = false;
  setStatus('connecting');
}

const signedOut = () => authStatus === 'signed-out' || authStatus === 'misconfigured';

function connect() {
  if (source || signedOut()) return;
  const es = new EventSource('/api/stream'); // same-origin, so the session cookie goes along
  source = es;
  lastHeard = Date.now();
  es.addEventListener('ping', () => void (lastHeard = Date.now()));
  es.onopen = () => {
    lastHeard = Date.now();
    setStatus('open');
    // After a reconnect we may have missed updates (state and messages): ask everyone to reload.
    if (everOpened) {
      dispatch({ type: 'resync' });
      dispatch({ type: 'state' });
    }
    everOpened = true;
  };
  es.onmessage = (ev: MessageEvent<string>) => {
    lastHeard = Date.now();
    try {
      dispatch(JSON.parse(ev.data) as BusEvent);
    } catch {
      /* ignore keepalives / malformed frames */
    }
  };
  es.onerror = () => {
    setStatus('reconnecting');
    // The browser retries on its own unless the connection is CLOSED (an HTTP error such as a 401 or a proxy
    // 502); then we find out whether the session ended (show the login) or retry manually.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      if (source === es) source = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void checkAuth().then(() => {
          if (listeners.size) connect();
        });
      }, 2000);
    }
  };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
  };
}

/** Subscribe to the shared bus. The handler may change every render; the subscription doesn't. */
export function useBus(handler: Listener): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => subscribe((e) => ref.current(e)), []);
}

export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
  );
}

/** Debounced callback with a stable identity. */
export function useDebounced(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    fnRef.current = fn;
  });
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const stable = useRef(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      fnRef.current();
    }, ms);
  });
  return stable.current;
}
