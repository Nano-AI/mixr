import { useState, type FormEvent } from 'react';
import { checkAuth, login } from '../api.ts';

/** Admin sign-in. On success the auth store flips and the dashboard loads. */
export function Login({ misconfigured }: { misconfigured: boolean }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await login(token.trim());
    setBusy(false);
    if (!r.ok) setError(r.error);
  }

  async function recheck() {
    setBusy(true);
    await checkAuth();
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <h1>Dashboard sign-in</h1>
        <p className="muted small">Admin access to the simulator: demo users, real users, events and traces.</p>

        {misconfigured ? (
          <>
            <div className="error-box" role="alert">
              This server has no ADMIN_TOKEN set, so the dashboard is locked. Set ADMIN_TOKEN in the server’s environment
              and restart it.
            </div>
            <button type="button" className="btn" disabled={busy} onClick={() => void recheck()}>
              {busy ? <span className="spinner" /> : 'Check again'}
            </button>
          </>
        ) : (
          <>
            <label className="login-label" htmlFor="admin-token">
              Admin token
            </label>
            <input
              id="admin-token"
              className="input"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={token}
              aria-invalid={!!error}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(e) => {
                setToken(e.target.value);
                setError(null);
              }}
            />
            {error && (
              <div id="login-error" className="login-error" role="alert">
                {error}
              </div>
            )}
            <button type="submit" className="btn btn-primary" disabled={busy || !token.trim()}>
              {busy ? <span className="spinner" /> : 'Sign in'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
