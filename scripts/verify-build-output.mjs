#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateBuildHtml, validateThumbnailSvg } from './_lib.mjs';

const dir = resolve(process.argv[2] || '.');

try {
  const [html, thumbnail] = await Promise.all([
    readFile(join(dir, 'dist', 'index.html'), 'utf8'),
    readFile(join(dir, 'dist', 'thumbnail.svg'), 'utf8'),
  ]);
  const errors = [
    ...validateBuildHtml(html),
    ...validateThumbnailSvg(thumbnail).map((error) => `dist/thumbnail.svg ${error}`),
  ];
  if (errors.length) {
    errors.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }
  console.log(`✓ build output (${dir}): subpath-safe HTML + valid SVG thumbnail`);
} catch (error) {
  console.error(`  - incomplete build output: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
