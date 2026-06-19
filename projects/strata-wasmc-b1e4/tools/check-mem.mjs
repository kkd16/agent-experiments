// Memory-optimization check harness. For a battery of memory-heavy programs it:
//   1. compiles the real WebAssembly at -O0 and -O3 and runs both, plus the
//      reference interpreter, asserting all three outputs agree (the differential
//      contract — store→load forwarding / RLE / DSE must never change behaviour),
//   2. counts `i32/i64/f64/f32` load+store opcodes in the emitted WAT at each
//      level and reports how many memory accesses the pass removed.
//
// Run with:  node tools/check-mem.mjs   (after `pnpm install`)
import { build } from 'vite';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../node_modules/.memharness');

await build({
  configFile: false,
  logLevel: 'error',
  build: {
    ssr: true,
    outDir,
    emptyOutDir: true,
    lib: { entry: resolve(here, '_mementry.js'), formats: ['es'], fileName: 'memharness' },
    rollupOptions: { output: { entryFileNames: 'memharness.mjs' } },
    minify: false,
    target: 'node20',
  },
});
const mod = await import(pathToFileURL(resolve(outDir, 'memharness.mjs')).href);
const { parse, typecheck, interpret, compile, runWasm } = mod;

const countMem = (wat) => {
  const loads = (wat.match(/\.(load|load8_[us])\b/g) ?? []).length;
  const stores = (wat.match(/\.(store|store8)\b/g) ?? []).length;
  return { loads, stores, total: loads + stores };
};

// Programs that exercise forwarding, RLE and DSE — and the conservative cases
// (aliasing across distinct bases, a clobbering call) that must NOT be broken.
const PROGRAMS = [
  {
    name: 'struct-rmw-chain',
    src: `struct Box { v: int; }
fn main() {
  let b = Box(0);
  b.v = b.v + 1;   // load v, store v
  b.v = b.v + 10;  // load v -> forwarded, store v
  b.v = b.v + 100; // load v -> forwarded, store v
  print(b.v);      // load v -> forwarded
}`,
  },
  {
    name: 'dead-store-overwrite',
    src: `struct P { x: int; y: int; }
fn main() {
  let p = P(1, 2);   // stores x=1, y=2 ...
  p.x = 7;           // x=1 is dead
  p.y = 9;           // y=2 is dead
  print(p.x + p.y);  // both loads forwarded -> prints 16
}`,
  },
  {
    name: 'redundant-loads',
    src: `struct V3 { x: int; y: int; z: int; }
fn dot(a: V3) -> int { return a.x*a.x + a.y*a.y + a.z*a.z; }
fn main() {
  let a = V3(2, 3, 4);
  print(dot(a)); print(dot(a));
}`,
  },
  {
    name: 'array-readback',
    src: `fn main() {
  let a = int_array(4);
  a[0] = 10; a[1] = 20; a[2] = 30; a[3] = 40;
  let s = 0;
  s = s + a[0] + a[0];   // a[0] loaded twice -> RLE
  s = s + a[2] + a[2];
  print(s);
}`,
  },
  {
    name: 'alias-distinct-bases',
    src: `struct C { v: int; }
fn bump(c: C) { c.v = c.v + 1; }
fn main() {
  let a = C(5);
  let b = C(50);
  a.v = a.v + 1;   // store a.v
  b.v = b.v + 1;   // store b.v (different base — must not corrupt a.v fact)
  bump(a);         // a CALL: clobbers all memory facts
  print(a.v + b.v);
}`,
  },
  {
    name: 'call-barrier',
    src: `struct C { v: int; }
fn read(c: C) -> int { return c.v; }
fn main() {
  let c = C(3);
  c.v = 99;            // store
  print(read(c));      // the call may read it — store is NOT dead, load not forwarded
  print(c.v);          // after the call, must re-load
}`,
  },
  {
    name: 'branch-forward',
    src: `struct B { v: int; }
fn main() {
  let b = B(0);
  b.v = 41;
  let k = 0;
  if (k == 0) { b.v = 42; } else { b.v = 43; }
  print(b.v);   // value differs per arm — not forwardable past the merge
}`,
  },
  {
    name: 'linked-list',
    src: `struct N { v: int; next: N; }
fn sum(head: N) -> int {
  let s = 0;
  let cur = head;
  while (cur != null) { s = s + cur.v; cur = cur.next; }
  return s;
}
fn main() {
  let c = N(3, null);
  let b = N(2, c);
  let a = N(1, b);
  print(sum(a));
}`,
  },
];

let fail = 0;
let totalSaved = 0;
for (const p of PROGRAMS) {
  parse(p.src);
  typecheck(parse(p.src));
  const ref = interpret(parse(p.src));
  const c0 = compile(p.src, 0);
  const c3 = compile(p.src, 3);
  const r0 = await runWasm(c0.bytes);
  const r3 = await runWasm(c3.bytes);
  const refOut = JSON.stringify(ref.output);
  const ok = JSON.stringify(r0.output) === refOut && JSON.stringify(r3.output) === refOut;
  const m0 = countMem(c0.wat);
  const m3 = countMem(c3.wat);
  const saved = m0.total - m3.total;
  totalSaved += Math.max(0, saved);
  const memPass = c3.optLog?.find((l) => l.name.startsWith('mem-opt'))?.changed ?? 0;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${p.name.padEnd(22)} ` +
      `mem(O0)=${String(m0.total).padStart(2)}  mem(O3)=${String(m3.total).padStart(2)}  ` +
      `removed=${String(saved).padStart(2)}`,
  );
  if (!ok) {
    fail++;
    console.log(`     ref:  ${refOut}`);
    console.log(`     O0:   ${JSON.stringify(r0.output)}`);
    console.log(`     O3:   ${JSON.stringify(r3.output)}`);
  }
}
console.log(`\n${fail === 0 ? 'all programs agree' : fail + ' FAILURES'} — total memory accesses removed at -O3: ${totalSaved}`);
process.exit(fail === 0 ? 0 : 1);
