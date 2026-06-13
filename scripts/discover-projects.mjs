#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProjectSlugs, validate, reportViolations } from './_lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_DIR = join(ROOT, 'projects');
const MAX_MATRIX = 256;

const conforming = [];
const rejected = [];
for (const slug of await listProjectSlugs(PROJECTS_DIR)) {
  const violations = await validate(PROJECTS_DIR, slug);
  if (violations.length) {
    reportViolations(slug, violations);
    rejected.push(slug);
  } else {
    conforming.push(slug);
  }
}

let matrixList = conforming;
if (conforming.length > MAX_MATRIX) {
  console.log(
    `::warning::${conforming.length} conforming projects exceed the ${MAX_MATRIX}-job build matrix cap; building the first ${MAX_MATRIX}. Shard the build to cover the rest.`,
  );
  matrixList = conforming.slice(0, MAX_MATRIX);
}

const line = `matrix=${JSON.stringify(matrixList)}\n`;
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
else process.stdout.write(line);
console.log(`discover: conforming ${conforming.length} rejected [${rejected.join(', ')}]`);
