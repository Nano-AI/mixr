import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApiUser } from '../api.ts';
import { MAX_PANES, type Notify } from '../App.tsx';
import { cx, fmtPhone, initials, randomPhone } from '../util.ts';
import { PhonePane } from './PhonePane.tsx';

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

export function PhonesPanel({ panes, users, usersByPhone, now, epoch, flash, onOpen, onClose, onShowUser, notify }: Props) {
  return (
    <section className="phones-panel">
      <div className="phones-toolbar">
        <UserPicker users={users} openPanes={panes} onPick={onOpen} />
        <button className="btn btn-primary" onClick={() => onOpen(randomPhone())}>
          + New number
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
  const sample = users.filter((u) => u.name).slice(0, 4);
  return (
    <div className="phones-empty">
      <div className="empty-phone-art" aria-hidden>
        <div className="eb eb-in">hey! i'm new on campus</div>
        <div className="eb eb-out">welcome! what are you into?</div>
        <div className="eb eb-in">tennis, catan, jazz</div>
      </div>
      <h2>Text mixr from any phone</h2>
      <p className="muted">
        Open a fresh number to onboard a new student, or step into a seeded student's phone to see the invites they receive.
      </p>
      <div className="empty-actions">
        <button className="btn btn-primary" onClick={() => onOpen(randomPhone())}>
          + New number
        </button>
        {sample.map((u) => (
          <button key={u.id} className="btn" onClick={() => onOpen(u.phone)}>
            {u.name}
          </button>
        ))}
      </div>
      {users.length === 0 && <p className="muted small">Tip: click “Seed users” in the top bar to load ~45 students.</p>}
    </div>
  );
}

function UserPicker({ users, openPanes, onPick }: { users: ApiUser[]; openPanes: string[]; onPick: (phone: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    const digits = s.replace(/\D/g, '');
    const list = users.filter(
      (u) => !s || (u.name ?? '').toLowerCase().includes(s) || (digits.length >= 2 && u.phone.replace(/\D/g, '').includes(digits)),
    );
    return list.sort((a, b) => (a.name ?? '~').localeCompare(b.name ?? '~')).slice(0, 50);
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

  return (
    <div className="picker" ref={boxRef}>
      <svg className="picker-icon" viewBox="0 0 20 20" aria-hidden>
        <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M14 14l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        className="input picker-input"
        placeholder={users.length ? `Open phone… search ${users.length} users` : 'Open phone… (no users yet)'}
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
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            const u = matches[active];
            if (u) pick(u);
          } else if (e.key === 'Escape') {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {open && (
        <ul className="picker-list" ref={listRef} role="listbox">
          {matches.length === 0 && <li className="picker-empty">No matching users</li>}
          {matches.map((u, i) => (
            <li
              key={u.id}
              data-i={i}
              role="option"
              aria-selected={i === active}
              className={cx('picker-item', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u);
              }}
            >
              <span className="avatar sm">{initials(u.name)}</span>
              <span className="picker-name">{u.name ?? <i className="muted">unnamed</i>}</span>
              <span className="picker-phone">{fmtPhone(u.phone)}</span>
              {openPanes.includes(u.phone) && <span className="tag tag-accent">open</span>}
              {u.state === 'onboarding' && <span className="tag tag-warn">onboarding</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
