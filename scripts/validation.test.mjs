import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reportViolations, validate, validateBuildHtml, validateTags } from './_lib.mjs';

const SLUG = 'validation-test-a1b2';
const VALID_PACKAGE = {
  scripts: { build: 'tsc -b && vite build', lint: 'eslint .' },
  dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
};
const VALID_META = {
  title: 'Validation Test',
  description: 'A complete fixture for the conformance validator.',
  agent: 'test-agent',
  model: 'test-model',
  tags: ['testing'],
  createdAt: '2026-07-29',
};
const VALID_FILES = {
  'index.html': '<div id="root"></div>',
  'pnpm-lock.yaml': 'lockfileVersion: 9',
  'JOURNAL.md': '- [x] Create validation fixture',
  'package.json': JSON.stringify(VALID_PACKAGE),
  'project.json': JSON.stringify(VALID_META),
  'vite.config.ts': [
    "import react from '@vitejs/plugin-react'",
    'export default {',
    "  base: './',",
    '  plugins: [react()],',
    '};',
  ].join('\n'),
};

async function validateFixture({ files = {}, directories = [], symlinks = [], slug = SLUG } = {}) {
  const projectsDir = await mkdtemp(join(tmpdir(), 'validation-test-'));
  const dir = join(projectsDir, slug);
  await mkdir(dir, { recursive: true });
  const directorySet = new Set(directories);
  const symlinkSet = new Set(symlinks);
  try {
    for (const [name, contents] of Object.entries({ ...VALID_FILES, ...files })) {
      if (contents !== null && !directorySet.has(name) && !symlinkSet.has(name))
        await writeFile(join(dir, name), contents);
    }
    for (const name of directories) await mkdir(join(dir, name), { recursive: true });
    for (const name of symlinks) {
      const target = join(projectsDir, `borrowed-${name.replaceAll('/', '-')}`);
      await writeFile(target, VALID_FILES[name]);
      await symlink(target, join(dir, name));
    }
    return await validate(projectsDir, slug);
  } finally {
    await rm(projectsDir, { recursive: true, force: true });
  }
}

function hasError(errors, text) {
  return errors.some((error) => error.includes(text));
}

test('a complete project passes conformance', async () => {
  assert.deepEqual(await validateFixture(), []);
});

test('required files must exist as regular files', async () => {
  const expected = {
    'index.html': 'missing index.html',
    'pnpm-lock.yaml': 'missing pnpm-lock.yaml',
    'JOURNAL.md': 'missing JOURNAL.md',
    'package.json': 'missing package.json',
    'project.json': 'missing project.json',
    'vite.config.ts': 'missing vite.config.ts',
  };
  for (const [name, message] of Object.entries(expected)) {
    assert.ok(hasError(await validateFixture({ files: { [name]: null } }), message), name);
    assert.ok(
      hasError(await validateFixture({ files: { [name]: null }, directories: [name] }), message),
      `${name} directory`,
    );
    assert.ok(hasError(await validateFixture({ symlinks: [name] }), message), `${name} symlink`);
  }
});

test('slug, package manager, and journal rules are enforced', async () => {
  assert.ok(hasError(await validateFixture({ slug: 'Bad_Slug' }), 'slug must be kebab-case'));
  assert.ok(hasError(await validateFixture({ files: { 'package-lock.json': '{}' } }), 'pnpm-only'));
  assert.ok(hasError(await validateFixture({ files: { 'yarn.lock': '' } }), 'pnpm-only'));
  for (const journal of ['', ' \n\t']) {
    assert.ok(hasError(await validateFixture({ files: { 'JOURNAL.md': journal } }), 'JOURNAL.md is empty'));
  }
});

test('package.json must be an object with dependencies and runnable scripts', async () => {
  for (const value of ['{', 'null', '[]', '42', '"package"']) {
    assert.ok(hasError(await validateFixture({ files: { 'package.json': value } }), 'package.json'), value);
  }

  const invalidPackages = [
    [{ ...VALID_PACKAGE, dependencies: {} }, 'depend on react and react-dom'],
    [{ ...VALID_PACKAGE, dependencies: { react: '', 'react-dom': '^19.0.0' } }, 'depend on react and react-dom'],
    [{ ...VALID_PACKAGE, dependencies: { react: '^19.0.0', 'react-dom': 19 } }, 'depend on react and react-dom'],
    [{ ...VALID_PACKAGE, scripts: { ...VALID_PACKAGE.scripts, build: '' } }, '"build" script must be exactly'],
    [
      { ...VALID_PACKAGE, scripts: { ...VALID_PACKAGE.scripts, build: 'vite build --base /' } },
      '"build" script must be exactly',
    ],
    [{ ...VALID_PACKAGE, scripts: { ...VALID_PACKAGE.scripts, lint: 1 } }, '"lint" script must be exactly'],
    [{ ...VALID_PACKAGE, scripts: { ...VALID_PACKAGE.scripts, lint: 'eslint src' } }, '"lint" script must be exactly'],
  ];
  for (const [pkg, message] of invalidPackages) {
    const errors = await validateFixture({ files: { 'package.json': JSON.stringify(pkg) } });
    assert.ok(hasError(errors, message), JSON.stringify(pkg));
  }
});

test('Vite config must be TypeScript and cannot be shadowed', async () => {
  const jsOnly = await validateFixture({
    files: { 'vite.config.ts': null, 'vite.config.js': VALID_FILES['vite.config.ts'] },
  });
  assert.ok(hasError(jsOnly, 'missing vite.config.ts'));

  for (const name of ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts']) {
    const errors = await validateFixture({ files: { [name]: "export default { base: '/' }" } });
    assert.ok(hasError(errors, 'remove alternate Vite config'), name);
  }

  const invalidConfigs = [
    [VALID_FILES['vite.config.ts'].replace("import react from '@vitejs/plugin-react'\n", ''), 'must import'],
    [VALID_FILES['vite.config.ts'].replace("  base: './',", "  base: '/',"), "must set base: './'"],
    [VALID_FILES['vite.config.ts'].replace('  plugins: [react()],', '  plugins: [],'), 'must enable react()'],
    [
      [
        '/*',
        "import react from '@vitejs/plugin-react'",
        'plugins: [react()]',
        '*/',
        "export default { base: './', plugins: [] }",
      ].join('\n'),
      'must import',
    ],
    [
      VALID_FILES['vite.config.ts'].replace("  base: './',", "  base: checking ? './' : '/',"),
      "must set base: './'",
    ],
  ];
  for (const [config, message] of invalidConfigs) {
    const errors = await validateFixture({ files: { 'vite.config.ts': config } });
    assert.ok(hasError(errors, message), config);
  }
});

test('project.json must be an object with complete string metadata', async () => {
  for (const value of ['{', 'null', '[]', '42', '"project"']) {
    assert.ok(hasError(await validateFixture({ files: { 'project.json': value } }), 'project.json'), value);
  }
  for (const field of ['title', 'description', 'agent', 'model']) {
    for (const value of [undefined, '', '  ', 1, null]) {
      const meta = { ...VALID_META, [field]: value };
      if (value === undefined) delete meta[field];
      const errors = await validateFixture({ files: { 'project.json': JSON.stringify(meta) } });
      assert.ok(hasError(errors, `"${field}" must be a non-empty string`), `${field}: ${String(value)}`);
    }
  }
  const uppercaseAgent = { ...VALID_META, agent: 'Test-Agent' };
  assert.ok(
    hasError(
      await validateFixture({ files: { 'project.json': JSON.stringify(uppercaseAgent) } }),
      '"agent" must be lowercase',
    ),
  );
});

test('createdAt must be a required real ISO calendar date', async () => {
  for (const value of [undefined, null, 20260729, '', '2026-7-29', '2026-02-29', '2026-13-01', '2026-01-32']) {
    const meta = { ...VALID_META, createdAt: value };
    if (value === undefined) delete meta.createdAt;
    const errors = await validateFixture({ files: { 'project.json': JSON.stringify(meta) } });
    assert.ok(hasError(errors, 'real ISO date YYYY-MM-DD'), String(value));
  }
  const leapDay = { ...VALID_META, createdAt: '2024-02-29' };
  assert.deepEqual(await validateFixture({ files: { 'project.json': JSON.stringify(leapDay) } }), []);
});

test('tags accept documented boundaries and reject malformed or reserved values', () => {
  for (const tags of [['ai'], ['3d'], ['a'.repeat(24)], ['signal-processing', 'audio', 'visualization']]) {
    assert.deepEqual(validateTags(tags), [], JSON.stringify(tags));
  }
  const invalid = [
    undefined,
    null,
    {},
    'physics',
    [],
    ['a'],
    ['a'.repeat(25)],
    ['one', 'two', 'three', 'four'],
    ['valid', 1],
    ['valid', 'valid'],
    ['UPPERCASE'],
    ['two words'],
    ['under_score'],
    ['double--hyphen'],
    ['-leading'],
    ['trailing-'],
    ['pnpm'],
    ['react'],
    ['replace-me'],
    ['typescript'],
    ['vite'],
  ];
  for (const tags of invalid) assert.ok(validateTags(tags).length > 0, `accepted ${JSON.stringify(tags)}`);
  assert.equal(validateTags(new Array(100_000).fill('invalid tag')).length, 1);
});

test('project validation applies the tag policy', async () => {
  for (const tags of [undefined, ['one', 'two', 'three', 'four'], ['react'], ['duplicate', 'duplicate']]) {
    const meta = { ...VALID_META, tags };
    if (tags === undefined) delete meta.tags;
    const errors = await validateFixture({ files: { 'project.json': JSON.stringify(meta) } });
    assert.ok(
      errors.some((error) => error.startsWith('project.json tag') || error.startsWith('project.json "tags"')),
      JSON.stringify(tags),
    );
  }
});

test('build output requires subpath-safe asset URLs', () => {
  assert.deepEqual(validateBuildHtml('<script src="./assets/app.js"></script>'), []);
  assert.deepEqual(validateBuildHtml('<link href="https://example.com/app.css">'), []);
  assert.deepEqual(validateBuildHtml('<script src="//cdn.example.com/app.js"></script>'), []);
  assert.deepEqual(validateBuildHtml('<!-- <link href="/unused.css"> -->'), []);
  assert.ok(validateBuildHtml('<script src="/assets/app.js"></script>').length > 0);
  assert.ok(validateBuildHtml('<script src=/assets/app.js></script>').length > 0);
  assert.ok(validateBuildHtml("<link href = '/assets/app.css'>").length > 0);
  assert.ok(validateBuildHtml('<img srcset="./small.png 1x, /large.png 2x">').length > 0);
  assert.ok(validateBuildHtml(null).length > 0);
});

test('workflow diagnostics cannot inject commands or unbounded values', () => {
  const errors = validateTags([`${'x'.repeat(100)}\n::warning::injected`]);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => !error.includes('\n') && error.length < 180));

  const output = [];
  const originalLog = console.log;
  console.log = (message) => output.push(message);
  try {
    reportViolations('bad%\r\n::warning::slug', ['bad%\r\n::warning::message']);
  } finally {
    console.log = originalLog;
  }
  assert.equal(output.length, 1);
  assert.ok(!output[0].includes('\n') && !output[0].includes('\r'));
  assert.equal((output[0].match(/%25%0D%0A/g) || []).length, 2);
});
