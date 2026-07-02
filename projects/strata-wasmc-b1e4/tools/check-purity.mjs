// Interprocedural-purity checks. Bundles the compiler (Vite SSR, extensionless-TS
// as in the app) and (1) confirms the whole-program effect analysis fires — a
// redundant `pure` call is CSE-d away, a loop-invariant one is hoisted, a dead one
// is dropped — and correctly *declines* when the callee prints, writes a global, or
// reads memory; then (2) runs a seeded differential fuzzer: hundreds of programs
// that mix pure and impure helpers, compiled at -O0..-O3 and proven to print exactly
// what the reference interpreter (and the from-scratch wasm VM) print. Correctness is
// the oracle's job; firing/declining is this tool's.
//
// Run with:  node tools/check-purity.mjs
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.purityharness');

await build({
  configFile: false, logLevel: 'error',
  build: { ssr: true, outDir, emptyOutDir: true,
    lib: { entry: resolve(here, '_purityentry.js'), formats: ['es'], fileName: 'purityharness' },
    rollupOptions: { output: { entryFileNames: 'purityharness.mjs' } }, minify: false, target: 'node20' },
});

const { probePurity, fuzz } = await import(pathToFileURL(resolve(outDir, 'purityharness.mjs')).href);

// A big (>40-instruction) arithmetic body, so the pre-SSA inliner leaves it as a
// real `call` (its size budget is 40). This isolates the call-count signal to the
// interprocedural purity passes alone — inlining can't be what removes the call.
const bigExpr = () => {
  const terms = [];
  for (let i = 1; i <= 22; i++) terms.push(`x * ${i}`, `y * ${i + 1}`);
  return terms.join(' + ');
};

// Each case declares the callee count it should collapse to at -O2, and the exact
// pure / pure-non-trapping classification the analysis must produce. The `callsO0`
// baseline shows the reduction the optimization is responsible for.
const cases = [
  {
    name: 'redundant pure call CSE-d (combine twice -> once)',
    source: `fn sq(x: int) -> int { return x * x; }
fn combine(a: int, b: int) -> int { return sq(a) + sq(b); }
fn main() {
  let a = 7; let b = 11;
  print(combine(a, b) + combine(a, b));   // one combine after CSE
}`,
    pure: ['sq', 'combine'], pureNoTrap: ['sq', 'combine'],
    // O0: combine ×2 + (each combine calls sq ×2, not inlined at O0) => 2 combine + 4 sq = 6
    // O2: CSE keeps a single combine(a,b); its two sq calls survive (or inline). We only
    // assert the call count strictly drops vs O0.
    expectDrop: true,
  },
  {
    name: 'loop-invariant pure call hoisted out of the loop',
    source: `fn weight(k: int) -> int { return k * 31 + 7; }
fn main() {
  let base = 5;
  let acc = 0;
  for (let i = 0; i < 100; i = i + 1) { acc = acc + weight(base) + i; }
  print(acc);
}`,
    pure: ['weight'], pureNoTrap: ['weight'],
    expectLicm: true, expectDrop: true,
  },
  {
    name: 'dead pure call dropped by DCE',
    source: `fn f(x: int) -> int { return x * x - x + 1; }
fn main() {
  let a = 9;
  let unused = f(a);      // result never read -> removed
  print(a + 1);
}`,
    pure: ['f'], pureNoTrap: ['f'],
    expectDrop: true,
  },
  {
    name: 'big pure callee: redundant call CSE-d 2->1 (inliner declines, >40 insts)',
    source: `fn bigpure(x: int, y: int) -> int { return ${bigExpr()}; }
fn main() {
  let a = 4; let b = 6;
  print(bigpure(a, b) + bigpure(a, b));   // exactly one bigpure survives CSE
}`,
    pure: ['bigpure'], pureNoTrap: ['bigpure'],
    callsO0: 2, callsO2: 1,
  },
  {
    name: 'big impure callee (prints) is NEVER merged (stays 2 calls)',
    source: `fn bignoisy(x: int, y: int) -> int { print(x); return ${bigExpr()}; }
fn main() {
  let a = 3; let b = 9;
  print(bignoisy(a, b) + bignoisy(a, b));   // must print twice; both calls survive
}`,
    pure: [], pureNoTrap: [],
    callsO0: 2, callsO2: 2,
  },
  {
    name: 'big callee reading a mutable global is impure (stays 2 calls)',
    source: `let g = 0;
fn readg(x: int, y: int) -> int { return g + ${bigExpr()}; }
fn main() {
  g = 10;
  let a = readg(5, 1);
  g = 20;
  let b = readg(5, 1);        // different result — must not be CSE-d with a
  print(a); print(b);
}`,
    pure: [], pureNoTrap: [],
    callsO0: 2, callsO2: 2,
  },
  {
    // A big helper that builds a *local* struct (impure as written — it allocates
    // and stores) is scalarized by SROA; because the effect analysis is recomputed
    // every fixpoint round, `bigstruct` is then re-classified pure mid-pipeline and
    // its redundant call is CSE-d 2->1. Proves the per-round recompute pays off.
    name: 'SROA turns a struct helper pure -> redundant call CSE-d (2->1)',
    source: `struct P { x: int; y: int; }
fn bigstruct(a: int, b: int) -> int { let p = P(a * 2, b * 3); return p.x * p.y + ${(() => { let s = []; for (let i = 1; i <= 22; i++) s.push(`p.x * ${i}`, `p.y * ${i + 1}`); return s.join(' + '); })()}; }
fn main() {
  let a = 6; let b = 5;
  print(bigstruct(a, b) + bigstruct(a, b));
}`,
    // Classified on the *unoptimized* SSA, where the struct traffic is still
    // present, so bigstruct is not yet pure — the reclassification happens only
    // after SROA runs inside the optimizer.
    pure: [], pureNoTrap: [],
    callsO0: 2, callsO2: 1,
  },
  {
    name: 'recursive pure call: CSE-able but not hoistable/droppable',
    source: `fn fib(n: int) -> int { if (n < 2) { return n; } return fib(n - 1) + fib(n - 2); }
fn main() {
  let n = 10;
  print(fib(n) + fib(n));     // fib is pure -> CSE keeps one; recursion -> not pureNoTrap
}`,
    pure: ['fib'], pureNoTrap: [],
    expectDrop: true,
  },
];

const setEq = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

let ok = 0, bad = 0;
for (const c of cases) {
  const p0 = probePurity(c.source, 0);
  const p2 = probePurity(c.source, 2);
  const checks = [];
  checks.push(['pure set', setEq(p2.pure, c.pure), `got [${p2.pure}] want [${c.pure}]`]);
  checks.push(['pureNoTrap set', setEq(p2.pureNoTrap, c.pureNoTrap), `got [${p2.pureNoTrap}] want [${c.pureNoTrap}]`]);
  if (c.expectDrop !== undefined)
    checks.push(['call count', c.expectDrop ? p2.callInsts < p0.callInsts : p2.callInsts >= p0.callInsts,
      `O0=${p0.callInsts} O2=${p2.callInsts} expectDrop=${c.expectDrop}`]);
  if (c.callsO0 !== undefined) checks.push(['O0 calls', p0.callInsts === c.callsO0, `got ${p0.callInsts} want ${c.callsO0}`]);
  if (c.callsO2 !== undefined) checks.push(['O2 calls', p2.callInsts === c.callsO2, `got ${p2.callInsts} want ${c.callsO2}`]);
  if (c.expectLicm) checks.push(['licm fired', p2.licmChanged > 0, `licmChanged=${p2.licmChanged}`]);
  const pass = checks.every((k) => k[1]);
  if (pass) ok++; else bad++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${c.name}  calls ${p0.callInsts}->${p2.callInsts}`);
  for (const [what, good, detail] of checks) if (!good) console.log(`       - ${what}: ${detail}`);
}
console.log(`\n${ok}/${ok + bad} activity/classification checks pass`);

const seeds = [];
for (let s = 1; s <= 240; s++) seeds.push((s * 2654435761) >>> 0);
const fr = await fuzz(seeds, [0, 1, 2, 3]);
console.log(`\nfuzz: ${fr.pass}/${fr.total} differential checks pass across -O0..-O3 (${seeds.length} random programs; GVN pure-call CSE fired in ${fr.firedGvn}, LICM pure-call hoist in ${fr.firedLicm} of the -O2/-O3 compiles)`);
if (fr.failures.length) { console.log('\nFAILURES:'); for (const f of fr.failures.slice(0, 30)) console.log(`  seed ${f.seed} -O${f.level}: ${f.detail}`); }
if (bad || fr.failures.length) process.exit(1);
