#!/usr/bin/env node
// CI pipeline: validate every project against the enforced stack (Vite + React + TS + pnpm),
// build the conforming ones, assemble _site, and write the catalog from what actually built.
//
// Non-conforming or build-failing projects are REJECTED (skipped + a GitHub `::error::`
// annotation) — they never block the rest of the deploy.
//
//   node scripts/build-site.mjs                full build + assemble
//   node scripts/build-site.mjs --catalog-only validate + catalog only (fast local preview)
import { readdir, readFile, writeFile, mkdir, cp, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const SITE = join(ROOT, '_site');
const SHELL = ['index.html', 'assets', '.nojekyll'];
const CATALOG_ONLY = process.argv.includes('--catalog-only');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function humanize(slug) {
  const cleaned = slug.replace(/-[0-9a-z]{4,8}$/i, '').replace(/[-_]+/g, ' ').trim();
  return (cleaned || slug).replace(/\b\w/g, (c) => c.toUpperCase());
}

async function readMeta(slug) {
  let meta = {};
  try {
    meta = JSON.parse(await readFile(join(PROJECTS_DIR, slug, 'project.json'), 'utf8'));
  } catch {
    // missing/malformed project.json: fall back to defaults
  }
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return {
    slug,
    path: `projects/${slug}/`,
    title: str(meta.title) || humanize(slug),
    description: str(meta.description),
    agent: str(meta.agent),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    createdAt: str(meta.createdAt),
  };
}

// Returns an array of violation strings; empty array means the project conforms.
async function validate(slug) {
  const dir = join(PROJECTS_DIR, slug);
  const errors = [];

  if (!(await exists(join(dir, 'index.html')))) errors.push('missing index.html at the project root');
  if (await exists(join(dir, 'package-lock.json'))) errors.push('has package-lock.json — this repo is pnpm-only');
  if (await exists(join(dir, 'yarn.lock'))) errors.push('has yarn.lock — this repo is pnpm-only');
  if (!(await exists(join(dir, 'pnpm-lock.yaml')))) errors.push('missing pnpm-lock.yaml — run `pnpm install` and commit it');

  let pkg = null;
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    errors.push('missing or invalid package.json');
  }
  if (pkg) {
    const deps = pkg.dependencies || {};
    if (!deps.react || !deps['react-dom']) errors.push('package.json must depend on react and react-dom');
    if (!pkg.scripts?.build) errors.push('package.json needs a "build" script');
  }

  const candidates = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];
  let cfg = null;
  for (const f of candidates) {
    if (await exists(join(dir, f))) {
      cfg = join(dir, f);
      break;
    }
  }
  if (!cfg) {
    errors.push('missing vite.config.ts');
  } else {
    const text = await readFile(cfg, 'utf8');
    if (!text.includes('react(')) errors.push('vite.config must use the react() plugin');
    const m = text.match(/base\s*:\s*["']([^"']*)["']/);
    const base = m ? m[1] : null;
    if (base === null) errors.push("vite.config must set base: './'");
    else if (!(base === './' || base === '' || base === '.'))
      errors.push(`vite.config base must be relative ('./'), found '${base}'`);
  }

  return errors;
}

function run(cmd, args, cwd) {
  return spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false }).status === 0;
}

function reject(slug, msg) {
  console.log(`::error title=Rejected ${slug}::${slug}: ${msg}`);
}

async function main() {
  await rm(SITE, { recursive: true, force: true });
  await mkdir(join(SITE, 'projects'), { recursive: true });
  for (const item of SHELL) {
    const src = join(ROOT, item);
    if (await exists(src)) await cp(src, join(SITE, item), { recursive: true });
  }

  let dirents = [];
  try {
    dirents = await readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    // no projects/ yet
  }

  const published = [];
  const rejected = [];
  for (const d of dirents) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name.startsWith('_')) continue;
    const slug = d.name;
    const dir = join(PROJECTS_DIR, slug);

    const violations = await validate(slug);
    if (violations.length) {
      violations.forEach((v) => reject(slug, v));
      rejected.push(slug);
      continue;
    }

    if (CATALOG_ONLY) {
      published.push(await readMeta(slug));
      continue;
    }

    const ok = run('pnpm', ['install', '--frozen-lockfile'], dir) && run('pnpm', ['run', 'build'], dir);
    if (!ok || !(await exists(join(dir, 'dist', 'index.html')))) {
      reject(slug, 'build failed (or produced no dist/index.html)');
      rejected.push(slug);
      continue;
    }
    await cp(join(dir, 'dist'), join(SITE, 'projects', slug), { recursive: true }); // dist CONTENTS → slug dir
    published.push(await readMeta(slug));
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
