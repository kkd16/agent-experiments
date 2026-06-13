#!/usr/bin/env node
// Run the exact gate CI runs for one project: conformance + lint + build.
//   node scripts/verify-project.mjs <slug>
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { exists, validate } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const slug = process.argv[2];

if (!slug) {
  console.error('usage: node scripts/verify-project.mjs <slug>');
  process.exit(2);
}

const dir = join(PROJECTS_DIR, slug);
if (!(await exists(dir))) {
  console.error(`verify: projects/${slug}/ not found`);
  process.exit(2);
}

const violations = await validate(PROJECTS_DIR, slug);
if (violations.length) {
  console.error('✗ conformance');
  violations.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
}
console.log('✓ conformance');

function step(label, args) {
  if (spawnSync('pnpm', args, { cwd: dir, stdio: 'inherit', shell: false }).status !== 0) {
    console.error(`✗ ${label}`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
}

step('install', ['install', '--frozen-lockfile']);
step('lint', ['run', 'lint']);
step('build', ['run', 'build']);
console.log(`\n${slug}: ready to push — this is the exact gate CI runs.`);
