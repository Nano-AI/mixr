import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { poolOf, type ApiUser, type Pool } from '../api.ts';
import { MAX_PANES, type Notify } from '../App.tsx';
import { cx, fmtPhone, initials, randomPhone } from '../util.ts';
import { PhonePane } from './PhonePane.tsx';
import { PoolBadge, UserFlags } from './Pool.tsx';

type Props = {
  panes: string[];
  users: ApiUser[];
  usersByPhone: Map<string, ApiUser>;
  now: string | undefined;
  epoch: number;
  flash: { phone: string; n: number } | null;
  onOpen: (phone: string) => void;
  onClose: (phone: string) => void;
  onShowUser: (id: number) => void;
  notify: Notify;
};

const PICKER_LIMIT = 50; // per pool

export function PhonesPanel({ panes, users, usersByPhone, now, epoch, flash, onOpen, onClose, onShowUser, notify }: Props) {
  return (
    <section className="phones-panel">
      <div className="phones-toolbar">
        <UserPicker users={users} openPanes={panes} onPick={onOpen} />
        <button className="btn btn-primary" onClick={() => onOpen(randomPhone())} title="A fresh fake number in the demo pool">
          + New demo number
        </button>
        <span className="muted small phones-count">
          {panes.length}/{MAX_PANES} phones
        </span>
      </div>

      {panes.length === 0 ? (
        <EmptyPhones users={users} onOpen={onOpen} />
      ) : (
        <div className={cx('phones', panes.length === MAX_PANES && 'quad')}>
          {panes.map((phone) => (
            <PhonePane
              key={`${phone}:${epoch}`}
              phone={phone}
              user={usersByPhone.get(phone)}
              now={now}
              flashN={flash?.phone === phone ? flash.n : 0}
              onClose={() => onClose(phone)}
              onShowUser={onShowUser}
              notify={notify}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function EmptyPhones({ users, onOpen }: { users: ApiUser[]; onOpen: (p: string) => void }) {
  const demo = users.filter((u) => u.name && poolOf(u) === 'demo').slice(0, 4);
  const real = users.filter((u) => poolOf(u) === 'real').length;
  return (
    <div className="phones-empty">
      <div className="empty-phone-art" aria-hidden>
        <div className="eb eb-in">hey! i'm new on campus</div>
        <div className="eb eb-out">welcome! what are you into?</div>
        <div className="eb eb-in">tennis, catan, jazz</div>
      </div>
      <h2>Act as any phone</h2>
      <p className="muted">
        Open a new demo number to onboard a pretend student, or step into any user’s phone from the search above. Demo
        users run on the demo clock and nothing is ever delivered. Acting as a real user keeps the conversation here, but
        what you do (RSVPs, events) is real.
      </p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={() => onOpen(randomPhone())}>
          + New demo number
        </button>
        {demo.map((u) => (
          <button key={u.id} className="btn" onClick={() => onOpen(u.phone)}>
            {u.name}
          </button>
        ))}
      </div>
      {real > 0 && (
        <p className="muted small">
          {real} real user{real === 1 ? '' : 's'} in the search, marked <PoolBadge pool="real" />.
        </p>
      )}
      {users.length === 0 && <p className="muted small">Tip: click “Seed demo users” in the top bar to load the seeded students.</p>}
    </div>
  );
}

const byName = (a: ApiUser, b: ApiUser) => (a.name ?? '~').localeCompare(b.name ?? '~') || a.phone.localeCompare(b.phone);

function UserPicker({ users, openPanes, onPick }: { users: ApiUser[]; openPanes: string[]; onPick: (phone: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Real first, then demo; `flat` is the keyboard order across both groups.
  const { groups, flat } = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    const hit = (u: ApiUser) =>
      !s || (u.name ?? '').toLowerCase().includes(s) || (digits.length >= 2 && u.phone.replace(/\D/g, '').includes(digits));
    const pick = (pool: Pool) => users.filter((u) => poolOf(u) === pool && hit(u)).sort(byName);
    const all: { pool: Pool; label: string; users: ApiUser[]; total: number }[] = (['real', 'demo'] as const).map((pool) => {
      const list = pick(pool);
      return { pool, label: pool === 'real' ? 'Real users' : 'Demo users', users: list.slice(0, PICKER_LIMIT), total: list.length };
    });
    const groups = all.filter((g) => g.total > 0);
    return { groups, flat: groups.flatMap((g) => g.users) };
  }, [q, users]);

  useEffect(() => setActive(0), [q]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (u: ApiUser) => {
    onPick(u.phone);
    setQ('');
    setOpen(false);
  };

  let i = -1;
  return (
    <div className="picker" ref={boxRef}>
      <svg className="picker-icon" viewBox="0 0 20 20" aria-hidden>
        <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M14 14l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        className="input picker-input"
        placeholder={users.length ? `Act as… search ${users.length} users` : 'Act as… (no users yet)'}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, flat.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            const u = flat[active];
            if (u) pick(u);
          } else if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {open && (
        <ul className="picker-list" ref={listRef} role="listbox">
          {flat.length === 0 && <li className="picker-empty">No matching users</li>}
          {groups.map((g) => (
            <Fragment key={g.pool}>
              <li className={`picker-group pool-${g.pool}`} role="presentation">
                <span>{g.label}</span>
                <span className="picker-group-count">
                  {g.total > g.users.length ? `${g.users.length} of ${g.total}` : g.total}
                </span>
                {g.pool === 'real' && <span className="picker-group-note">replies stay in the dashboard</span>}
              </li>
              {g.users.map((u) => {
                const idx = ++i;
                return (
                  <li
                    key={u.id}
                    data-i={idx}
                    role="option"
                    aria-selected={idx === active}
                    className={cx('picker-item', idx === active && 'active')}
                    onMouseEnter={() => setActive(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(u);
                    }}
                  >
                    <span className="avatar sm">{initials(u.name)}</span>
                    <span className="picker-name">{u.name ?? <i className="muted">unnamed</i>}</span>
                    <span className="picker-phone">{fmtPhone(u.phone)}</span>
                    <PoolBadge pool={poolOf(u)} />
                    <UserFlags user={u} />
                    {openPanes.includes(u.phone) && <span className="tag tag-accent">open</span>}
                    {u.state === 'onboarding' && !u.step && <span className="tag tag-warn">onboarding</span>}
                  </li>
                );
              })}
            </Fragment>
          ))}
        </ul>
      )}
    </div>
  );
}
