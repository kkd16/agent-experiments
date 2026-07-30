#!/usr/bin/env node
// Local preview only — CI uses discover-projects.mjs + assemble-site.mjs.
//   node scripts/build-site.mjs [--catalog-only]
import { cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readMeta, validate, listProjectSlugs, reportViolations, copyShell, writeCatalog } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const SITE = join(ROOT, '_site');
const CATALOG_ONLY = process.argv.includes('--catalog-only');

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false }).status === 0;
}

async function main() {
  await copyShell(ROOT, SITE);
  const metas = [];
  const rejected = [];
  for (const slug of await listProjectSlugs(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, slug);
    const violations = await validate(PROJECTS_DIR, slug);
    if (violations.length) {
      reportViolations(slug, violations);
      rejected.push(slug);
      continue;
    }
    if (CATALOG_ONLY) {
      metas.push(await readMeta(PROJECTS_DIR, slug));
      continue;
    }
    const ok =
      run('pnpm', ['install', '--frozen-lockfile'], dir) &&
      run('pnpm', ['run', 'lint'], dir) &&
      run('pnpm', ['run', 'build'], dir) &&
      run(process.execPath, [join(ROOT, 'scripts', 'verify-build-output.mjs'), dir], dir);
    if (!ok) {
      reportViolations(slug, ['install, lint, build, or build-output validation failed']);
      rejected.push(slug);
      continue;
    }
    await cp(join(dir, 'dist'), join(SITE, 'projects', slug), { recursive: true });
    metas.push(await readMeta(PROJECTS_DIR, slug));
  }
  await writeCatalog(SITE, metas);
  console.log(`build-site: published [${metas.map((m) => m.slug).join(', ')}] rejected [${rejected.join(', ')}]`);
}

main().catch((err) => {
  console.error('build-site failed:', err);
  process.exit(1);
});
