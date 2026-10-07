import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Connect, type Plugin } from 'vite'

/**
 * Lyca Mobile workspace pages (/lyca, /lyca/...) are served lyca.html — the
 * same app bundle as index.html with Lyca's own pre-JavaScript title, icon
 * and description (vercel.json does the same rewrite in production).
 * Adobe's URLs keep getting index.html, unchanged. Only page navigations are
 * rewritten (HTML GET/HEAD without a file extension); assets are untouched.
 */
const LYCA_PAGE = /^\/lyca(?:\/|$)/i
const rewriteLycaPages: Connect.NextHandleFunction = (req, _res, next) => {
  const url = req.url ?? ''
  const queryAt = url.indexOf('?')
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt)
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    LYCA_PAGE.test(pathname) &&
    !/\.[a-z0-9]+$/i.test(pathname) &&
    (req.headers.accept ?? '').includes('text/html')
  ) {
    req.url = '/lyca.html' + (queryAt === -1 ? '' : url.slice(queryAt))
  }
  next()
}

function lycaWorkspaceEntry(): Plugin {
  return {
    name: 'lyca-workspace-entry',
    configureServer(server) {
      server.middlewares.use(rewriteLycaPages)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewriteLycaPages)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), lycaWorkspaceEntry()],
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
      // Two HTML entries, one bundle: Adobe (index.html) and Lyca Mobile
      // (lyca.html) — see lycaWorkspaceEntry() above.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        lyca: path.resolve(__dirname, 'lyca.html'),
      },
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
