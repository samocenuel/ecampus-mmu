import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 127.0.0.1 rather than localhost: Node may resolve localhost to IPv6 (::1).
const backend = process.env.VITE_DEV_API || 'http://127.0.0.1:4000';
const proxy = { '/api': backend, '/uploads': backend };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true, proxy },
  preview: { port: 4173, host: true, proxy },
});
