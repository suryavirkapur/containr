import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

const apiProxyTarget = process.env.CONTAINR_API_PROXY_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [tailwindcss(), solidPlugin()],
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
  },
});
