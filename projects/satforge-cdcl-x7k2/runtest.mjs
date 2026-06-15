import { build } from 'vite'
import { rm } from 'node:fs/promises'

await build({
  logLevel: 'error',
  build: {
    lib: { entry: 'selftest.ts', formats: ['es'], fileName: () => 'selftest.mjs' },
    outDir: '.testout',
    emptyOutDir: true,
    minify: false,
    target: 'node20',
  },
})
await import('./.testout/selftest.mjs')
await rm('.testout', { recursive: true, force: true })
