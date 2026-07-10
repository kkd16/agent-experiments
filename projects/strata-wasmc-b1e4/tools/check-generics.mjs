// Generics check harness. Three things the main differential harness can't show
// on its own:
//   1. INSTANTIATION STRUCTURE — that the monomorphizer really did stamp out the
//      expected set of concrete clones (mangled `name$T…`), one per instantiation,
//      and dropped the templates.
//   2. THE SAFETY PROPERTY — a program that instantiates a generic at a type its
//      body can't support (e.g. `a + b` on a struct) must be REJECTED with a clean
//      compile error, never silently miscompiled. This drives the error paths.
//   3. GENERIC ≡ HAND-WRITTEN — a generic program and its by-hand monomorphic twin
//      compile to the same output at every level.
//
// Run with:  node tools/check-generics.mjs   (after `pnpm install`)
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.genharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_genentry.js'), formats: ['es'], fileName: 'genharness' },
    rollupOptions: { output: { entryFileNames: 'genharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'genharness.mjs')).href);
const { parse, monomorphize, typecheck, interpret, compile, runWasm } = mod;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass++; console.log(`ok   ${name}  ${detail}`); } else { fail++; console.log(`FAIL ${name}  ${detail}`); } };

const fnNames = (src) => monomorphize(parse(src)).decls.filter((d) => d.kind === 'fn').map((d) => d.name);

// --- 1. instantiation structure -------------------------------------------
{
  const src = `fn maxT<T>(a: T, b: T) -> T { if (a > b) { return a; } return b; }
fn main() { print(maxT(1, 2)); print(maxT(1.0, 2.0)); print(maxT(9L, 3L)); print(maxT(2, 1)); }`;
  const names = fnNames(src);
  ok('3-instantiations-dedup', ['maxT$int', 'maxT$float', 'maxT$long'].every((n) => names.includes(n)) && names.filter((n) => n.startsWith('maxT$')).length === 3, names.join(','));
  ok('template-dropped', !names.includes('maxT'), names.join(','));
}
{
  // transitive: clamp<int> pulls in minT<int>, maxT<int>.
  const src = `fn maxT<T>(a: T, b: T) -> T { if (a > b) { return a; } return b; }
fn minT<T>(a: T, b: T) -> T { if (a < b) { return a; } return b; }
fn clamp<T>(x: T, lo: T, hi: T) -> T { return minT(maxT(x, lo), hi); }
fn main() { print(clamp(5, 0, 9)); }`;
  const names = fnNames(src);
  ok('transitive-instantiation', ['clamp$int', 'minT$int', 'maxT$int'].every((n) => names.includes(n)), names.join(','));
}
{
  // struct type argument mangles into the clone name.
  const src = `struct Box { v: int; }
fn firstOf<T>(a: T, b: T) -> T { return a; }
fn main() { let p = firstOf(Box(1), Box(2)); print(p.v); print(firstOf(3, 4)); }`;
  const names = fnNames(src);
  ok('struct-and-int-clones', names.includes('firstOf$s_Box') && names.includes('firstOf$int'), names.join(','));
}
{
  // an uninstantiated generic emits no code at all.
  const src = `fn unused<T>(a: T) -> T { return a; }
fn main() { print(1); }`;
  const names = fnNames(src);
  ok('uninstantiated-emits-nothing', names.length === 1 && names[0] === 'main', names.join(','));
}

// --- 2. the safety property: bad instantiations are REJECTED ---------------
const rejects = [
  ['duck-typed-add-on-struct', `struct Box { v: int; }
fn addT<T>(a: T, b: T) -> T { return a + b; }
fn main() { let p = addT(Box(1), Box(2)); print(p.v); }`, /numeric|string|requires/i],
  ['cannot-infer-from-null', `fn id<T>(x: T) -> T { return x; }
fn main() { print(id(null)); }`, /cannot infer/i],
  ['unused-type-param', `fn f<T>(x: int) -> int { return x; }
fn main() { print(f(1)); }`, /never used/i],
  ['main-generic', `fn main<T>() { print(1); }`, /main.*cannot be generic/i],
  ['generic-as-value', `fn id<T>(x: T) -> T { return x; }
fn apply(f: fn(int) -> int, x: int) -> int { return f(x); }
fn main() { print(apply(id, 3)); }`, /as a value/i],
  ['conflicting-type-args', `fn pair<T>(a: T, b: T) -> T { return a; }
fn main() { print(pair(1, 2.0)); }`, /conflicting/i],
  ['arity-mismatch', `fn f<T>(a: T, b: T) -> T { return a; }
fn main() { print(f(1)); }`, /expects 2 argument/i],
  ['reserved-type-param', `fn f<int>(a: int) -> int { return a; }
fn main() { print(f(1)); }`, /built-in type/i],
  ['duplicate-type-param', `fn f<T, T>(a: T) -> T { return a; }
fn main() { print(f(1)); }`, /duplicate type parameter/i],
  ['empty-type-params', `fn f<>(a: int) -> int { return a; }
fn main() { print(f(1)); }`, /at least one type parameter/i],
];
for (const [name, src, re] of rejects) {
  const c = compile(src, 0);
  ok(`reject:${name}`, !c.ok && re.test(c.error?.message ?? ''), c.ok ? 'COMPILED (should have failed)' : c.error.message.slice(0, 60));
}

// --- 3. generic ≡ hand-written monomorphic twin ----------------------------
{
  const generic = `fn maxT<T>(a: T, b: T) -> T { if (a > b) { return a; } return b; }
fn main() { print(maxT(3, 9)); print(maxT(2.5, 1.5)); }`;
  const byHand = `fn maxI(a: int, b: int) -> int { if (a > b) { return a; } return b; }
fn maxF(a: float, b: float) -> float { if (a > b) { return a; } return b; }
fn main() { print(maxI(3, 9)); print(maxF(2.5, 1.5)); }`;
  for (const lvl of [0, 3]) {
    const g = compile(generic, lvl), h = compile(byHand, lvl);
    const gr = g.ok ? (await runWasm(g.bytes)).output : ['<err>'];
    const hr = h.ok ? (await runWasm(h.bytes)).output : ['<err>'];
    const mp = monomorphize(parse(generic));
    typecheck(mp); // the interpreter reads the type annotations the checker writes
    const ref = interpret(mp).output;
    ok(`equiv-hand-written -O${lvl}`, JSON.stringify(gr) === JSON.stringify(hr) && JSON.stringify(gr) === JSON.stringify(ref), gr.join('|'));
  }
}

console.log(`\n${pass}/${pass + fail} generics checks pass`);
if (fail) process.exit(1);
