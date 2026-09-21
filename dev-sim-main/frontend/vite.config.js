import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // Local dev: one process — ``python -m dev_sim_bridge`` on 8765 serves agents, economy, simulate, orchestrate.
      '/api/orchestrate': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/health': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/agents': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/simulate': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/company': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/company/reset': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/economy': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/api/orchestrate': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/health': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/agents': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/simulate': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/company': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/company/reset': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
      '/api/economy': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
      },
    },
  },
});
