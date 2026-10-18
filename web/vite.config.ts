import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds are served by the API server at /dashboard/ (src/http/static.ts), on whatever hostname it's
// reached at. The dev server stays at http://localhost:5173/ and proxies the API (including the SSE stream at
// /api/stream) and the admin login (/auth) to the backend, so the session cookie is same-origin in both.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/dashboard/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
}));
