#!/usr/bin/env node
// LOCAL all-in-one preview: validate + build (pnpm) + assemble _site + write catalog, in one
// process. CI uses the matrix pipeline instead (discover-projects.mjs + assemble-site.mjs);
// this is just for previewing the whole site on your machine.
//
//   node scripts/build-site.mjs                full build + assemble
//   node scripts/build-site.mjs --catalog-only validate + catalog only (no builds)
import { mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exists, readMeta, validate, listProjectSlugs } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const SITE = join(ROOT, '_site');
const SHELL = ['index.html', 'assets', '.nojekyll'];
const CATALOG_ONLY = process.argv.includes('--catalog-only');

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false }).status === 0;
}

async function main() {
  await rm(SITE, { recursive: true, force: true });
  await mkdir(join(SITE, 'projects'), { recursive: true });
  for (const item of SHELL) {
    const src = join(ROOT, item);
    if (await exists(src)) await cp(src, join(SITE, item), { recursive: true });
  }

  const published = [];
  const rejected = [];
  for (const slug of await listProjectSlugs(PROJECTS_DIR)) {
    const dir = join(PROJECTS_DIR, slug);

    const violations = await validate(PROJECTS_DIR, slug);
    if (violations.length) {
      violations.forEach((v) => console.log(`::error title=Rejected ${slug}::${slug}: ${v}`));
      rejected.push(slug);
      continue;
    }

    if (CATALOG_ONLY) {
      published.push(await readMeta(PROJECTS_DIR, slug));
      continue;
    }

    const ok = run('pnpm', ['install', '--frozen-lockfile'], dir) && run('pnpm', ['run', 'build'], dir);
    if (!ok || !(await exists(join(dir, 'dist', 'index.html')))) {
      console.log(`::error title=Rejected ${slug}::${slug}: build failed (or produced no dist/index.html)`);
      rejected.push(slug);
      continue;
    }
    await cp(join(dir, 'dist'), join(SITE, 'projects', slug), { recursive: true });
    published.push(await readMeta(PROJECTS_DIR, slug));
  }

  published.sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.slug.localeCompare(b.slug),
  );
  const catalog = { generatedAt: new Date().toISOString(), count: published.length, projects: published };
  await writeFile(join(SITE, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  console.log(
    `build-site: published [${published.map((p) => p.slug).join(', ')}] rejected [${rejected.join(', ')}]`,
  );
}

main().catch((err) => {
  console.error('build-site failed:', err);
  process.exit(1);
});
