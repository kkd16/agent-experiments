#!/usr/bin/env node
// Run the exact gate CI runs for one project, in order: scope (Golden Rule) +
// conformance + lint + build. Every failure prints WHAT broke and HOW to fix it.
//   node scripts/verify-project.mjs <slug>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exists, validate, classifyScope } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const slug = process.argv[2];

if (!slug) {
  console.error('usage: node scripts/verify-project.mjs <slug>');
  process.exit(2);
}

const dir = join(PROJECTS_DIR, slug);
if (!(await exists(dir))) {
  console.error(`verify: projects/${slug}/ not found — create it from projects/_template first.`);
  process.exit(2);
}

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

// git, best-effort: returns stdout on success, or null if the command fails (or
// git isn't here). The scope check only FAILS on a confident violation; if it
// can't read git state it SKIPS, so it never blocks a legitimate project.
function git(...args) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
const lines = (out) => (out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : []);

function resolveBase() {
  for (const ref of ['origin/main', 'main']) {
    if (git('rev-parse', '--verify', '--quiet', ref) !== null) return ref;
  }
  return null;
}

// Everything this branch changes vs main: tracked (committed + staged + unstaged)
// is what a PR would carry; untracked-but-not-ignored is what `git add -A` would sweep in.
function branchScope() {
  if (git('rev-parse', '--is-inside-work-tree') === null) return { skipped: 'not inside a git work tree' };
  const base = resolveBase();
  const tracked = new Set();
  if (base) {
    const mb = (git('merge-base', base, 'HEAD') || '').trim();
    if (mb) lines(git('diff', '--name-only', mb, 'HEAD')).forEach((f) => tracked.add(f));
  }
  lines(git('diff', '--name-only', '--cached')).forEach((f) => tracked.add(f));
  lines(git('diff', '--name-only')).forEach((f) => tracked.add(f));
  const untracked = lines(git('ls-files', '--others', '--exclude-standard'));
  const outside = (f) => !f.startsWith(`projects/${slug}/`);
  return {
    base,
    tracked: [...tracked],
    trackedOffenders: [...tracked].filter(outside),
    untrackedOffenders: untracked.filter(outside),
  };
}

// 1) Scope — the Golden Rule: a PR may touch exactly your own projects/<slug>/ and nothing else.
const s = branchScope();
if (s.skipped) {
  console.log(`• scope: skipped (${s.skipped}); CI still enforces the Golden Rule`);
} else if (s.trackedOffenders.length) {
  console.error('✗ scope (Golden Rule)');
  console.error(`  ${classifyScope(s.tracked).skip || `every changed file must live under projects/${slug}/`}`);
  console.error(`  A PR may change exactly one projects/<slug>/ folder and nothing else, but these`);
  console.error(`  ${s.trackedOffenders.length} changed path(s) are outside projects/${slug}/:`);
  s.trackedOffenders.forEach((f) => console.error(`    - ${f}`));
  console.error('  Fix: unstage/remove them (e.g. `git rm --cached <file>`), run pnpm INSIDE your');
  console.error(`  project folder (never the repo root), and commit only projects/${slug}/. Then re-run.`);
  process.exit(1);
} else {
  if (s.untrackedOffenders.length) {
    console.warn(`! scope warning: ${s.untrackedOffenders.length} untracked file(s) outside projects/${slug}/:`);
    s.untrackedOffenders.forEach((f) => console.warn(`    - ${f}`));
    console.warn('  a `git add -A` would pull these into your PR and the gate would reject it —');
    console.warn('  remove or gitignore them, and run pnpm inside your project folder, not the repo root.');
  }
  console.log('✓ scope');
}

// 2) Conformance — required files, stack, and config.
const violations = await validate(PROJECTS_DIR, slug);
if (violations.length) {
  console.error('✗ conformance — your project is missing or misconfigures required pieces:');
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
}
console.log('✓ conformance');

// 3) install / lint / build — the real toolchain, inside your folder.
function step(label, args) {
  const r = spawnSync('pnpm', args, { cwd: dir, stdio: 'inherit', shell: false });
  if (r.error) die(`✗ ${label}: could not run pnpm (${r.error.message}). Is pnpm installed?`);
  if (r.status !== 0) die(`✗ ${label} failed — read the pnpm output above for the exact error, fix it, and re-run.`);
  console.log(`✓ ${label}`);
}
step('install', ['install', '--frozen-lockfile']);
step('lint', ['run', 'lint']);
step('build', ['run', 'build']);
if (!(await exists(join(dir, 'dist', 'index.html'))))
  die('✗ build produced no dist/index.html — your build script must emit the app to dist/ (the default Vite output).');
console.log('✓ build output (dist/index.html)');

console.log(`\n${slug}: ✓ ready to push — scope + conformance + lint + build all pass (the exact gate CI runs).`);
