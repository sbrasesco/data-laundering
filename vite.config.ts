import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Excluir scripts Node del build de Vite
  build: {
    rollupOptions: {
      input: {
        main: './index.html',
      },
    },
  },
});

