// Plain-JS entry bundled by Vite for the headless differential harness.
// Not part of the app build (tsconfig includes only src/) and not linted
// (eslint targets *.ts/*.tsx). It re-exports the verifier + program corpus.
import { verifyAll } from '../src/compiler/verify.ts';
import { EXAMPLES } from '../src/examples.ts';
import { TESTS } from '../src/compiler/tests.ts';

export async function run() {
  const programs = [
    ...EXAMPLES.map((e) => ({ name: 'ex:' + e.id, source: e.source })),
    ...TESTS.map((t) => ({ name: t.name, source: t.source })),
  ];
  const levels = [0, 1, 2, 3];
  const results = await verifyAll(programs, levels);
  return results;
}
