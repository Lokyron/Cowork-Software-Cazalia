import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En dev, l'API tourne sur :3001 ; on proxifie /api pour partager le cookie.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
