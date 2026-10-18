import { useState } from 'react';
import type { AppState } from '../api.ts';
import type { TraceFeed } from '../useTraces.ts';
import { cx } from '../util.ts';
import { EventsTab } from './EventsTab.tsx';
import { UsersTab } from './UsersTab.tsx';
import { TraceTab } from './TraceTab.tsx';
import { MapTab } from './MapTab.tsx';
import type { PoolFilter } from './Pool.tsx';

export type TabId = 'events' | 'users' | 'trace' | 'map';

type Props = {
  state: AppState | null;
  tab: TabId;
  setTab: (t: TabId) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
  traces: TraceFeed;
  selectedEventId: number | null;
  setSelectedEventId: (id: number | null) => void;
  selectedUserId: number | null;
  setSelectedUserId: (id: number | null) => void;
  onOpenPhone: (phone: string) => void;
  onShowUser: (id: number) => void;
  onShowEvent: (id: number) => void;
};

export function Inspector(p: Props) {
  const { state, tab, setTab, collapsed, setCollapsed } = p;
  // Shared by the Events and Users tabs. Not persisted: every visit starts on All.
  const [poolFilter, setPoolFilter] = useState<PoolFilter>('all');

  if (collapsed) {
    return (
      <aside className="inspector collapsed">
        <button className="icon-btn" onClick={() => setCollapsed(false)} title="Show inspector" aria-label="Show inspector">
          ‹
        </button>
        <div className="collapsed-label">inspector</div>
      </aside>
    );
  }

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'events', label: 'Events', count: state?.events.length },
    { id: 'users', label: 'Users', count: state?.users.length },
    { id: 'trace', label: 'Trace', count: p.traces.traces.length },
    { id: 'map', label: 'Map' },
  ];

  return (
    <aside className="inspector">
      <nav className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={cx('tab', tab === t.id && 'active')}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count != null && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
        <span className="tabs-spacer" />
        <span className="inspector-label" title="Hidden from students">
          inspector
        </span>
        <button className="icon-btn" onClick={() => setCollapsed(true)} title="Collapse inspector" aria-label="Collapse inspector">
          ›
        </button>
      </nav>
      <div className="tab-body">
        {!state ? (
          <div className="empty">Waiting for server…</div>
        ) : tab === 'events' ? (
          <EventsTab
            state={state}
            selectedId={p.selectedEventId}
            onSelect={p.setSelectedEventId}
            onOpenPhone={p.onOpenPhone}
            onShowUser={p.onShowUser}
            poolFilter={poolFilter}
            setPoolFilter={setPoolFilter}
          />
        ) : tab === 'users' ? (
          <UsersTab
            state={state}
            selectedId={p.selectedUserId}
            onSelect={p.setSelectedUserId}
            onOpenPhone={p.onOpenPhone}
            onShowEvent={p.onShowEvent}
            poolFilter={poolFilter}
            setPoolFilter={setPoolFilter}
          />
        ) : tab === 'trace' ? (
          <TraceTab state={state} feed={p.traces} onShowEvent={p.onShowEvent} onShowUser={p.onShowUser} />
        ) : (
          <MapTab
            state={state}
            selectedEventId={p.selectedEventId}
            onSelectEvent={p.setSelectedEventId}
            onShowUser={p.onShowUser}
          />
        )}
      </div>
    </aside>
  );
}
