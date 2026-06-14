import { readdir, readFile, stat, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SHELL = ['index.html', 'assets', '.nojekyll'];

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Golden Rule: in scope only if every changed file is under one projects/<slug>/. → { slug } | { skip }
export function classifyScope(files) {
  if (files.length === 0) return { skip: 'no changed files (branch already merged or empty)' };
  const slugs = new Set();
  for (const f of files) {
    const m = f.match(/^projects\/([^/]+)\/.+/);
    if (!m) return { skip: `changes outside a project folder are never auto-merged (e.g. "${f}")` };
    const slug = m[1];
    if (slug.startsWith('_') || slug.startsWith('.'))
      return { skip: `reserved folder "projects/${slug}/" cannot be auto-merged` };
    if (!SLUG_RE.test(slug)) return { skip: `"${slug}" is not a kebab-case slug` };
    slugs.add(slug);
  }
  if (slugs.size !== 1)
    return { skip: `auto-merge handles exactly one project per branch (found ${slugs.size}: ${[...slugs].join(', ')})` };
  return { slug: [...slugs][0] };
}

export function humanize(slug) {
  const m = slug.match(/^(.*)-([0-9a-f]{4,8})$/i);
  const base = m && /\d/.test(m[2]) && /[a-f]/i.test(m[2]) ? m[1] : slug;
  return base
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

export async function readJournalProgress(projectsDir, slug) {
  let text = '';
  try {
    text = await readFile(join(projectsDir, slug, 'JOURNAL.md'), 'utf8');
  } catch {
    return { total: 0, done: 0 };
  }
  const body = text.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');
  let total = 0;
  let done = 0;
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s/);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { total, done };
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
    model: str(meta.model),
    tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
    createdAt: str(meta.createdAt),
    progress: await readJournalProgress(projectsDir, slug),
  };
}

export async function validate(projectsDir, slug) {
  const dir = join(projectsDir, slug);
  const errors = [];

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    errors.push('slug must be kebab-case (lowercase letters/digits, single hyphens)');
  if (!(await exists(join(dir, 'index.html')))) errors.push('missing index.html at the project root');
  if (await exists(join(dir, 'package-lock.json'))) errors.push('has package-lock.json — this repo is pnpm-only');
  if (await exists(join(dir, 'yarn.lock'))) errors.push('has yarn.lock — this repo is pnpm-only');
  if (!(await exists(join(dir, 'pnpm-lock.yaml')))) errors.push('missing pnpm-lock.yaml — run `pnpm install` and commit it');

  const journal = join(dir, 'JOURNAL.md');
  if (!(await exists(journal))) {
    errors.push('missing JOURNAL.md — every app needs a project journal (ideas + session log)');
  } else if (!(await readFile(journal, 'utf8').catch(() => '')).trim()) {
    errors.push('JOURNAL.md is empty — record your ideas/backlog and session log there');
  }

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
    if (!pkg.scripts?.lint) errors.push('package.json needs a "lint" script');
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
    const m = text.match(/base\s*:\s*[`"']([^`"']*)[`"']/);
    const base = m ? m[1] : null;
    if (base === null) errors.push("vite.config must set base: './'");
    else if (!(base === './' || base === '' || base === '.'))
      errors.push(`vite.config base must be relative ('./'), found '${base}'`);
    const out = text.match(/outDir\s*:\s*[`"']([^`"']*)[`"']/);
    if (out && out[1] !== 'dist') errors.push(`build output must use the default dist/ (found outDir '${out[1]}')`);
  }

  if (await exists(join(dir, 'project.json'))) {
    let meta = null;
    try {
      meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'));
    } catch {
      errors.push('project.json is not valid JSON');
    }
    if (meta) {
      if (typeof meta.agent === 'string' && meta.agent !== meta.agent.toLowerCase())
        errors.push(`project.json "agent" must be lowercase (found "${meta.agent}")`);
      for (const t of Array.isArray(meta.tags) ? meta.tags : [])
        if (typeof t === 'string' && t !== t.toLowerCase())
          errors.push(`project.json tag "${t}" must be lowercase`);
      if (typeof meta.createdAt === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(meta.createdAt))
        errors.push(`project.json "createdAt" must be ISO YYYY-MM-DD (found "${meta.createdAt}")`);
    }
  }

  return errors;
}

export function reportViolations(slug, violations) {
  violations.forEach((v) => console.log(`::error title=Rejected ${slug}::${slug}: ${v}`));
}

export async function copyShell(root, site) {
  await rm(site, { recursive: true, force: true });
  await mkdir(join(site, 'projects'), { recursive: true });
  for (const item of SHELL) {
    const src = join(root, item);
    if (await exists(src)) await cp(src, join(site, item), { recursive: true });
  }
}

export async function writeCatalog(site, metas) {
  const projects = [...metas].sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.slug.localeCompare(b.slug),
  );
  const catalog = { generatedAt: new Date().toISOString(), count: projects.length, projects };
  await writeFile(join(site, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
}
