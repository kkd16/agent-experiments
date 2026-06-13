#!/usr/bin/env node
import { readdir, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, readMeta } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const SITE = join(ROOT, '_site');
const ARTIFACTS = join(ROOT, process.argv[2] || '_artifacts');
const SHELL = ['index.html', 'assets', '.nojekyll'];

await rm(SITE, { recursive: true, force: true });
await mkdir(join(SITE, 'projects'), { recursive: true });
for (const item of SHELL) {
  const src = join(ROOT, item);
  if (await exists(src)) await cp(src, join(SITE, item), { recursive: true });
}

let entries = [];
try {
  entries = await readdir(ARTIFACTS, { withFileTypes: true });
} catch {
  entries = [];
}

const built = [];
for (const e of entries) {
  if (!e.isDirectory() || !e.name.startsWith('dist-')) continue;
  const slug = e.name.slice('dist-'.length);
  await cp(join(ARTIFACTS, e.name), join(SITE, 'projects', slug), { recursive: true });
  built.push(await readMeta(PROJECTS_DIR, slug));
}

built.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.slug.localeCompare(b.slug));
const catalog = { generatedAt: new Date().toISOString(), count: built.length, projects: built };
await writeFile(join(SITE, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
console.log(`assemble-site: ${built.length} project(s) [${built.map((b) => b.slug).join(', ')}]`);
