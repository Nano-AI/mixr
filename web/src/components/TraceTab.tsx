import { memo, useMemo, useState } from 'react';
import { TRACE_KINDS, type AppState, type TraceEntry, type TraceKind } from '../api.ts';
import type { TraceFeed } from '../useTraces.ts';
import { cx, fmtClock } from '../util.ts';
import { Json, TraceBody, eventIdOf, summarize, userIdOf, type TraceCtx } from './traceRenderers.tsx';

type Props = {
  state: AppState;
  feed: TraceFeed;
  onShowEvent: (id: number) => void;
  onShowUser: (id: number) => void;
};

const KIND_LABEL: Record<TraceKind, string> = {
  recall: 'recall',
  rerank: 'rerank',
  wave: 'wave',
  rocchio: 'rocchio',
  profile_update: 'profile',
  agent: 'agent',
  llm: 'llm',
  embed: 'embed',
  job: 'job',
  hyde: 'hyde',
  safety: 'safety',
};

const PAGE = 120;

export function TraceTab({ state, feed, onShowEvent, onShowUser }: Props) {
  const [filter, setFilter] = useState<Set<TraceKind>>(new Set());
  const [limit, setLimit] = useState(PAGE);

  const ctx = useMemo<TraceCtx>(
    () => ({
      usersById: new Map(state.users.map((u) => [u.id, u])),
      eventsById: new Map(state.events.map((e) => [e.id, e])),
    }),
    [state.users, state.events],
  );

  const counts = useMemo(() => {
    const c = new Map<TraceKind, number>();
    for (const t of feed.traces) c.set(t.kind, (c.get(t.kind) ?? 0) + 1);
    return c;
  }, [feed.traces]);

  const visible = useMemo(() => (filter.size ? feed.traces.filter((t) => filter.has(t.kind)) : feed.traces), [feed.traces, filter]);

  const toggle = (k: TraceKind) =>
    setFilter((f) => {
      const n = new Set(f);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div className="trace-tab">
      <div className="filters">
        <button className={cx('fchip', filter.size === 0 && 'on')} onClick={() => setFilter(new Set())}>
          all <span className="fcount">{feed.traces.length}</span>
        </button>
        {TRACE_KINDS.map((k) => (
          <button key={k} className={cx('fchip', `k-${k}`, filter.has(k) && 'on')} onClick={() => toggle(k)}>
            {KIND_LABEL[k]} <span className="fcount">{counts.get(k) ?? 0}</span>
          </button>
        ))}
        <button className="fchip ghost" onClick={feed.reload} title="Reload from server">
          ↻
        </button>
      </div>
      <div className="trace-list">
        {feed.error && <div className="error-box">Couldn’t load traces: {feed.error}</div>}
        {!feed.loading && visible.length === 0 && (
          <div className="empty">{feed.traces.length ? 'No traces of the selected kinds.' : 'No traces yet. Text mixr or advance the clock.'}</div>
        )}
        {visible.slice(0, limit).map((t) => (
          <TraceItem key={t.id} t={t} ctx={ctx} onShowEvent={onShowEvent} onShowUser={onShowUser} />
        ))}
        {visible.length > limit && (
          <button className="btn more-btn" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({visible.length - limit} older)
          </button>
        )}
      </div>
    </div>
  );
}

const TraceItem = memo(function TraceItem({
  t,
  ctx,
  onShowEvent,
  onShowUser,
}: {
  t: TraceEntry;
  ctx: TraceCtx;
  onShowEvent: (id: number) => void;
  onShowUser: (id: number) => void;
}) {
  const quiet = t.kind === 'llm' || t.kind === 'embed' || t.kind === 'job';
  const [open, setOpen] = useState(!quiet);
  const [raw, setRaw] = useState(false);
  const evId = eventIdOf(t, ctx);
  const userId = userIdOf(t, ctx);
  const failed = t.kind === 'job' && !!(t.data && typeof t.data === 'object' && 'error' in t.data);

  return (
    <div className={cx('trace', `k-${t.kind}`, open && 'open', failed && 'failed')}>
      <div className="trace-head" onClick={() => setOpen((o) => !o)}>
        <span className={cx('kind', `k-${t.kind}`)}>{KIND_LABEL[t.kind] ?? t.kind}</span>
        <span className="trace-sum">{summarize(t, ctx)}</span>
        <span className="trace-time mono">{fmtClock(t.simTime)}</span>
        <span className="caret">{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div className="trace-body">
          {raw ? <Json v={t} /> : <TraceBody t={t} ctx={ctx} />}
          <div className="trace-actions">
            <button className="mini-btn" onClick={() => setRaw((r) => !r)}>
              {raw ? 'readable' : '{ } raw JSON'}
            </button>
            {evId != null && (
              <button className="mini-btn" onClick={() => onShowEvent(evId)}>
                → event
              </button>
            )}
            {userId != null && (
              <button className="mini-btn" onClick={() => onShowUser(userId)}>
                → user
              </button>
            )}
            {t.refId != null && <span className="muted small mono">ref {t.refId}</span>}
          </div>
        </div>
      )}
    </div>
  );
});
