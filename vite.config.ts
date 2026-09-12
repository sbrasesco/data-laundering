import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig(({ mode }) => {
  // Vite NO carga .env en process.env para este archivo. loadEnv sí.
  // Sin esto, `npm run build` tomaba siempre la rama sin token: los
  // mapas quedaban publicados y Sentry no los recibía. Era la causa
  // real, no un olvido.
  const env   = loadEnv(mode, process.cwd(), '');
  const token = process.env.SENTRY_AUTH_TOKEN || env.SENTRY_AUTH_TOKEN;

  if (mode === 'production' && !token) {
    console.warn(
      '\n⚠  SENTRY_AUTH_TOKEN ausente: no se generan mapas de código.\n' +
      '   El sitio queda seguro, pero los errores en Sentry van a ser\n' +
      '   ilegibles. Definila en .env si querés rastros legibles.\n'
    );
  }

  return {
    plugins: [
      react(),
      ...(token
        ? [
            sentryVitePlugin({
              org: 'aignition',
              project: 'javascript-react',
              authToken: token,
              sourcemaps: {
                // Saca los .map de dist/ una vez subidos a Sentry.
                filesToDeleteAfterUpload: ['./dist/**/*.map'],
              },
              telemetry: false,
            }),
          ]
        : []),
    ],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    build: {
      // 'hidden' genera los mapas para Sentry pero NO deja el comentario
      // //# sourceMappingURL en el JS, así que no quedan anunciados.
      // Sin token no se generan: no habría quien los suba ni quien los
      // borre, y terminarían publicados como hasta ahora.
      sourcemap: token ? 'hidden' : false,
      rollupOptions: {
        input: { main: './index.html' },
      },
    },
  };
});
