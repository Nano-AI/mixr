import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { api, useBus, useDebounced, type AppState } from './api.ts';
import { TopBar } from './components/TopBar.tsx';
import { PhonesPanel } from './components/PhonesPanel.tsx';
import { Inspector, type TabId } from './components/Inspector.tsx';
import { useTraces } from './useTraces.ts';
import { cx, loadLocal, saveLocal } from './util.ts';

export const MAX_PANES = 4;

export type Toast = { id: number; text: string; tone: 'info' | 'error' | 'ok' };
export type Notify = (text: string, tone?: Toast['tone']) => void;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [offline, setOffline] = useState(false);
  const [epoch, setEpoch] = useState(0); // bumped on reset so panes/traces reload

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);
  const refreshSoon = useDebounced(() => void refresh(), 250);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep retrying while the server is down (e.g. backend not started yet).
  useEffect(() => {
    if (!offline) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [offline, refresh]);

  useBus((e) => {
    if (e.type === 'state') refreshSoon();
    else if (e.type === 'clock') {
      setState((s) => (s ? { ...s, now: e.now } : s));
      refreshSoon();
    }
  });

  // ---- toasts ----
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);
  const notify = useCallback<Notify>((text, tone = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);

  // ---- phone panes ----
  const [panes, setPanes] = useState<string[]>(() => loadLocal<string[]>('mixr.panes', []).slice(0, MAX_PANES));
  const [flash, setFlash] = useState<{ phone: string; n: number } | null>(null);
  useEffect(() => saveLocal('mixr.panes', panes), [panes]);

  const openPhone = useCallback((phone: string) => {
    setPanes((p) => (p.includes(phone) ? p : [...p, phone].slice(-MAX_PANES)));
    setFlash((f) => ({ phone, n: (f?.n ?? 0) + 1 }));
  }, []);
  const closePhone = useCallback((phone: string) => setPanes((p) => p.filter((x) => x !== phone)), []);

  // ---- inspector ----
  const [tab, setTab] = useState<TabId>(() => loadLocal<TabId>('mixr.tab', 'events'));
  useEffect(() => saveLocal('mixr.tab', tab), [tab]);
  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [inspectorPct, setInspectorPct] = useState<number>(() => loadLocal('mixr.inspectorPct', 40));
  const [collapsed, setCollapsed] = useState<boolean>(() => loadLocal('mixr.collapsed', false));
  useEffect(() => saveLocal('mixr.inspectorPct', inspectorPct), [inspectorPct]);
  useEffect(() => saveLocal('mixr.collapsed', collapsed), [collapsed]);

  // Default-select the most relevant event once events exist.
  useEffect(() => {
    if (!state) return;
    if (selectedEventId != null && state.events.some((e) => e.id === selectedEventId)) return;
    const open = state.events.find((e) => e.status === 'open' || e.status === 'full') ?? state.events[state.events.length - 1];
    setSelectedEventId(open ? open.id : null);
  }, [state, selectedEventId]);

  const mainRef = useRef<HTMLDivElement>(null);
  const startResize = (ev: ReactPointerEvent) => {
    ev.preventDefault();
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const move = (e: PointerEvent) => {
      const pct = ((rect.right - e.clientX) / rect.width) * 100;
      setInspectorPct(Math.min(70, Math.max(24, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const traces = useTraces(epoch);

  const afterReset = useCallback(() => {
    setEpoch((e) => e + 1);
    setSelectedEventId(null);
    setSelectedUserId(null);
    void refresh();
  }, [refresh]);

  const usersByPhone = useMemo(() => new Map((state?.users ?? []).map((u) => [u.phone, u])), [state]);

  const showUser = useCallback((id: number) => {
    setSelectedUserId(id);
    setTab('users');
    setCollapsed(false);
  }, []);
  const showEvent = useCallback((id: number) => {
    setSelectedEventId(id);
    setTab('events');
    setCollapsed(false);
  }, []);

  return (
    <div className="app">
      <TopBar state={state} offline={offline} notify={notify} onReset={afterReset} onChanged={refreshSoon} />
      <div
        className={cx('main', collapsed && 'collapsed')}
        ref={mainRef}
        style={{ '--inspector-w': `${inspectorPct}%` } as CSSProperties}
      >
        <PhonesPanel
          panes={panes}
          users={state?.users ?? []}
          usersByPhone={usersByPhone}
          now={state?.now}
          epoch={epoch}
          flash={flash}
          onOpen={openPhone}
          onClose={closePhone}
          onShowUser={showUser}
          notify={notify}
        />
        {!collapsed && <div className="resizer" onPointerDown={startResize} title="Drag to resize" />}
        <Inspector
          state={state}
          tab={tab}
          setTab={setTab}
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          traces={traces}
          selectedEventId={selectedEventId}
          setSelectedEventId={setSelectedEventId}
          selectedUserId={selectedUserId}
          setSelectedUserId={setSelectedUserId}
          onOpenPhone={openPhone}
          onShowUser={showUser}
          onShowEvent={showEvent}
        />
      </div>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
