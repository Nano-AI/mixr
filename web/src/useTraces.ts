import { useEffect, useRef, useState } from 'react';
import { api, useBus, type TraceEntry } from './api.ts';
import { stableStringify } from './util.ts';

const MAX_TRACES = 600;

const sig = (t: Pick<TraceEntry, 'simTime' | 'kind' | 'refId' | 'data'>) =>
  `${t.simTime}|${t.kind}|${t.refId}|${stableStringify(t.data)}`;

export type TraceFeed = { traces: TraceEntry[]; loading: boolean; error: string | null; reload: () => void };

/** Trace history (newest first) from GET /api/traces, kept live by SSE 'trace' events. */
export function useTraces(epoch: number): TraceFeed {
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const liveId = useRef(0);
  const duringFetch = useRef<TraceEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    duringFetch.current = [];
    setLoading(true);
    api
      .traces(300)
      .then((rows) => {
        if (cancelled) return;
        const seen = new Set(rows.map(sig));
        const fresh = (duringFetch.current ?? []).filter((t) => !seen.has(sig(t)));
        setTraces([...fresh, ...rows].slice(0, MAX_TRACES));
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) {
          duringFetch.current = null;
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [epoch, nonce]);

  useBus((e) => {
    if (e.type !== 'trace') return;
    const entry: TraceEntry = { id: `live-${++liveId.current}`, simTime: e.simTime, kind: e.kind, refId: e.refId, data: e.data };
    if (duringFetch.current) duringFetch.current.unshift(entry);
    setTraces((t) => [entry, ...t].slice(0, MAX_TRACES));
  });

  return { traces, loading, error, reload: () => setNonce((n) => n + 1) };
}
