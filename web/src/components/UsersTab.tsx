import { Fragment, useMemo, useState } from 'react';
import { poolOf, type ApiUser, type AppState } from '../api.ts';
import { cx, firstName, fmtPhone, fmtRel, fmtWhen, initials } from '../util.ts';
import { EventChip, IntroChip, InviteChip } from './Chip.tsx';
import { countPools, inPool, joinedViaLabel, PoolBadge, PoolToggle, poolNow, UserFlags, type PoolFilter } from './Pool.tsx';

type Props = {
  state: AppState;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenPhone: (phone: string) => void;
  onShowEvent: (id: number) => void;
  poolFilter: PoolFilter;
  setPoolFilter: (f: PoolFilter) => void;
};

const isSnoozed = (u: ApiUser, now: string) => !!u.snoozedUntil && new Date(u.snoozedUntil) > new Date(now);

export function UsersTab({ state, selectedId, onSelect, onOpenPhone, onShowEvent, poolFilter, setPoolFilter }: Props) {
  const [q, setQ] = useState('');
  const matching = useMemo(() => {
    const s = q.trim().toLowerCase();
    return state.users.filter(
      (u) => !s || (u.name ?? '').toLowerCase().includes(s) || u.phone.includes(s) || (u.profile ?? '').toLowerCase().includes(s),
    );
  }, [q, state.users]);
  const counts = useMemo(() => countPools(matching, poolOf), [matching]);
  // Real first, then demo, each by name.
  const groups = useMemo(
    () =>
      (['real', 'demo'] as const)
        .filter((pool) => inPool(pool, poolFilter))
        .map((pool) => ({
          pool,
          users: matching.filter((u) => poolOf(u) === pool).sort((a, b) => (a.name ?? '~').localeCompare(b.name ?? '~')),
        }))
        .filter((g) => g.users.length > 0),
    [matching, poolFilter],
  );
  const shown = groups.reduce((n, g) => n + g.users.length, 0);
  const selected = state.users.find((u) => u.id === selectedId) ?? null;

  return (
    <div className="split">
      <div className="list-wrap">
        <div className="list-search">
          <input className="input" placeholder="Search name, phone, or profile text…" value={q} onChange={(e) => setQ(e.target.value)} />
          <PoolToggle value={poolFilter} onChange={setPoolFilter} counts={counts} />
        </div>
        <ul className="list user-list">
          {shown === 0 && (
            <li className="empty small">
              {state.users.length ? 'No matches' : 'No users yet. Seed demo users or text from a new demo number.'}
            </li>
          )}
          {groups.map((g) => (
            <Fragment key={g.pool}>
              {groups.length > 1 && (
                <li className={`list-group pool-${g.pool}`}>
                  {g.pool === 'real' ? 'Real users' : 'Demo users'} <span className="muted">{g.users.length}</span>
                </li>
              )}
              {g.users.map((u) => (
                <li key={u.id}>
                  <button className={cx('list-item', u.id === selectedId && 'selected')} onClick={() => onSelect(u.id)}>
                    <span className="avatar sm">{initials(u.name)}</span>
                    <div className="li-main">
                      <div className="li-title">{u.name ?? <i className="muted">unnamed</i>}</div>
                      <div className="li-sub mono">{fmtPhone(u.phone)}</div>
                    </div>
                    <div className="li-side row">
                      <UserFlags user={u} />
                      {isSnoozed(u, poolNow(g.pool, state.now)) && <span className="tag tag-warn">snoozed</span>}
                      <PoolBadge pool={g.pool} />
                      {!u.step && <span className={`badge badge-${u.state}`}>{u.state}</span>}
                    </div>
                  </button>
                </li>
              ))}
            </Fragment>
          ))}
        </ul>
      </div>
      {selected ? (
        <UserDetail user={selected} state={state} onOpenPhone={onOpenPhone} onShowEvent={onShowEvent} />
      ) : (
        <div className="empty">Select a user to see their canonical profile</div>
      )}
    </div>
  );
}

function UserDetail({
  user,
  state,
  onOpenPhone,
  onShowEvent,
}: {
  user: ApiUser;
  state: AppState;
  onOpenPhone: (p: string) => void;
  onShowEvent: (id: number) => void;
}) {
  const pool = poolOf(user);
  const now = poolNow(pool, state.now);
  const hosted = state.events.filter((e) => e.hostId === user.id);
  const invites = state.events.flatMap((e) => e.invites.filter((i) => i.userId === user.id).map((i) => ({ ev: e, inv: i })));
  const first = firstName(user.name);
  const intros = first
    ? state.intros.filter((i) => firstName(i.requesterName) === first || firstName(i.targetName) === first)
    : [];
  const snoozed = isSnoozed(user, now);
  const via = joinedViaLabel(user.joinedVia);

  return (
    <div className="detail">
      <div className="detail-head">
        <span className="avatar lg">{initials(user.name)}</span>
        <div className="grow">
          <h3>{user.name ?? 'Unnamed'}</h3>
          <div className="muted mono small">
            {fmtPhone(user.phone)} · id {user.id}
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => onOpenPhone(user.phone)}
          title={pool === 'real' ? 'Act as them in the dashboard. Replies stay here; nothing is sent to their phone.' : undefined}
        >
          {pool === 'real' ? 'Act as' : 'Open phone'}
        </button>
      </div>
      <div className="row wrap gap-sm">
        <PoolBadge pool={pool} />
        <span className={`badge badge-${user.state}`}>{user.state}</span>
        <UserFlags user={user} />
        {snoozed ? (
          <span className="tag tag-warn">snoozed until {fmtWhen(user.snoozedUntil)} ({fmtRel(user.snoozedUntil, now)})</span>
        ) : (
          <span className="tag tag-ok">not snoozed</span>
        )}
      </div>

      {pool === 'real' && (
        <div className="meta-grid">
          <span className="meta-k">joined</span>
          <span>
            {user.joinedAt ? (
              <>
                {fmtWhen(user.joinedAt)} <span className="muted">({fmtRel(user.joinedAt, now)})</span>
              </>
            ) : (
              '—'
            )}
            {via && <span className="muted"> · via {via}</span>}
          </span>
          <span className="meta-k">texts at</span>
          <span className="mono">{user.assignedNumber ? fmtPhone(user.assignedNumber) : '—'}</span>
          <span className="meta-k">onboarding</span>
          <span>{user.step ? `waiting on ${user.step}` : user.state === 'onboarding' ? 'verified · building profile' : 'done'}</span>
          <span className="meta-k">UW email</span>
          <span>{user.emailVerified ? 'verified' : 'not verified'}</span>
          <span className="meta-k">texts</span>
          <span>{user.optedOut ? 'opted out (STOP): nothing is delivered' : 'subscribed'}</span>
        </div>
      )}

      <h4>Canonical profile</h4>
      {user.profile ? <pre className="profile-text">{user.profile}</pre> : <div className="muted small">No profile yet (still onboarding).</div>}
      {((user.blocks?.length ?? 0) > 0 || (user.requirements?.length ?? 0) > 0) && (
        <ul className="req-list">
          {(user.blocks ?? []).map((b) => (
            <li key={`b-${b.name}`} className="req">
              <div className="req-top">
                <span className="tag tag-warn">blocked</span>
                <strong>{b.name}</strong>
                <span className="muted small">matches {b.matches.length} user{b.matches.length === 1 ? '' : 's'}</span>
              </div>
            </li>
          ))}
          {(user.requirements ?? []).map((r) => (
            <li key={`r-${r.id}`} className="req">
              <div className="req-top">
                <span className="tag tag-muted">standing · {r.strength}</span>
                <strong>{r.criterion}</strong>
              </div>
              <div className="req-said">“{r.said}”</div>
            </li>
          ))}
        </ul>
      )}

      {hosted.length > 0 && (
        <>
          <h4>Hosting</h4>
          <ul className="mini-list">
            {hosted.map((e) => (
              <li key={e.id}>
                <button className="link" onClick={() => onShowEvent(e.id)}>
                  {e.title}
                </button>
                <EventChip status={e.status} />
                <span className="muted small">
                  {e.going}/{e.capacity} · {fmtWhen(e.startsAt)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {invites.length > 0 && (
        <>
          <h4>Invites received</h4>
          <ul className="mini-list">
            {invites.map(({ ev, inv }) => (
              <li key={`${ev.id}-${inv.wave}`}>
                <button className="link" onClick={() => onShowEvent(ev.id)}>
                  {ev.title}
                </button>
                <InviteChip status={inv.status} />
                <span className="muted small">{inv.wave === 0 ? 'discover' : `wave ${inv.wave}`}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {intros.length > 0 && (
        <>
          <h4>Intros</h4>
          <ul className="mini-list">
            {intros.map((i) => (
              <li key={i.id}>
                <span>
                  {i.requesterName ?? '?'} → {i.targetName ?? '?'}
                </span>
                <IntroChip status={i.status} />
                <span className="muted small">{i.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
