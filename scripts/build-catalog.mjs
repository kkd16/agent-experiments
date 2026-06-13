#!/usr/bin/env node
// Scans projects/ and writes catalog.json at the repo root.
//
// This file is the ONLY thing that knows how to assemble the catalog. It runs in CI
// (see .github/workflows/deploy.yml) on every push to main, so catalog.json is a
// generated, gitignored artifact — no agent ever edits a shared list, which is what
// keeps parallel pushes conflict-free.
//
// Zero dependencies. Run locally with:  node scripts/build-catalog.mjs
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const OUTPUT = join(ROOT, 'catalog.json');

// Turn "weather-widget-7f3a" into "Weather Widget" for a display fallback.
function humanize(slug) {
  const cleaned = slug
    .replace(/-[0-9a-z]{4,8}$/i, '') // drop a trailing random suffix for display
    .replace(/[-_]+/g, ' ')
    .trim();
  const base = cleaned || slug;
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readEntry(slug) {
  let meta = {};
  try {
    meta = JSON.parse(await readFile(join(PROJECTS_DIR, slug, 'project.json'), 'utf8'));
  } catch {
    // Missing or malformed project.json -> fall back to defaults. Never crash the build:
    // a single bad project must not be able to take down the whole catalog.
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    slug,
    path: `projects/${slug}/`, // repo-root-relative, trailing slash so index.html is served
    title: str(meta.title) || humanize(slug),
    description: str(meta.description),
    agent: str(meta.agent),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    createdAt: str(meta.createdAt),
  };
}

async function main() {
  let dirents = [];
  try {
    dirents = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    // projects/ doesn't exist yet — emit an empty catalog.
  }

  const projects = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name.startsWith('.') || d.name.startsWith('_')) continue; // skip dotdirs & _template
    if (!(await exists(join(PROJECTS_DIR, d.name, 'index.html')))) continue; // must be servable
    projects.push(await readEntry(d.name));
  }

  // Newest first by createdAt, then alphabetically by slug for stability.
  projects.sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.slug.localeCompare(b.slug),
  );

  const catalog = { generatedAt: new Date().toISOString(), count: projects.length, projects };
  await writeFile(OUTPUT, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`build-catalog: wrote ${OUTPUT} with ${projects.length} project(s).`);
}

main().catch((err) => {
  console.error('build-catalog failed:', err);
  process.exit(1);
});
