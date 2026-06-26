// Bundle a TS entry to ESM with Vite and run it in Node. Dev-only harness runner
// (used to train the shipped NNUE weights offline). Usage:
//   node tools/run-ts.mjs <entry.ts> [args...]
import { build } from 'vite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.resolve(process.argv[2])
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ts-'))
await build({
  configFile: false,
  root,
  logLevel: 'error',
  build: {
    ssr: true,
    target: 'node20',
    outDir,
    emptyOutDir: false,
    lib: { entry, formats: ['es'], fileName: 'harness' },
    rollupOptions: { external: [] },
  },
})
const emitted = fs.readdirSync(outDir).filter((f) => f.endsWith('.js'))
if (emitted.length !== 1) throw new Error('expected one .js output, got: ' + emitted.join(', '))
const outFile = path.join(outDir, emitted[0])
process.argv = [process.argv[0], outFile, ...process.argv.slice(3)]
await import(pathToFileURL(outFile).href)
