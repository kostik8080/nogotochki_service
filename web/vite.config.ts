// Черновой фронтенд ходит в API через прокси Vite: для браузера это один адрес,
// поэтому cookie сессии (SameSite=Lax, HttpOnly) работает без CORS.
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Явный IPv4: иначе на Windows Vite слушает только [::1], а браузер идет на 127.0.0.1.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
});
