import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export function humanize(slug) {
  const cleaned = slug.replace(/-[0-9a-z]{4,8}$/i, '').replace(/[-_]+/g, ' ').trim();
  return (cleaned || slug).replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function listProjectSlugs(projectsDir) {
  let dirents = [];
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return dirents
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
}

export async function readMeta(projectsDir, slug) {
  let meta = {};
  try {
    meta = JSON.parse(await readFile(join(projectsDir, slug, 'project.json'), 'utf8'));
  } catch {
    meta = {};
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

export async function validate(projectsDir, slug) {
  const dir = join(projectsDir, slug);
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
