import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

const nodeShim = fileURLToPath(new URL('./src/shims/node.ts', import.meta.url))

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Shared domain model and the real adapter path tables, owned by the CLI
      // workstream. Imported, never edited.
      '@core': fileURLToPath(new URL('../src/core', import.meta.url)),
      '@adapters': fileURLToPath(new URL('../src/adapters', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),

      // The adapters import these for read()/apply(), which the browser never
      // calls — `locations()` is declared pure. See src/shims/node.ts: every
      // export throws, deliberately, so a stray call is loud rather than wrong.
      'node:fs/promises': nodeShim,
      'node:fs': nodeShim,
      'node:path': nodeShim,
      'node:crypto': nodeShim,
      'node:os': nodeShim,
      'node:util': nodeShim,
      'node:child_process': nodeShim,
    },
  },
  server: {
    // ../src lives outside the Vite root.
    fs: { allow: ['..'] },
  },
})
