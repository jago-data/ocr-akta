import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Convention (from osg-prod): API routes live at root on the backend;
// /api is a prefix the dev proxy (and nginx in prod) strips.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5178,
    host: true, // bind all interfaces — Windows browser can use the WSL IP if localhost forwarding breaks
    watch: {
      usePolling: true, // needed on WSL2 when the project lives on /mnt/c
    },
    proxy: {
      '/api': {
        target: 'http://localhost:8300',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    port: 5179,
    proxy: {
      '/api': {
        target: 'http://localhost:8300',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
