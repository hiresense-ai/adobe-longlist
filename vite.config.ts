import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          if (
            /[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)
          ) {
            return 'vendor-react'
          }
          if (id.includes('@supabase')) return 'vendor-supabase'
          if (
            id.includes('radix-ui') ||
            id.includes('lucide-react') ||
            id.includes('class-variance-authority')
          ) {
            return 'vendor-ui'
          }
          if (
            id.includes('react-hook-form') ||
            id.includes('@hookform') ||
            id.includes(`${path.sep}zod${path.sep}`)
          ) {
            return 'vendor-forms'
          }
          if (id.includes('@tanstack')) return 'vendor-query'
        },
      },
    },
  },
})
