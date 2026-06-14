// Headless differential-test harness. Bundles the compiler with Vite (so the
// extensionless TS resolves exactly as in the app) into a Node-targeted ESM
// module, then runs every example + adversarial program at -O0..-O3 and asserts
// the compiled WebAssembly matches the reference interpreter. Node provides the
// `WebAssembly` global, so this is a true end-to-end check of the real backend.
import { build } from 'vite';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const outDir = resolve(here, '../node_modules/.harness');

// Type-check the app exactly as the CI gate does, so the dev loop catches the
// strict-TS errors the bundler (rolldown) silently tolerates. Pass --no-tsc to
// skip (e.g. for a fast correctness-only re-run).
if (!process.argv.includes('--no-tsc')) {
  try {
    execFileSync('node_modules/.bin/tsc', ['-b'], { cwd: projectRoot, stdio: 'inherit' });
  } catch {
    console.error('tsc failed — fix type errors above');
    process.exit(1);
  }
}

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_entry.js'), formats: ['es'], fileName: 'harness' },
    rollupOptions: { output: { entryFileNames: 'harness.mjs' } },
    minify: false,
    target: 'node20',
  },
});

const mod = await import(pathToFileURL(resolve(outDir, 'harness.mjs')).href);
const results = await mod.run();

let pass = 0;
let fail = 0;
const failures = [];
for (const r of results) {
  if (r.pass) pass++;
  else {
    fail++;
    failures.push(r);
  }
}
const onlyFilter = process.argv[2];
if (onlyFilter) {
  for (const r of results) {
    if (r.name.includes(onlyFilter)) console.log(`${r.pass ? 'ok ' : 'FAIL'} ${r.name} -O${r.level}  ${r.detail}`);
  }
}
console.log(`\n${pass}/${pass + fail} checks pass (${results.length} total) across -O0..-O3`);
if (fail) {
  console.log('\nFAILURES:');
  for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f.name} -O${f.level}: ${f.detail}`);
  process.exit(1);
}
