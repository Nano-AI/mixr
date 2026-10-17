// Typed client for the mixr server API (see docs/spec.md "Server API") plus the shared SSE stream.
import { useEffect, useRef, useSyncExternalStore } from 'react';

// ---- Domain types (mirror src/types.ts + the /api/state JSON shape) ----

export type TraceKind = 'recall' | 'rerank' | 'wave' | 'rocchio' | 'profile_update' | 'agent' | 'llm' | 'embed' | 'job' | 'hyde';
export const TRACE_KINDS: TraceKind[] = ['recall', 'rerank', 'wave', 'rocchio', 'profile_update', 'agent', 'llm', 'embed', 'job', 'hyde'];

export type InviteStatus = 'invited' | 'yes' | 'no_busy' | 'no_vibe' | 'expired' | 'waitlisted' | 'cancelled';
export type EventStatus = 'open' | 'full' | 'closed' | 'cancelled';
export type IntroStatus = 'proposed' | 'target_asked' | 'connected' | 'declined' | 'expired';

export type ApiUser = {
  id: number;
  phone: string;
  name: string | null;
  state: 'onboarding' | 'active';
  profile: string | null;
  snoozedUntil: string | null;
  seeded: boolean;
};

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

export type Message = { direction: 'in' | 'out'; text: string; simTime: string };

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
  | { type: 'state' };

// ---- fetch ----

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
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

function connect() {
  if (source) return;
  const es = new EventSource('/api/stream');
  source = es;
  es.onopen = () => {
    setStatus('open');
    // After a reconnect we may have missed updates: ask everyone to refetch.
    if (everOpened) dispatch({ type: 'state' });
    everOpened = true;
  };
  es.onmessage = (ev: MessageEvent<string>) => {
    try {
      dispatch(JSON.parse(ev.data) as BusEvent);
    } catch {
      /* ignore keepalives / malformed frames */
    }
  };
  es.onerror = () => {
    setStatus('reconnecting');
    // The browser retries on its own unless the connection is CLOSED (e.g. proxy 502); then we retry manually.
    if (es.readyState === EventSource.CLOSED) {
      es.close();
      source = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (listeners.size) connect();
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
