import { useState } from 'react';
import { api, useStreamStatus, type AppState } from '../api.ts';
import type { Notify } from '../App.tsx';
import { cx, fmtClock, fmtDate, fmtNum } from '../util.ts';

const STEPS: { label: string; minutes: number }[] = [
  { label: '+15m', minutes: 15 },
  { label: '+1h', minutes: 60 },
  { label: '+6h', minutes: 360 },
  { label: '+1d', minutes: 1440 },
];

type Props = {
  state: AppState | null;
  offline: boolean;
  notify: Notify;
  onReset: () => void;
  onChanged: () => void;
};

export function TopBar({ state, offline, notify, onReset, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const stream = useStreamStatus();

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
      notify(`Clock → ${fmtClock(r.now)}${r.jobsRan ? ` · ${r.jobsRan} job${r.jobsRan === 1 ? '' : 's'} ran` : ''}`, 'ok');
      onChanged();
    });

  const seed = () =>
    run('seed', async () => {
      await api.seed();
      notify('Seeded users loaded', 'ok');
      onChanged();
    });

  const reset = () => {
    if (!window.confirm('Reset the simulation? This wipes all users, messages, events and traces (embedding cache is kept).')) return;
    void run('reset', async () => {
      await api.reset();
      notify('Simulation reset', 'ok');
      onReset();
    });
  };

  const usage = state?.usage;
  const tokens = usage ? usage.inputTokens + usage.outputTokens : 0;
  const purposes = usage ? Object.entries(usage.byPurpose).sort((a, b) => b[1] - a[1]) : [];

  return (
    <header className="topbar">
      <div className="title">mixr · simulator</div>

      <div className="clock" title="Simulated time (America/Los_Angeles)">
        <span className={cx('stream-dot', `stream-${offline ? 'down' : stream}`)} title={offline ? 'Server unreachable' : `Live stream: ${stream}`} />
        <span className="clock-time">{state ? fmtClock(state.now) : '—'}</span>
        <span className="clock-date">{state ? fmtDate(state.now) : ''}</span>
      </div>

      <div className="btn-group" role="group" aria-label="Advance simulated clock">
        {STEPS.map((s) => (
          <button key={s.label} className="btn" disabled={!!busy || offline} onClick={() => void advance(s.minutes, s.label)}>
            {busy === s.label ? <span className="spinner" /> : s.label}
          </button>
        ))}
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

      <button className="btn" disabled={!!busy || offline} onClick={() => void seed()}>
        {busy === 'seed' ? <span className="spinner" /> : 'Seed users'}
      </button>
      <button className="btn btn-danger" disabled={!!busy || offline} onClick={reset}>
        {busy === 'reset' ? <span className="spinner" /> : 'Reset'}
      </button>
    </header>
  );
}
