// runtest.mjs — bundle the (DOM-free) self-test through Vite and run it under
// Node, so the numerical verification suite can be checked headlessly.
import { build } from 'vite';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const result = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    lib: { entry: 'src/sim/selftest.ts', formats: ['es'], fileName: 'selftest' },
  },
});
const out = Array.isArray(result) ? result[0] : result;
const code = out.output.find((o) => o.type === 'chunk' && o.isEntry).code;
const dir = mkdtempSync(join(tmpdir(), 'eddy-'));
const file = join(dir, 'selftest.mjs');
writeFileSync(file, code);
const mod = await import(pathToFileURL(file).href);
const report = mod.runSelfTest();
let failed = 0;
for (const g of report.groups) {
  for (const c of g.checks) {
    if (!c.pass) {
      failed++;
      console.log(`  ✗ [${g.title}] ${c.name}: ${c.measured}`);
    }
  }
}
console.log(`\n${report.passed}/${report.total} checks passed in ${report.ms.toFixed(0)}ms (${report.groups.length} groups)`);
process.exit(failed === 0 ? 0 : 1);
