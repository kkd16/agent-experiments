#!/usr/bin/env node
// Decide whether a branch's changes are safe to auto-merge to main.
//
// A branch qualifies only if EVERY changed file lives under a single
// projects/<slug>/ folder. This is the Golden Rule from AGENTS.md, enforced
// mechanically: a branch that also touches the root, scripts/, workflows, or a
// second project is never auto-merged — it's left for a human to review.
//
//   git diff --name-only origin/main...HEAD > changed.txt
//   node scripts/changed-scope.mjs changed.txt
//   # or: git diff --name-only origin/main...HEAD | node scripts/changed-scope.mjs
//
// Emits one line to GITHUB_OUTPUT (and a human note to stdout):
//   slug=<slug>      → exactly one project folder changed; safe to merge
//   skip=<reason>    → caller must NOT merge
import { appendFile, readFile } from 'node:fs/promises';
import { classifyScope } from './_lib.mjs';

async function readInput() {
  const arg = process.argv[2];
  if (arg) return readFile(arg, 'utf8');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readInput();
const files = raw.split('\n').map((l) => l.trim()).filter(Boolean);
const result = classifyScope(files);

const line = result.slug ? `slug=${result.slug}\n` : `skip=${result.skip}\n`;
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, line);
process.stdout.write(
  result.slug ? `auto-merge scope: ${result.slug}\n` : `auto-merge skip: ${result.skip}\n`,
);
