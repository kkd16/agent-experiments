#!/usr/bin/env node
import { readdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMeta, copyShell, writeCatalog } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const SITE = join(ROOT, '_site');
const ARTIFACTS = join(ROOT, process.argv[2] || '_artifacts');
const EXPECTED = JSON.parse(process.env.EXPECTED_MATRIX || '[]').length;

await copyShell(ROOT, SITE);

let entries = [];
try {
  entries = await readdir(ARTIFACTS, { withFileTypes: true });
} catch {
  entries = [];
}

const metas = [];
for (const e of entries) {
  if (!e.isDirectory() || !e.name.startsWith('dist-')) continue;
  const slug = e.name.slice('dist-'.length);
  await cp(join(ARTIFACTS, e.name), join(SITE, 'projects', slug), { recursive: true });
  metas.push(await readMeta(PROJECTS_DIR, slug));
}

if (EXPECTED > 0 && metas.length === 0) {
  console.error(
    `assemble-site: refusing to publish an empty catalog (discover expected ${EXPECTED} project(s), found 0 build artifacts). Aborting to protect the live site.`,
  );
  process.exit(1);
}

await writeCatalog(SITE, metas);
console.log(`assemble-site: ${metas.length} project(s) [${metas.map((m) => m.slug).join(', ')}]`);
