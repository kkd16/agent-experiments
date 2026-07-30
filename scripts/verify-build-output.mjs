#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateBuildHtml } from './_lib.mjs';

const dir = resolve(process.argv[2] || '.');

try {
  const html = await readFile(join(dir, 'dist', 'index.html'), 'utf8');
  const errors = validateBuildHtml(html);
  if (errors.length) {
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }
  console.log(`✓ build output (${dir}): dist/index.html uses subpath-safe URLs`);
} catch (error) {
  console.error(`  - could not read dist/index.html: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
