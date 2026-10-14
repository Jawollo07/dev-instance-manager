import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const apiTarget = process.env.DIM_API_PROXY_TARGET || 'http://127.0.0.1:6570'

export default defineConfig({
  // Mirror production NGINX routing while running the frontend with Vite.
  // API requests and workspace URLs must reach Fastify, not Vite's HTML fallback.
  server: {
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false
      },
      // Proxy /<slug> and /<slug>/*, but reserve frontend/API paths.
      // A leading ^ makes Vite interpret this proxy key as a regular expression.
      '^/(?!admin(?:/|$)|api(?:/|$)|assets(?:/|$))[a-z0-9][a-z0-9-]{0,31}(?:/.*)?$': {
        target: apiTarget,
        changeOrigin: false,
        ws: true
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html')
      }
    }
  }
})
