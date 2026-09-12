import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

const tieneToken = Boolean(process.env.SENTRY_AUTH_TOKEN);

const sentryPlugins = tieneToken
  ? [
      sentryVitePlugin({
        org: 'aignition',
        project: 'javascript-react',
        authToken: process.env.SENTRY_AUTH_TOKEN,
        sourcemaps: {
          // Saca los .map de dist/ una vez subidos a Sentry.
          filesToDeleteAfterUpload: ['./dist/**/*.map'],
        },
        telemetry: false,
      }),
    ]
  : [];

export default defineConfig({
  plugins: [react(), ...sentryPlugins],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // 'hidden' genera los mapas para Sentry pero NO deja el comentario
    // //# sourceMappingURL en el JS, así que no quedan anunciados.
    // Sin token no se generan: no habría quien los suba ni quien los
    // borre, y terminarían publicados como hasta ahora.
    sourcemap: tieneToken ? 'hidden' : false,
    rollupOptions: {
      input: { main: './index.html' },
    },
  },
});
