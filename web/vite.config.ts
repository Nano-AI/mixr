import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the API (including the SSE stream at /api/stream) to the mixr backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
