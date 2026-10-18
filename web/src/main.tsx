import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { Login } from './components/Login.tsx';
import { checkAuth, useAuth } from './api.ts';
import './styles.css';

// Login gate: the dashboard mounts only once signed in (or when the server runs without a token in local dev).
// Any 401 later (expired session, rotated token) flips back to the login; signing in remounts and reloads state.
function Root() {
  const auth = useAuth();
  useEffect(() => {
    void checkAuth();
  }, []);
  if (auth === 'checking') return <div className="boot muted">Loading…</div>;
  if (auth === 'signed-out' || auth === 'misconfigured') return <Login misconfigured={auth === 'misconfigured'} />;
  return <App auth={auth} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
