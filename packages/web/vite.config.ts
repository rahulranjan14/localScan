import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Loopback only. This is a local tool and the dev server should not be
    // reachable from the network just because it is convenient.
    host: '127.0.0.1',
    proxy: {
      // Keeps the browser on one origin, so no CORS configuration exists to be
      // loosened later. The predecessor system ended up with allow_origins ["*"].
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
