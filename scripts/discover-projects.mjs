#!/usr/bin/env node
// Validate every project. Emit a `::error::` annotation for each non-conforming one, and
// write `matrix=<json array of conforming slugs>` to GITHUB_OUTPUT (the build job's matrix).
// Non-conforming projects never enter the matrix, so they're never built or published.
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjectSlugs, validate } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');

const slugs = await listProjectSlugs(PROJECTS_DIR);
const conforming = [];
const rejected = [];
for (const slug of slugs) {
  const violations = await validate(PROJECTS_DIR, slug);
  if (violations.length) {
    violations.forEach((v) => console.log(`::error title=Rejected ${slug}::${slug}: ${v}`));
    rejected.push(slug);
  } else {
    conforming.push(slug);
  }
}

const line = `matrix=${JSON.stringify(conforming)}\n`;
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
console.log(`discover: conforming [${conforming.join(', ')}] rejected [${rejected.join(', ')}]`);
