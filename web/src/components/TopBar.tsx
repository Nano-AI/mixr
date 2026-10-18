import { useEffect, useState } from 'react';
import { api, logout, useStreamStatus, type AppState, type AuthStatus } from '../api.ts';
import type { Notify } from '../App.tsx';
import { cx, fmtClock, fmtDate, fmtNum } from '../util.ts';

const STEPS: { label: string; minutes: number }[] = [
  { label: '+15m', minutes: 15 },
  { label: '+1h', minutes: 60 },
  { label: '+6h', minutes: 360 },
  { label: '+1d', minutes: 1440 },
];

const WALL_TICK_MS = 15_000;

type Props = {
  state: AppState | null;
  offline: boolean;
  auth: AuthStatus;
  notify: Notify;
  onReset: () => void;
  onChanged: () => void;
};

/** Real time, for context next to the demo clock (real users run on it). */
function useWallClock(): string {
  const [t, setT] = useState(() => new Date().toISOString());
  useEffect(() => {
    const id = setInterval(() => setT(new Date().toISOString()), WALL_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return t;
}

export function TopBar({ state, offline, auth, notify, onReset, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const stream = useStreamStatus();
  const wall = useWallClock();

  async function run(key: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  }

  const advance = (minutes: number, label: string) =>
    run(label, async () => {
      const r = await api.advance(minutes);
      notify(`Demo clock → ${fmtClock(r.now)}${r.jobsRan ? ` · ${r.jobsRan} job${r.jobsRan === 1 ? '' : 's'} ran` : ''}`, 'ok');
      onChanged();
    });

  const seed = () =>
    run('seed', async () => {
      await api.seed();
      notify('Demo users loaded', 'ok');
      onChanged();
    });

  const reset = () => {
    if (
      !window.confirm(
        'Reset the demo? This wipes demo users, their messages, events and traces, and resets the demo clock to now ' +
          '(the embedding cache is kept).\n\nReal users and everything of theirs are untouched.',
      )
    )
      return;
    void run('reset', async () => {
      await api.reset();
      notify('Demo reset · real users untouched', 'ok');
      onReset();
    });
  };

  const usage = state?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const purposes = usage ? Object.entries(usage.byPurpose).sort((a, b) => b[1] - a[1]) : [];

  return (
    <header className="topbar">
      <div className="title">
        <span className={cx('stream-dot', `stream-${offline ? 'down' : stream}`)} title={offline ? 'Server unreachable' : `Live stream: ${stream}`} />
        mixr · dashboard
      </div>

      <div className="clock-group" role="group" aria-label="Demo clock">
        <div className="clock" title="Demo clock: simulated time for the demo pool (America/Los_Angeles). Fast-forward moves only this clock.">
          <span className="clock-label">demo clock</span>
          <span className="clock-time">{state ? fmtClock(state.now) : '—'}</span>
          <span className="clock-date">{state ? fmtDate(state.now) : ''}</span>
        </div>
        <div className="btn-group" role="group" aria-label="Fast-forward the demo clock">
          {STEPS.map((s) => (
            <button
              key={s.label}
              className="btn"
              disabled={!!busy || offline}
              title={`Fast-forward the demo clock ${s.label.slice(1)} (real users are unaffected)`}
              onClick={() => void advance(s.minutes, s.label)}
            >
              {busy === s.label ? <span className="spinner" /> : s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wall-clock" title="Real time (America/Los_Angeles). Real users run on this clock.">
        <span className="clock-label">real time</span>
        <span className="wall-time">{fmtClock(wall)}</span>
      </div>

      <div className="topbar-spacer" />

      {offline && <span className="offline-pill">server offline · retrying</span>}

      <div className="usage" tabIndex={0}>
        <span className="usage-dot" />
        <span>
          <b>{usage ? usage.llmCalls : '—'}</b> LLM calls
        </span>
        <span className="usage-sep" />
        <span>{usage ? fmtNum(tokens) : '—'} tok</span>
        <div className="usage-pop" role="tooltip">
          <div className="pop-title">LLM usage by purpose</div>
          {purposes.length ? (
            <table>
              <tbody>
                {purposes.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="num">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="muted small">No LLM calls yet.</div>
          )}
          {usage && (
            <div className="pop-foot">
              <div>
                input <b>{fmtNum(usage.inputTokens)}</b> · output <b>{fmtNum(usage.outputTokens)}</b>
              </div>
              <div>
                embeddings <b>{fmtNum(usage.embedTokens)}</b> tok
              </div>
            </div>
          )}
        </div>
      </div>

      <button className="btn" disabled={!!busy || offline} onClick={() => void seed()} title="Load the seeded demo students">
        {busy === 'seed' ? <span className="spinner" /> : 'Seed demo users'}
      </button>
      <button className="btn btn-danger" disabled={!!busy || offline} onClick={reset} title="Wipe the demo pool. Real users are untouched.">
        {busy === 'reset' ? <span className="spinner" /> : 'Reset demo'}
      </button>
      {auth === 'open' ? (
        <span className="tag tag-warn" title="The server has no ADMIN_TOKEN, so the dashboard needs no login (local dev only)">
          no login (dev)
        </span>
      ) : (
        <button className="btn" onClick={() => void logout()} title="Sign out of the dashboard">
          Log out
        </button>
      )}
    </header>
  );
}
