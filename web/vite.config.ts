import process from 'node:process';
import { defineConfig } from 'vite';
import presetPreact from '@preact/preset-vite';

const apiTarget = process.env.LOO_API_URL || 'http://127.0.0.1:18085';

export default defineConfig({
  plugins: [presetPreact()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/install.sh': { target: apiTarget, changeOrigin: true },
      '/install.ps1': { target: apiTarget, changeOrigin: true },
      '/downloads': { target: apiTarget, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
