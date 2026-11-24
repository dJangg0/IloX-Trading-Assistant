import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the PWA is served on :5173 and proxies /api to the Node server, so the browser sees one origin.
// For an HTTPS tunnel, point the tunnel at :5173 (dev) or at the server port (prod build, served by Fastify).
const apiTarget = process.env.API_TARGET ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
});
