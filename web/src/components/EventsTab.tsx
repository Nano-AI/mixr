import { useMemo } from 'react';
import type { ApiEvent, ApiInvite, AppState, InviteStatus, Pool } from '../api.ts';
import { cx, fmtRel, fmtWhen } from '../util.ts';
import { EventChip, INVITE_STATUSES, InviteChip, inviteLabel } from './Chip.tsx';
import { countPools, eventPool, inPool, PoolBadge, PoolToggle, poolNow, type PoolFilter } from './Pool.tsx';

type Props = {
  state: AppState;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenPhone: (phone: string) => void;
  onShowUser: (id: number) => void;
  poolFilter: PoolFilter;
  setPoolFilter: (f: PoolFilter) => void;
};

const STATUS_ORDER = { open: 0, full: 1, closed: 2, cancelled: 3 } as const;

export function EventsTab({ state, selectedId, onSelect, onOpenPhone, onShowUser, poolFilter, setPoolFilter }: Props) {
  const usersById = useMemo(() => new Map(state.users.map((u) => [u.id, u])), [state.users]);
  const poolFor = useMemo(() => {
    const m = new Map(state.events.map((e) => [e.id, eventPool(e, usersById)]));
    return (e: ApiEvent): Pool => m.get(e.id) ?? 'demo';
  }, [state.events, usersById]);
  const counts = useMemo(() => countPools(state.events, poolFor), [state.events, poolFor]);
  const events = useMemo(
    () =>
      state.events
        .filter((e) => inPool(poolFor(e), poolFilter))
        .sort(
          (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        ),
    [state.events, poolFor, poolFilter],
  );
  const selected = state.events.find((e) => e.id === selectedId) ?? null;

  if (!state.events.length) {
    return (
      <div className="empty">
        <div className="empty-title">No events yet</div>
        Text mixr from a phone like “hosting catan night friday 7pm at the HUB, room for 6” to create one. Invites go out in hidden waves.
      </div>
    );
  }

  return (
    <div className="split events-split">
      <div className="list-wrap event-list-wrap">
        <div className="list-search">
          <span className="muted small grow">
            {events.length} event{events.length === 1 ? '' : 's'}
          </span>
          <PoolToggle value={poolFilter} onChange={setPoolFilter} counts={counts} />
        </div>
        <ul className="list event-list">
          {events.length === 0 && <li className="empty small">No {poolFilter} events.</li>}
          {events.map((e) => {
            const pool = poolFor(e);
            return (
              <li key={e.id}>
                <button className={cx('list-item', e.id === selectedId && 'selected')} onClick={() => onSelect(e.id)}>
                  <div className="li-main">
                    <div className="li-title">{e.title}</div>
                    <div className="li-sub">
                      {e.hostName ?? 'unknown host'} · {fmtWhen(e.startsAt)}{' '}
                      <span className="muted">({fmtRel(e.startsAt, poolNow(pool, state.now))})</span>
                    </div>
                  </div>
                  <div className="li-side">
                    <div className="row">
                      <PoolBadge pool={pool} />
                      <EventChip status={e.status} />
                    </div>
                    <Capacity going={e.going} capacity={e.capacity} />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {selected ? (
        <EventDetail
          ev={selected}
          pool={poolFor(selected)}
          now={poolNow(poolFor(selected), state.now)}
          users={state.users}
          onOpenPhone={onOpenPhone}
          onShowUser={onShowUser}
        />
      ) : (
        <div className="empty">Select an event</div>
      )}
    </div>
  );
}

function Capacity({ going, capacity }: { going: number; capacity: number }) {
  const pct = capacity > 0 ? Math.min(100, (going / capacity) * 100) : 0;
  return (
    <div className="cap" title={`${going} going of ${capacity}`}>
      <div className="cap-bar">
        <div className="cap-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="cap-num">
        {going}/{capacity}
      </span>
    </div>
  );
}

function DriftMeter({ cos }: { cos: number | null }) {
  if (cos == null) return <span className="muted">—</span>;
  const drift = Math.max(0, 1 - cos);
  // Rocchio keeps Et anchored (0.70·E0), so cos rarely drops below ~0.7. Scale the bar to [0.6, 1].
  const pct = Math.max(0, Math.min(100, ((cos - 0.6) / 0.4) * 100));
  return (
    <div className="drift">
      <div className="drift-bar">
        <div className="drift-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="mono">
        cos(Et, E0) = <b>{cos.toFixed(3)}</b>
      </span>
      <span className="muted small">drift {(drift * 100).toFixed(1)}%</span>
    </div>
  );
}

function EventDetail({
  ev,
  pool,
  now,
  users,
  onOpenPhone,
  onShowUser,
}: {
  ev: ApiEvent;
  pool: Pool;
  now: string; // the event's pool clock: wall time for real, the demo clock for demo
  users: AppState['users'];
  onOpenPhone: (phone: string) => void;
  onShowUser: (id: number) => void;
}) {
  const phoneOf = useMemo(() => new Map(users.map((u) => [u.id, u.phone])), [users]);
  const host = users.find((u) => u.id === ev.hostId);

  const waves = useMemo(() => {
    const m = new Map<number, ApiInvite[]>();
    for (const inv of ev.invites) {
      const arr = m.get(inv.wave) ?? [];
      arr.push(inv);
      m.set(inv.wave, arr);
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }, [ev.invites]);

  const totals = useMemo(() => {
    const t: Partial<Record<InviteStatus, number>> = {};
    for (const inv of ev.invites) t[inv.status] = (t[inv.status] ?? 0) + 1;
    return t;
  }, [ev.invites]);

  const goingNames = ev.invites.filter((i) => i.status === 'yes').map((i) => i.name ?? `#${i.userId}`);

  return (
    <div className="detail">
      <div className="detail-head">
        <h3>{ev.title}</h3>
        <PoolBadge pool={pool} />
        <EventChip status={ev.status} />
      </div>
      <div className="meta-grid">
        <span className="meta-k">pool</span>
        <span className="muted small">
          {pool === 'real' ? 'real host · wall-clock time · invites go to real users' : 'demo host · demo clock · nothing delivered'}
        </span>
        <span className="meta-k">host</span>
        <span>
          {host ? (
            <button className="link" onClick={() => onShowUser(host.id)}>
              {ev.hostName ?? host.name}
            </button>
          ) : (
            ev.hostName ?? '—'
          )}
          {host && (
            <button className="mini-btn" onClick={() => onOpenPhone(host.phone)} title="Open host's phone">
              phone
            </button>
          )}
        </span>
        <span className="meta-k">when</span>
        <span>
          {fmtWhen(ev.startsAt)} <span className="muted">({fmtRel(ev.startsAt, now)})</span>
        </span>
        <span className="meta-k">where</span>
        <span>{ev.location}</span>
        <span className="meta-k">going</span>
        <span className="row-gap">
          <Capacity going={ev.going} capacity={ev.capacity} />
          {goingNames.length > 0 && <span className="muted small">{goingNames.join(', ')}</span>}
        </span>
      </div>
      {ev.description && <p className="desc">{ev.description}</p>}

      <details className="collapsible">
        <summary>HyDE target profile</summary>
        <pre className="profile-text">{ev.hydeProfile || '—'}</pre>
      </details>

      <div className="section-head">
        <h4>Going</h4>
        <span className="muted small">
          host + {ev.going}/{ev.capacity} guest{ev.capacity === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="invites attendees">
        {(ev.attendees ?? []).map((a) => {
          const phone = phoneOf.get(a.userId);
          return (
            <li key={`${a.role}-${a.userId}`} className="invite">
              <div className="invite-top">
                <button className="link strong" onClick={() => onShowUser(a.userId)}>
                  {a.name ?? `user #${a.userId}`}
                </button>
                <span className="muted small">
                  {a.role === 'host' ? 'host' : a.source === 'discover' ? 'joined via discover' : 'said yes to an invite'}
                  {a.role === 'guest' && a.joinedAt ? ` · ${fmtRel(a.joinedAt, now)}` : ''}
                </span>
                <span className="grow" />
                {phone && (
                  <button className="mini-btn" onClick={() => onOpenPhone(phone)} title="Open their phone">
                    phone
                  </button>
                )}
              </div>
            </li>
          );
        })}
        {(ev.attendees ?? []).every((a) => a.role === 'host') && <li className="invite muted small">No guests yet.</li>}
      </ul>

      {(ev.requirements?.length ?? 0) > 0 && (
        <>
          <div className="section-head">
            <h4>Special requests</h4>
            <span className="muted small">enforced: person rules before recall, text rules judged per candidate</span>
          </div>
          <ul className="req-list">
            {ev.requirements!.map((r) => {
              const verdicts = (ev.screenings ?? []).filter((x) => x.requirementId === r.id);
              const failed = verdicts.filter((x) => x.verdict !== 'pass');
              return (
                <li key={r.id} className="req">
                  <div className="req-top">
                    <span className="tag tag-muted">{r.strength}</span>
                    <strong>{r.kind === 'person' ? `keep off: ${r.person}` : r.criterion}</strong>
                    {r.kind === 'text' && (
                      <span className="muted small">
                        {verdicts.length - failed.length} pass · {failed.length} screened out
                        {failed.length > 0 && `: ${failed.map((x) => x.name ?? `#${x.userId}`).join(', ')}`}
                      </span>
                    )}
                  </div>
                  <div className="req-said">“{r.said}”</div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="internal">
        <div className="internal-label">internal · never shown to students</div>
        <div className="meta-grid">
          <span className="meta-k">wave</span>
          <span className="mono">#{ev.waveNumber}</span>
          <span className="meta-k">next wave</span>
          <span>
            {ev.nextWaveAt && (ev.status === 'open' || ev.status === 'full') ? (
              <>
                {fmtWhen(ev.nextWaveAt)} <span className="muted">({fmtRel(ev.nextWaveAt, now)})</span>
              </>
            ) : (
              <span className="muted">none scheduled</span>
            )}
          </span>
          <span className="meta-k">Et drift</span>
          <DriftMeter cos={ev.cosToE0} />
        </div>
      </div>

      <div className="section-head">
        <h4>Invites</h4>
        <div className="status-totals">
          {INVITE_STATUSES.filter((s) => totals[s]).map((s) => (
            <span key={s} className={`dot-count st-${s}`} title={inviteLabel(s)}>
              <i />
              {totals[s]} {inviteLabel(s)}
            </span>
          ))}
        </div>
      </div>
      {waves.length === 0 && <div className="muted small pad">No invites sent yet. The first wave runs as soon as the event is created.</div>}
      {waves.map(([wave, invites]) => (
        <div key={wave} className="wave">
          <div className="wave-head">
            <span className="wave-num">{wave === 0 ? 'discover' : `wave ${wave}`}</span>
            <span className="muted small">
              {invites.length} invite{invites.length === 1 ? '' : 's'}
              {invites[0]?.invitedAt ? ` · ${fmtWhen(invites[0].invitedAt)}` : ''}
            </span>
          </div>
          <ul className="invites">
            {invites.map((inv) => {
              const phone = phoneOf.get(inv.userId);
              return (
                <li key={`${inv.userId}-${inv.wave}`} className="invite">
                  <div className="invite-top">
                    <button className="link strong" onClick={() => onShowUser(inv.userId)}>
                      {inv.name ?? `user #${inv.userId}`}
                    </button>
                    <InviteChip status={inv.status} />
                    {inv.source === 'discover' && <span className="muted small">via discover</span>}
                    {inv.respondedAt && <span className="muted small">replied {fmtRel(inv.respondedAt, now)}</span>}
                    <span className="grow" />
                    {phone && (
                      <button className="mini-btn" onClick={() => onOpenPhone(phone)} title="Open their phone">
                        phone
                      </button>
                    )}
                  </div>
                  {inv.pitch && <div className="pitch">“{inv.pitch}”</div>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
