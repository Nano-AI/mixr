import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, poolOf, useBus, useDebounced, type AppState, type InviteStatus, type Pool, type ProjectionPoint } from '../api.ts';
import { cx } from '../util.ts';
import { INVITE_STATUSES, inviteLabel } from './Chip.tsx';
import { eventPool } from './Pool.tsx';

type Props = {
  state: AppState;
  selectedEventId: number | null;
  onSelectEvent: (id: number) => void;
  onShowUser: (id: number) => void;
};

const PAD = 36;

type EvMarks = { eventId: number; e0?: ProjectionPoint; et?: ProjectionPoint };

export function MapTab({ state, selectedEventId, onSelectEvent, onShowUser }: Props) {
  const [points, setPoints] = useState<ProjectionPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hoverUser, setHoverUser] = useState<number | null>(null);
  const [hoverEvent, setHoverEvent] = useState<number | null>(null);
  const [byPool, setByPool] = useState(false);
  // Render the SVG at the container's real pixel size so labels stay legible at any inspector width.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 420 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize({ w: Math.max(240, Math.round(width)), h: Math.max(200, Math.round(height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;

  const load = useCallback(async () => {
    try {
      const r = await api.projection();
      setPoints(r.points ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const loadSoon = useDebounced(() => void load(), 500);
  useEffect(() => {
    void load();
  }, [load]);
  useBus((e) => {
    if (e.type === 'state') loadSoon();
  });

  const { users, events, sx, sy } = useMemo(() => {
    const pts = points ?? [];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs, 0);
    const maxX = Math.max(...xs, 0);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 0);
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const sx = (x: number) => PAD + ((x - minX) / spanX) * (W - 2 * PAD);
    const sy = (y: number) => H - PAD - ((y - minY) / spanY) * (H - 2 * PAD);
    const evMap = new Map<number, EvMarks>();
    for (const p of pts) {
      if (p.kind === 'user') continue;
      const id = p.eventId ?? Number(String(p.id).replace(/\D+/g, ''));
      const m = evMap.get(id) ?? { eventId: id };
      if (p.kind === 'event0') m.e0 = p;
      else m.et = p;
      evMap.set(id, m);
    }
    return { users: pts.filter((p) => p.kind === 'user'), events: [...evMap.values()], sx, sy };
  }, [points, W, H]);

  const selected = state.events.find((e) => e.id === selectedEventId) ?? null;
  const statusByUser = useMemo(() => {
    const m = new Map<number, InviteStatus>();
    if (!selected) return m;
    for (const inv of [...selected.invites].sort((a, b) => a.wave - b.wave)) m.set(inv.userId, inv.status);
    return m;
  }, [selected]);
  const titleOf = useMemo(() => new Map(state.events.map((e) => [e.id, e.title])), [state.events]);
  const { userPool, eventPoolOf } = useMemo(() => {
    const users = new Map(state.users.map((u) => [u.id, u]));
    const userPool = new Map<number, Pool>(state.users.map((u) => [u.id, poolOf(u)]));
    const eventPoolOf = new Map<number, Pool>(state.events.map((e) => [e.id, eventPool(e, users)]));
    return { userPool, eventPoolOf };
  }, [state.users, state.events]);

  const presentStatuses = INVITE_STATUSES.filter((s) => [...statusByUser.values()].includes(s));

  return (
    <div className="map-tab">
      <div className="map-toolbar">
        <label className="small muted" htmlFor="map-event">
          Highlight
        </label>
        <select
          id="map-event"
          className="input select"
          value={selectedEventId ?? ''}
          onChange={(e) => e.target.value && onSelectEvent(Number(e.target.value))}
        >
          {!state.events.length && <option value="">no events</option>}
          {state.events.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title} ({e.status})
            </option>
          ))}
        </select>
        <span className="grow" />
        <label className="small muted map-check" title="Color students and events by pool (real vs demo)">
          <input type="checkbox" checked={byPool} onChange={(e) => setByPool(e.target.checked)} />
          color by pool
        </label>
        <button className="mini-btn" onClick={() => void load()}>
          ↻ refresh
        </button>
      </div>

      <div className="map-wrap" ref={wrapRef}>
        {error && <div className="error-box">Couldn’t load projection: {error}</div>}
        {points && points.length === 0 && <div className="empty">No vectors to project yet. Seed users to populate the map.</div>}
        {points && points.length > 0 && (
          <svg className={cx('map', byPool && 'by-pool')} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="2D projection of user and event vectors">
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="arrow-head" />
              </marker>
              <marker id="arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="arrow-head sel" />
              </marker>
            </defs>
            <rect x="0" y="0" width={W} height={H} className="map-bg" rx="12" />
            {/* grid */}
            {[0.25, 0.5, 0.75].map((f) => (
              <g key={f} className="map-grid">
                <line x1={W * f} y1={0} x2={W * f} y2={H} />
                <line x1={0} y1={H * f} x2={W} y2={H * f} />
              </g>
            ))}

            {/* users */}
            {users.map((p) => {
              const uid = Number(String(p.id).replace(/\D+/g, "")); // ids are `u{id}`
              const st = statusByUser.get(uid);
              const isHost = selected?.hostId === uid;
              const hovered = hoverUser === uid;
              return (
                <g
                  key={`u${p.id}`}
                  className={cx(
                    'map-user',
                    `pool-${userPool.get(uid) ?? 'demo'}`,
                    st && `st-${st}`,
                    isHost && 'host',
                    selected && !st && !isHost && 'dim',
                  )}
                  transform={`translate(${sx(p.x)},${sy(p.y)})`}
                  onMouseEnter={() => setHoverUser(uid)}
                  onMouseLeave={() => setHoverUser((h) => (h === uid ? null : h))}
                  onClick={() => Number.isFinite(uid) && onShowUser(uid)}
                >
                  <circle r={hovered ? 9 : st || isHost ? 7 : 5} />
                  {(hovered || st === 'yes' || isHost) && (
                    <text className={cx('map-label', hovered && 'strong')} y={-12} textAnchor="middle">
                      {p.label}
                      {isHost ? ' (host)' : ''}
                    </text>
                  )}
                </g>
              );
            })}

            {/* events: E0 → Et */}
            {events.map((m) => {
              const sel = m.eventId === selectedEventId;
              const hov = hoverEvent === m.eventId;
              const title = titleOf.get(m.eventId) ?? m.et?.label ?? m.e0?.label ?? `event ${m.eventId}`;
              const x0 = m.e0 ? sx(m.e0.x) : null;
              const y0 = m.e0 ? sy(m.e0.y) : null;
              const xt = m.et ? sx(m.et.x) : null;
              const yt = m.et ? sy(m.et.y) : null;
              const dist = x0 != null && xt != null && y0 != null && yt != null ? Math.hypot(xt - x0, yt - y0) : 0;
              // Shorten the arrow so its head stops at the Et marker's edge.
              const shrink = dist > 0 ? Math.max(0, (dist - 11) / dist) : 0;
              return (
                <g
                  key={`e${m.eventId}`}
                  className={cx(
                    'map-event',
                    `pool-${eventPoolOf.get(m.eventId) ?? 'demo'}`,
                    sel && 'sel',
                    !sel && selectedEventId != null && 'faded',
                  )}
                  onMouseEnter={() => setHoverEvent(m.eventId)}
                  onMouseLeave={() => setHoverEvent((h) => (h === m.eventId ? null : h))}
                  onClick={() => onSelectEvent(m.eventId)}
                >
                  {dist > 4 && x0 != null && y0 != null && xt != null && yt != null && (
                    <line
                      className="drift-line"
                      x1={x0}
                      y1={y0}
                      x2={x0 + (xt - x0) * shrink}
                      y2={y0 + (yt - y0) * shrink}
                      markerEnd={sel ? 'url(#arrow-sel)' : 'url(#arrow)'}
                    />
                  )}
                  {x0 != null && y0 != null && (
                    <rect className="e0" x={x0 - 7} y={y0 - 7} width={14} height={14} transform={`rotate(45 ${x0} ${y0})`}>
                      <title>{title} · E0 (original HyDE target)</title>
                    </rect>
                  )}
                  {xt != null && yt != null && (
                    <g transform={`translate(${xt},${yt})`}>
                      <circle className="et-ring" r={11} />
                      <circle className="et" r={6} />
                      <title>{title} · Et (current target after Rocchio)</title>
                    </g>
                  )}
                  {(sel || hov) && (xt ?? x0) != null && (
                    <text className="map-label event-label" x={(xt ?? x0)!} y={(yt ?? y0)! + 26} textAnchor="middle">
                      {title}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>

      <div className="legend">
        <span className="lg">
          <svg width="12" height="12">
            <circle cx="6" cy="6" r="4" className="lg-user" />
          </svg>
          student
        </span>
        <span className="lg">
          <svg width="14" height="14">
            <rect x="3" y="3" width="8" height="8" transform="rotate(45 7 7)" className="lg-e0" />
          </svg>
          E0 (HyDE target)
        </span>
        <span className="lg">
          <svg width="16" height="16">
            <circle cx="8" cy="8" r="7" className="lg-et-ring" />
            <circle cx="8" cy="8" r="4" className="lg-et" />
          </svg>
          Et (after Rocchio)
        </span>
        <span className="lg">
          <svg width="14" height="14">
            <circle cx="7" cy="7" r="5" className="lg-host" />
          </svg>
          host
        </span>
        {byPool &&
          (['real', 'demo'] as const).map((p) => (
            <span key={p} className={`lg pool-${p}`}>
              <i className="lg-dot lg-pool" />
              {p}
            </span>
          ))}
        {presentStatuses.map((s) => (
          <span key={s} className={`lg st-${s}`}>
            <i className="lg-dot" />
            {inviteLabel(s)}
          </span>
        ))}
      </div>
      <p className="muted small map-note">2D PCA of 1536-d embeddings. Distances are approximate; recall uses full cosine similarity.</p>
    </div>
  );
}
