import { useMemo, useState } from 'react';
import type { ApiUser, AppState } from '../api.ts';
import { cx, firstName, fmtPhone, fmtRel, fmtWhen, initials } from '../util.ts';
import { EventChip, IntroChip, InviteChip } from './Chip.tsx';

type Props = {
  state: AppState;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onOpenPhone: (phone: string) => void;
  onShowEvent: (id: number) => void;
};

const isSnoozed = (u: ApiUser, now: string) => !!u.snoozedUntil && new Date(u.snoozedUntil) > new Date(now);

export function UsersTab({ state, selectedId, onSelect, onOpenPhone, onShowEvent }: Props) {
  const [q, setQ] = useState('');
  const users = useMemo(() => {
    const s = q.trim().toLowerCase();
    return state.users
      .filter(
        (u) =>
          !s ||
          (u.name ?? '').toLowerCase().includes(s) ||
          u.phone.includes(s) ||
          (u.profile ?? '').toLowerCase().includes(s),
      )
      .sort((a, b) => (a.name ?? '~').localeCompare(b.name ?? '~'));
  }, [q, state.users]);
  const selected = state.users.find((u) => u.id === selectedId) ?? null;

  return (
    <div className="split">
      <div className="list-wrap">
        <div className="list-search">
          <input className="input" placeholder="Search name, phone, or profile text…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted small">{users.length}</span>
        </div>
        <ul className="list user-list">
          {users.length === 0 && <li className="empty small">{state.users.length ? 'No matches' : 'No users yet. Seed or text from a new number.'}</li>}
          {users.map((u) => (
            <li key={u.id}>
              <button className={cx('list-item', u.id === selectedId && 'selected')} onClick={() => onSelect(u.id)}>
                <span className="avatar sm">{initials(u.name)}</span>
                <div className="li-main">
                  <div className="li-title">{u.name ?? <i className="muted">unnamed</i>}</div>
                  <div className="li-sub mono">{fmtPhone(u.phone)}</div>
                </div>
                <div className="li-side row">
                  {u.seeded && <span className="tag tag-muted">seeded</span>}
                  {isSnoozed(u, state.now) && <span className="tag tag-warn">snoozed</span>}
                  <span className={`badge badge-${u.state}`}>{u.state}</span>
                </div>
              </button>
            </li>
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
  const hosted = state.events.filter((e) => e.hostId === user.id);
  const invites = state.events.flatMap((e) => e.invites.filter((i) => i.userId === user.id).map((i) => ({ ev: e, inv: i })));
  const first = firstName(user.name);
  const intros = first
    ? state.intros.filter((i) => firstName(i.requesterName) === first || firstName(i.targetName) === first)
    : [];
  const snoozed = isSnoozed(user, state.now);

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
        <button className="btn btn-primary" onClick={() => onOpenPhone(user.phone)}>
          Open phone
        </button>
      </div>
      <div className="row wrap gap-sm">
        <span className={`badge badge-${user.state}`}>{user.state}</span>
        {user.seeded ? <span className="tag tag-muted">seeded</span> : <span className="tag tag-accent">live</span>}
        {snoozed ? (
          <span className="tag tag-warn">snoozed until {fmtWhen(user.snoozedUntil)} ({fmtRel(user.snoozedUntil, state.now)})</span>
        ) : (
          <span className="tag tag-ok">not snoozed</span>
        )}
      </div>

      <h4>Canonical profile</h4>
      {user.profile ? <pre className="profile-text">{user.profile}</pre> : <div className="muted small">No profile yet (still onboarding).</div>}

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
