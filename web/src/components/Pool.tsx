import { poolOf, type ApiEvent, type ApiUser, type Pool } from '../api.ts';
import { cx } from '../util.ts';

// Two pools never meet: demo (seeded + dashboard-created numbers, simulated clock, nothing delivered) and real
// (joined via the website + iMessage, wall-clock time).

export type PoolFilter = 'all' | Pool;

const POOL_TITLE: Record<Pool, string> = {
  real: 'Real user: joined via the website or iMessage. Runs on wall-clock time.',
  demo: 'Demo: seeded or created in the dashboard. Simulated clock; nothing is ever delivered.',
};

export function PoolBadge({ pool, title }: { pool: Pool; title?: string }) {
  return (
    <span className={`pool-badge pool-${pool}`} title={title ?? POOL_TITLE[pool]}>
      {pool}
    </span>
  );
}

/** Onboarding step and opt-out, for real users only. */
export function UserFlags({ user }: { user: ApiUser }) {
  if (poolOf(user) !== 'real') return null;
  return (
    <>
      {user.step && (
        <span className="tag tag-warn" title="Website + iMessage onboarding, before the agent takes over">
          onboarding: {user.step}
        </span>
      )}
      {user.optedOut && (
        <span className="tag tag-danger" title="Texted STOP: nothing is delivered to their phone">
          opted out
        </span>
      )}
    </>
  );
}

const FILTERS: { id: PoolFilter; label: string }[] = [
  { id: 'real', label: 'Real' },
  { id: 'demo', label: 'Demo' },
  { id: 'all', label: 'All' },
];

export function PoolToggle({
  value,
  onChange,
  counts,
}: {
  value: PoolFilter;
  onChange: (v: PoolFilter) => void;
  counts?: Record<PoolFilter, number>;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label="Filter by pool">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={value === f.id}
          className={cx('seg-btn', value === f.id && 'on', f.id !== 'all' && `pool-${f.id}`)}
          onClick={() => onChange(f.id)}
        >
          {f.label}
          {counts && <span className="seg-count">{counts[f.id]}</span>}
        </button>
      ))}
    </div>
  );
}

export const inPool = (pool: Pool, filter: PoolFilter) => filter === 'all' || filter === pool;

export function countPools<T>(items: T[], poolFor: (x: T) => Pool): Record<PoolFilter, number> {
  const real = items.filter((x) => poolFor(x) === 'real').length;
  return { all: items.length, real, demo: items.length - real };
}

/** An event lives in its host's pool. */
export const eventPool = (ev: ApiEvent, usersById: Map<number, ApiUser>): Pool => ev.pool ?? poolOf(usersById.get(ev.hostId));

/** "Now" for a pool: real users run on the wall clock, demo users on the simulated demo clock. */
export const poolNow = (pool: Pool, demoNow: string): string => (pool === 'real' ? new Date().toISOString() : demoNow);

const JOINED_VIA: Record<string, string> = { web: 'website', imessage: 'iMessage', demo: 'dashboard' };
export const joinedViaLabel = (v: string | null | undefined): string | null => (v ? (JOINED_VIA[v] ?? v) : null);
