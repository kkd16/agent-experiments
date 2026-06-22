// Aether — headless semantic harness.
//
// Runs Aether programs through the real pipeline (lexer → parser → HM inference
// → dictionary-passing elaboration → bytecode VM), and the JavaScript backend,
// asserting the two backends agree byte-for-byte. Used during development to
// guard the language against regressions; run with:
//   node --experimental-strip-types tools/harness.mjs
import { runPipeline } from '../src/lang/pipeline.ts'
import { compileToJs, runJsModule } from '../src/lang/jsBackend.ts'
import { runWasm, compileWasm } from '../src/wasm/run.ts'
import { disassemble } from '../src/wasm/disasm.ts'
import { valueToString } from '../src/lang/values.ts'
import { EXAMPLES } from '../src/examples.ts'
import { runSuite } from '../src/lang/testSuite.ts'
import { runPropertySuite } from '../src/lang/propertySuite.ts'

let pass = 0
let fail = 0
const failures = []

function record(name, ok, detail) {
  if (ok) {
    pass++
  } else {
    fail++
    failures.push(`${name}: ${detail}`)
  }
}

/** Run a program; assert it type-checks, produces `type`/`value`/`output`, and JS≡VM. */
export function check(name, src, expect = {}) {
  const r = runPipeline(src, { execute: true })
  if (expect.error) {
    record(name, !!r.error && (r.error.message.includes(expect.error)), `expected error ~"${expect.error}", got ${r.error ? r.error.message : 'no error'}`)
    return
  }
  if (r.error) {
    record(name, false, `unexpected ${r.error.stage} error: ${r.error.message}`)
    return
  }
  if (expect.type !== undefined) {
    record(name + ' [type]', r.programType === expect.type, `type was "${r.programType}", expected "${expect.type}"`)
  }
  const vmVal = r.run && r.run.result ? valueToString(r.run.result) : null
  if (expect.value !== undefined) {
    record(name + ' [value]', vmVal === expect.value, `value was "${vmVal}", expected "${expect.value}"`)
  }
  if (expect.output !== undefined) {
    const out = r.run ? r.run.output.join('\n') : ''
    record(name + ' [output]', out === expect.output, `output was ${JSON.stringify(out)}, expected ${JSON.stringify(expect.output)}`)
  }
  // JS ≡ VM equivalence on the *optimized* elaborated core (what ships)
  if (r.optimizedCoreAst && !expect.skipJs) {
    const mod = compileToJs(r.optimizedCoreAst)
    const js = runJsModule(mod.full)
    if (js.error) {
      record(name + ' [js≡vm]', false, `JS backend error: ${js.error}`)
    } else {
      const sameResult = js.result === vmVal
      const sameOut = (r.run ? r.run.output.join('\n') : '') === js.output.join('\n')
      record(name + ' [js≡vm]', sameResult && sameOut, `JS result "${js.result}" out ${JSON.stringify(js.output)} vs VM "${vmVal}" out ${JSON.stringify(r.run ? r.run.output : [])}`)
    }
  }
}

// All gallery examples must type-check, run, and match across backends.
for (const ex of EXAMPLES) {
  check('example:' + ex.id, ex.code, {})
}

// The in-app self-test suite (core language, type classes, higher-kinded
// classes, error cases) — each value-producing case also asserts JS ≡ VM.
for (const r of runSuite()) {
  record(`suite:${r.group}/${r.name}`, r.ok, r.detail)
  if (r.jsMatch === false) record(`suite:${r.group}/${r.name} [js≡vm]`, false, 'JS backend disagreed with VM')
}

// The property-engine self-tests (generators, shrinking, do-desugaring).
for (const r of runPropertySuite()) {
  record(`property:${r.name}`, r.ok, r.detail)
}

// A focused higher-kinded battery: real Functor/Applicative/Monad, polymorphic
// monadic combinators at multiple instances, superclass entailment & projection,
// the State monad, and the kind-/instance-error cases.
const HKT_PRELUDE = `type Option a = None | Some a in
class Functor f where fmap : (a -> b) -> f a -> f b in
class Functor f => Applicative f where pure : a -> f a, ap : f (a -> b) -> f a -> f b in
class Applicative m => Monad m where bind : m a -> (a -> m b) -> m b in
instance Functor Option where fmap = fn g x -> match x with None -> None | Some v -> Some (g v) in
instance Applicative Option where pure = fn x -> Some x, ap = fn mf mx -> match mf with None -> None | Some f -> fmap f mx in
instance Monad Option where bind = fn m k -> match m with None -> None | Some x -> k x in
instance Functor List where fmap = fn g xs -> map g xs in
instance Applicative List where pure = fn x -> [x], ap = fn fs xs -> concat (map (fn f -> map f xs) fs) in
instance Monad List where bind = fn m k -> concat (map k m) in
`
check('hkt:fmap option', HKT_PRELUDE + 'fmap (fn x -> x + 1) (Some 41)', { value: 'Some 42' })
check('hkt:ap option', HKT_PRELUDE + 'ap (Some (fn x -> x * 2)) (Some 21)', { value: 'Some 42' })
check('hkt:bind list', HKT_PRELUDE + 'bind [1, 2, 3] (fn x -> [x, x])', { value: '[1, 1, 2, 2, 3, 3]' })
check(
  'hkt:polymorphic mapM at Option and List',
  HKT_PRELUDE +
    `let rec mapM = fn f xs -> if empty xs then pure []
      else do { y <- f (head xs) ; ys <- mapM f (tail xs) ; pure (y :: ys) } in
     ( mapM (fn x -> if x > 0 then Some x else None) [1, 2, 3]
     , mapM (fn x -> if x > 0 then Some x else None) [1, 0, 3]
     , mapM (fn x -> [x, 0 - x]) [1, 2] )`,
  { value: '(Some [1, 2, 3], None, [[1, 2], [1, -2], [-1, 2], [-1, -2]])' },
)
check(
  'hkt:superclass entailment uses fmap via Monad',
  HKT_PRELUDE + 'let f = fn mx -> bind mx (fn x -> fmap (fn y -> y + 100) (pure x)) in (f (Some 5), f [1, 2])',
  { value: '(Some 105, [101, 102])' },
)
check(
  'hkt:State monad',
  `type State s a = State (s -> (a, s)) in
   let runState = fn st s -> match st with State f -> f s in
   class Functor f where fmap : (a -> b) -> f a -> f b in
   class Functor f => Applicative f where pure : a -> f a, ap : f (a -> b) -> f a -> f b in
   class Applicative m => Monad m where bind : m a -> (a -> m b) -> m b in
   instance Functor (State s) where fmap = fn g st -> State (fn s0 -> match runState st s0 with (a, s1) -> (g a, s1)) in
   instance Applicative (State s) where pure = fn x -> State (fn s0 -> (x, s0)), ap = fn stf stx -> State (fn s0 -> match runState stf s0 with (f, s1) -> match runState stx s1 with (x, s2) -> (f x, s2)) in
   instance Monad (State s) where bind = fn m k -> State (fn s0 -> match runState m s0 with (a, s1) -> runState (k a) s1) in
   let tick = State (fn n -> (n, n + 1)) in
   let rec number = fn xs -> if empty xs then pure []
     else do { i <- tick ; rest <- number (tail xs) ; pure ((i, head xs) :: rest) } in
   runState (number [10, 20, 30]) 0`,
  { value: '([(0, 10), (1, 20), (2, 30)], 3)' },
)
// kind- and instance-error cases must be rejected
check('hkt:reject Monad Int (kind)', 'class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in instance Monad Int where pure = fn x -> x, bind = fn m k -> k m in 0', { error: 'kind' })
check('hkt:reject inconsistent param kind', 'class Bad m where one : m, two : m Int -> Int in 0', { error: 'kind' })
check('hkt:reject missing superclass instance', 'type Box a = Box a in class Functor f where fmap : (a -> b) -> f a -> f b in class Functor m => Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in instance Monad Box where pure = fn x -> Box x, bind = fn m k -> match m with Box x -> k x in 0', { error: 'Functor Box' })

// A focused `deriving` battery: every synthesised method's behaviour, JS≡VM
// throughout, and the rejection cases. Leaf primitives use hand-written base
// instances; everything structural/parametric/recursive is derived.
const DERIVE_PRELUDE = `let primShow = show in
class Eq a   where eq      : a -> a -> Bool in
class Ord a  where compare : a -> a -> Int  in
class Show a where show    : a -> String    in
instance Eq Int   where eq      = fn a b -> a == b in
instance Ord Int  where compare = fn a b -> if a < b then -1 else if a == b then 0 else 1 in
instance Show Int where show    = primShow in
`
check('derive:Eq recursive true', DERIVE_PRELUDE + 'type T a = L a | N (T a) (T a) deriving (Eq) in eq (N (L 1) (L 2)) (N (L 1) (L 2))', { value: 'true' })
check('derive:Eq recursive false', DERIVE_PRELUDE + 'type T a = L a | N (T a) (T a) deriving (Eq) in eq (N (L 1) (L 2)) (N (L 1) (L 9))', { value: 'false' })
check('derive:Eq inferred context', DERIVE_PRELUDE + 'type P a b = P a b deriving (Eq) in eq (P 1 2) (P 1 3)', { value: 'false' })
check('derive:Ord fields then ctor order', DERIVE_PRELUDE + 'type T = A | B Int Int | C deriving (Ord) in (compare A (B 0 0), compare (B 1 2) (B 1 3), compare (B 9 9) A, compare (B 4 5) (B 4 5))', { value: '(-1, -1, 1, 0)' })
check('derive:Show nullary + applied', DERIVE_PRELUDE + 'type T = Tip | Bin T Int T deriving (Show) in show (Bin Tip 7 (Bin Tip 8 Tip))', { value: '"(Bin Tip 7 (Bin Tip 8 Tip))"' })
check('derive:Enum round-trip', 'class Enum a where fromEnum : a -> Int, toEnum : Int -> a in type C = X | Y | Z deriving (Enum) in let z = head (toEnum 2 :: [X]) in fromEnum z', { value: '2' })
check('derive:Bounded min/max', 'class Enum a where fromEnum : a -> Int, toEnum : Int -> a in class Bounded a where minBound : a, maxBound : a in type C = X | Y | Z deriving (Enum, Bounded) in (fromEnum (max X minBound), fromEnum (max Z maxBound))', { value: '(0, 2)' })
check('derive:Functor list+tuple+nullary', 'class Functor f where fmap : (a -> b) -> f a -> f b in type W a = W (List a) (a, a) | E deriving (Functor) in let w = W [1, 2] (3, 4) in match fmap (fn x -> x + 10) w with W xs p -> (xs, p) | E -> ([], (0, 0))', { value: '([11, 12], (13, 14))' })
check('derive:Functor fixes earlier params', 'class Functor f where fmap : (a -> b) -> f a -> f b in type P k a = P k a deriving (Functor) in match fmap (fn x -> x * 2) (P "key" 21) with P k v -> (k, v)', { value: '("key", 42)' })
check('derive:Foldable tree in-order', 'class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in type T a = L | N (T a) a (T a) deriving (Foldable) in foldr (fn x acc -> x :: acc) [] (N (N L 1 L) 2 (N L 3 L))', { value: '[1, 2, 3]' })
check('derive:Foldable list+tuple fields', 'class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in type W a = W (List a) (a, a) | E deriving (Foldable) in foldr (fn x acc -> x + acc) 0 (W [1, 2, 3] (4, 5))', { value: '15' })
check('derive:Functor+Foldable cooperate', 'class Functor f where fmap : (a -> b) -> f a -> f b in class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in type T a = L | N (T a) a (T a) deriving (Functor, Foldable) in foldr (fn x acc -> x + acc) 0 (fmap (fn x -> x * x) (N (N L 1 L) 2 (N L 3 L)))', { value: '14' })
// rejection cases
check('derive:reject Foldable nested-in-list', 'class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in type R a = R a (List (R a)) deriving (Foldable) in 0', { error: 'Foldable' })
check('derive:reject non-derivable', 'type T = A deriving (Functor2) in 0', { error: 'derive' })
check('derive:reject Enum with fields', 'class Enum a where fromEnum : a -> Int, toEnum : Int -> a in type T = A Int deriving (Enum) in 0', { error: 'Enum' })
check('derive:reject Functor nullary', 'class Functor f where fmap : (a -> b) -> f a -> f b in type T = A | B deriving (Functor) in 0', { error: 'Functor' })
check('derive:reject duplicate in clause', 'class Eq a where eq : a -> a -> Bool in type T = A deriving (Eq, Eq) in 0', { error: 'duplicate' })

// ---------------------------------------------------------------------------
// WebAssembly backend battery — the third compilation target. Each program is
// compiled to a real `.wasm` module, instantiated under Node's `WebAssembly`,
// run, and asserted equal to the bytecode VM (result + output + draw count).
// ---------------------------------------------------------------------------

/** Compile + instantiate + run on the WASM backend; assert WASM ≡ VM. */
async function checkWasm(name, src) {
  const r = runPipeline(src, { execute: true })
  if (r.error) {
    record('wasm:' + name, false, `pipeline error: ${r.error.message}`)
    return
  }
  const vm = r.run && r.run.result ? valueToString(r.run.result) : null
  const vmOut = r.run ? r.run.output.join('\n') : ''
  const vmEff = r.run ? r.run.effects.length : 0
  try {
    const w = await runWasm(r.optimizedCoreAst)
    if (w.error) {
      record('wasm:' + name, false, `WASM runtime error: ${w.error}`)
      return
    }
    const same = w.result === vm && w.output.join('\n') === vmOut && w.effects.length === vmEff
    record(
      'wasm:' + name,
      same,
      `WASM result "${w.result}" out ${JSON.stringify(w.output)} eff ${w.effects.length} vs VM "${vm}" out ${JSON.stringify(r.run ? r.run.output : [])} eff ${vmEff}`,
    )
  } catch (e) {
    record('wasm:' + name, false, `WASM threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Every gallery example must compile to WebAssembly and match the VM exactly.
for (const ex of EXAMPLES) {
  await checkWasm('example:' + ex.id, ex.code)
}

// A focused feature battery exercising each lowering path on the WASM backend.
await checkWasm('int arithmetic + wraparound', '(7 * 6, 100 / 7, 100 % 7, 0 - 5, 2147483647 + 1)')
await checkWasm('float arithmetic', '(3.0 +. 4.0, 1.0 /. 4.0, sqrt 2.0, pi *. 2.0)')
await checkWasm('closures & currying', 'let add = fn a b c -> a + b + c in let f = add 1 2 in f 39')
await checkWasm('higher-order prelude', 'foldl (fn a x -> a + x) 0 (map (fn x -> x * x) (filter (fn x -> x % 2 == 0) (range 1 11)))')
await checkWasm('deep recursion (tail)', 'let rec go = fn n acc -> if n == 0 then acc else go (n - 1) (acc + 1) in go 100000 0')
await checkWasm('mutual recursion', 'let rec ev = fn n -> if n == 0 then true else od (n - 1) and od = fn n -> if n == 0 then false else ev (n - 1) in (ev 1000, od 1000)')
await checkWasm('ADT + match + guards', 'type T a = L | N (T a) a (T a) in let rec mx = fn t -> match t with L -> 0 - 1000 | N l v r -> let a = mx l in let b = mx r in if v > a then (if v > b then v else b) else (if a > b then a else b) in mx (N (N L 3 L) 7 (N L 5 L))')
await checkWasm('records + update + row poly', 'let r = { x = 1, y = 2, z = 3 } in let bump = fn rr -> { rr | x = rr.x + 10 } in let s = bump r in (s.x, s.y, s.z, r.x)')
await checkWasm('strings + show', 'type Opt a = None | Some a in let greet = fn n -> "hello, " ^ n ^ "!" in (greet "wasm", show [Some 1, None], strlen "abcd", toUpper "abc")')
await checkWasm('nested let rec closure (knot)', 'let count = fn n -> let rec go = fn i -> if i >= n then [] else i :: go (i + 1) in go 0 in count 5')
await checkWasm('list comprehension', '[ (x, y) | x <- range 1 4, y <- range 1 4, x + y == 4 ]')
await checkWasm('print output ordering', 'let _ = print "a" in let _ = print 1 in let _ = print [1, 2] in print "z"')
await checkWasm('polymorphic compare on ADTs', 'type C = Red | Green | Blue in (Red == Red, Red == Blue, min Green Blue, [1,2,3] == [1,2,3])')

// ---------------------------------------------------------------------------
// WAT disassembler battery — the from-scratch binary *decoder* (the mirror of
// the encoder). Every module we emit must round-trip to well-formed WAT: no
// unrecognised opcodes, balanced parens, one named `(func …)` per defined
// function, and a populated `name` section (no anonymous `funcN` fallbacks).
// ---------------------------------------------------------------------------

function checkDisasm(name, src) {
  const r = runPipeline(src, { execute: true })
  if (r.error) {
    record('disasm:' + name, false, `pipeline error: ${r.error.message}`)
    return
  }
  let mod
  try {
    mod = compileWasm(r.coreAst)
  } catch (e) {
    record('disasm:' + name, false, `compile threw: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  let wat
  try {
    wat = disassemble(mod.bytes)
  } catch (e) {
    record('disasm:' + name, false, `disassemble threw: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const problems = []
  if (wat.unknown !== 0) problems.push(`${wat.unknown} unknown opcode(s)`)
  if (wat.text.includes(';; unknown')) problems.push('a ;; unknown marker leaked into the WAT')
  // one rendered (func …) per defined function in the module
  if (wat.funcs.length !== mod.stats.funcCount)
    problems.push(`rendered ${wat.funcs.length} funcs but the module defines ${mod.stats.funcCount}`)
  // every function resolved a real name from the `name` section
  const anon = wat.funcs.filter((f) => /^func\d+$/.test(f.name))
  if (anon.length) problems.push(`${anon.length} function(s) fell back to an anonymous name`)
  // balanced parentheses across the whole module text
  let depth = 0
  for (const ch of wat.text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (depth < 0) break
  }
  if (depth !== 0) problems.push(`unbalanced parens (final depth ${depth})`)
  if (!wat.text.startsWith('(module')) problems.push('text does not open with (module')
  // the named runtime helpers and the entry point must be present
  for (const want of ['$__alloc', '$apply', '$boxInt', '$main', 'global.get $heap']) {
    if (!wat.text.includes(want)) problems.push(`missing ${want} in the disassembly`)
  }
  record('disasm:' + name, problems.length === 0, problems.join('; '))
}

for (const ex of EXAMPLES) checkDisasm('example:' + ex.id, ex.code)
checkDisasm('fib (named recursion)', 'let rec fib = fn n -> if n < 2 then n else fib (n - 1) + fib (n - 2) in fib 12')
checkDisasm('floats + memargs', '(3.0 +. 4.0, sqrt 2.0, pi)')
checkDisasm('records + match + strings', 'type O a = N | S a in let r = { x = 1 } in (r.x, show (S 1), "a" ^ "b")')

// ---------------------------------------------------------------------------
// Small-integer cache — the measured runtime win. It must (a) preserve
// WASM ≡ VM (already covered above for correctness) and (b) actually *serve*
// integers from the shared cache, cutting real allocations.
// ---------------------------------------------------------------------------

async function checkCache(name, src, expectResult, minHits) {
  const r = runPipeline(src, { execute: true })
  if (r.error) {
    record('cache:' + name, false, `pipeline error: ${r.error.message}`)
    return
  }
  const vm = r.run && r.run.result ? valueToString(r.run.result) : null
  try {
    const w = await runWasm(r.coreAst)
    const problems = []
    if (w.error) problems.push(`runtime error: ${w.error}`)
    if (w.result !== vm) problems.push(`WASM "${w.result}" ≠ VM "${vm}"`)
    if (expectResult !== undefined && w.result !== expectResult) problems.push(`result "${w.result}" ≠ "${expectResult}"`)
    if (!w.heap) problems.push('no heap accounting exported')
    else {
      // every cache hit is an integer box the bump allocator did *not* have to make,
      // so hits are allocations saved: assert the cache carried real, measurable weight.
      if (w.heap.cacheHits < minHits) problems.push(`only ${w.heap.cacheHits} cache hits (< ${minHits})`)
      if (w.heap.allocCount <= 0) problems.push('allocCount did not advance')
    }
    record('cache:' + name, problems.length === 0, problems.join('; '))
  } catch (e) {
    record('cache:' + name, false, `threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

await checkCache('range fold (counter-heavy)', 'foldl (fn a x -> a + x) 0 (range 0 500)', '124750', 500)
await checkCache('nested loop indices', 'sum [ x | x <- range 0 100, y <- range 0 10, x % 7 == 0 ]', undefined, 200)

// ---------------------------------------------------------------------------
// Garbage collector (Aether 9.0). The headline correctness proof: re-run the
// whole WASM corpus in STRESS mode — a full mark-sweep collection before EVERY
// allocation — and assert byte-for-byte agreement with the non-stressed run. A
// single missing root would sweep a live object and the answer would diverge.
// ---------------------------------------------------------------------------

/** Run `src` with and without GC stress; assert identical result + output, and
 *  that stress mode actually collected (the sweep path really executed). */
async function checkGcStress(name, src) {
  const r = runPipeline(src, { execute: false })
  if (r.error) {
    record('gc:' + name, false, `pipeline error: ${r.error.message}`)
    return
  }
  try {
    const plain = await runWasm(r.coreAst)
    const stressed = await runWasm(r.coreAst, { stress: true })
    const problems = []
    if (plain.error) problems.push(`plain error: ${plain.error}`)
    if (stressed.error) problems.push(`stress error: ${stressed.error}`)
    if (plain.result !== stressed.result) problems.push(`result drift: plain "${plain.result}" ≠ stress "${stressed.result}"`)
    if (plain.output.join('\n') !== stressed.output.join('\n')) problems.push('output drift under stress')
    if (stressed.heap && stressed.heap.collections <= 0) problems.push('stress mode never collected')
    record('gc:' + name, problems.length === 0, problems.join('; '))
  } catch (e) {
    record('gc:' + name, false, `threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Every gallery example, collected before every allocation, must still agree.
for (const ex of EXAMPLES) await checkGcStress('example:' + ex.id, ex.code)
// Allocation-shaped feature programs (lists, ADTs, records, closures, strings).
await checkGcStress('list build + map + filter + fold', 'foldl (fn a x -> a + x) 0 (map (fn x -> x * x) (filter (fn x -> x % 2 == 0) (range 1 60)))')
await checkGcStress('recursive ADT build + fold', 'type T a = L | N (T a) a (T a) in let rec mk = fn n -> if n == 0 then L else N (mk (n-1)) n (mk (n-1)) in let rec sz = fn t -> match t with L -> 0 | N l v r -> 1 + sz l + sz r in sz (mk 8)')
await checkGcStress('record update churn', 'let r = { x = 1, y = 2 } in let bump = fn rr -> { rr | x = rr.x + 1 } in (foldl (fn a _ -> bump a) r (range 0 40)).x')
await checkGcStress('string concat + show', 'foldl (fn a x -> a ^ show x) "" (range 0 30)')
await checkGcStress('comprehension + tuples', '[ (x, y) | x <- range 1 12, y <- range 1 12, x + y == 10 ]')
await checkGcStress('mutual recursion under stress', 'let rec ev = fn n -> if n == 0 then true else od (n - 1) and od = fn n -> if n == 0 then false else ev (n - 1) in (ev 300, od 300)')

/** A long allocator loop must keep a *bounded* heap: the collector reclaims the
 *  garbage so the peak stays far below the total bytes ever handed out. */
async function checkGcReclaims(name, src, expect) {
  const r = runPipeline(src, { execute: false })
  if (r.error) {
    record('gc:' + name, false, `pipeline error: ${r.error.message}`)
    return
  }
  try {
    const w = await runWasm(r.coreAst)
    const problems = []
    if (w.error) problems.push(`error: ${w.error}`)
    if (expect !== undefined && w.result !== expect) problems.push(`result "${w.result}" ≠ "${expect}"`)
    if (!w.heap) problems.push('no heap accounting')
    else {
      if (w.heap.collections <= 0) problems.push('never collected')
      if (w.heap.reclaimed <= 0) problems.push('reclaimed nothing')
      if (w.heap.reuse <= 0) problems.push('never reused a freed cell')
      // peak heap must be a small fraction of the total bytes ever allocated
      if (w.heap.peakHeap * 4 > w.heap.allocBytes) {
        problems.push(`peak ${w.heap.peakHeap} not ≪ total ${w.heap.allocBytes} (memory not reclaimed)`)
      }
    }
    record('gc:' + name, problems.length === 0, problems.join('; '))
  } catch (e) {
    record('gc:' + name, false, `threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

await checkGcReclaims(
  'bounded peak over a long allocator loop',
  'let rec loop = fn n acc -> if n == 0 then acc else loop (n - 1) (acc + sum (range 0 80)) in loop 4000 0',
  '12640000',
)

// ---------------------------------------------------------------------------
// Optimizing middle-end battery — the headline of Aether 10.0. For each program
// we run the pipeline twice (optimizer on / off) and assert:
//   • identical result, identical printed output, identical effect (draw) count
//   • the optimizer never *increases* VM steps
//   • where stated, a minimum number of rewrites fire and/or the optimized core
//     shrinks below a node budget (the abstraction provably melts away)
// Because the JS/WASM batteries above already compile the *optimized* core, this
// closes the loop: same answer on all three backends, demonstrably less work.
// ---------------------------------------------------------------------------

function nodeCount(e) {
  if (!e) return 0
  const kids = []
  switch (e.kind) {
    case 'lambda': kids.push(e.body); break
    case 'app': kids.push(e.fn, e.arg); break
    case 'let': kids.push(e.value, e.body); break
    case 'if': kids.push(e.cond, e.then, e.else); break
    case 'binop': kids.push(e.left, e.right); break
    case 'unop': kids.push(e.operand); break
    case 'list': case 'tuple': kids.push(...e.elements); break
    case 'seq': kids.push(e.first, e.rest); break
    case 'match': kids.push(e.scrutinee, ...e.cases.flatMap((c) => (c.guard ? [c.guard, c.body] : [c.body]))); break
    case 'typedecl': kids.push(e.body); break
    case 'letrec': kids.push(...e.bindings.map((b) => b.value), e.body); break
    case 'record': kids.push(...e.fields.map((f) => f.value)); break
    case 'field': kids.push(e.record); break
    case 'recordUpdate': kids.push(e.record, ...e.fields.map((f) => f.value)); break
    default: break
  }
  return 1 + kids.reduce((n, k) => n + nodeCount(k), 0)
}

function anyNode(e, pred) {
  if (!e) return false
  if (pred(e)) return true
  const kids = []
  switch (e.kind) {
    case 'lambda': kids.push(e.body); break
    case 'app': kids.push(e.fn, e.arg); break
    case 'let': kids.push(e.value, e.body); break
    case 'if': kids.push(e.cond, e.then, e.else); break
    case 'binop': kids.push(e.left, e.right); break
    case 'unop': kids.push(e.operand); break
    case 'list': case 'tuple': kids.push(...e.elements); break
    case 'seq': kids.push(e.first, e.rest); break
    case 'match': kids.push(e.scrutinee, ...e.cases.flatMap((c) => (c.guard ? [c.guard, c.body] : [c.body]))); break
    case 'typedecl': kids.push(e.body); break
    case 'letrec': kids.push(...e.bindings.map((b) => b.value), e.body); break
    case 'record': kids.push(...e.fields.map((f) => f.value)); break
    case 'field': kids.push(e.record); break
    case 'recordUpdate': kids.push(e.record, ...e.fields.map((f) => f.value)); break
    default: break
  }
  return kids.some((k) => anyNode(k, pred))
}

function checkOpt(name, src, opts = {}) {
  const on = runPipeline(src, { execute: true, optimize: true })
  const off = runPipeline(src, { execute: true, optimize: false })
  const problems = []
  if (on.error || off.error) {
    record('opt:' + name, false, `pipeline error: ${(on.error || off.error).message}`)
    return
  }
  const onVal = on.run && on.run.result ? valueToString(on.run.result) : null
  const offVal = off.run && off.run.result ? valueToString(off.run.result) : null
  if (onVal !== offVal) problems.push(`result "${onVal}" != "${offVal}"`)
  if ((on.run ? on.run.output.join('\n') : '') !== (off.run ? off.run.output.join('\n') : ''))
    problems.push('output differs')
  if ((on.run ? on.run.effects.length : 0) !== (off.run ? off.run.effects.length : 0))
    problems.push('effect count differs')
  if (on.run && off.run && on.run.steps > off.run.steps)
    problems.push(`steps increased ${off.run.steps} -> ${on.run.steps}`)
  if (opts.minRewrites !== undefined && on.foldCount < opts.minRewrites)
    problems.push(`only ${on.foldCount} rewrites (expected >= ${opts.minRewrites})`)
  if (opts.maxNodes !== undefined && nodeCount(on.optimizedCoreAst) > opts.maxNodes)
    problems.push(`optimized core ${nodeCount(on.optimizedCoreAst)} nodes (expected <= ${opts.maxNodes})`)
  if (opts.noMatch && anyNode(on.optimizedCoreAst, (n) => n.kind === 'match'))
    problems.push('a `match` survived optimization (expected none)')
  if (opts.expect !== undefined && onVal !== opts.expect)
    problems.push(`value "${onVal}" != expected "${opts.expect}"`)
  const cseCount = on.optimization ? (on.optimization.passes.cse ?? 0) : 0
  if (opts.minCse !== undefined && cseCount < opts.minCse)
    problems.push(`only ${cseCount} CSE rewrites (expected >= ${opts.minCse})`)
  if (opts.noCse && cseCount !== 0)
    problems.push(`CSE fired ${cseCount}× (expected none — would be speculative)`)
  const gvnCount = on.optimization ? (on.optimization.passes.gvn ?? 0) : 0
  if (opts.minGvn !== undefined && gvnCount < opts.minGvn)
    problems.push(`only ${gvnCount} GVN rewrites (expected >= ${opts.minGvn})`)
  if (opts.noGvn && gvnCount !== 0)
    problems.push(`GVN fired ${gvnCount}× (expected none — would speculate or duplicate)`)
  if (opts.minGvnSites !== undefined) {
    const sites = on.optimization ? (on.optimization.gvnHoists ?? []).reduce((n, h) => n + h.sites, 0) : 0
    if (sites < opts.minGvnSites) problems.push(`only ${sites} GVN sites shared (expected >= ${opts.minGvnSites})`)
  }
  if (opts.minStepCut !== undefined && on.run && off.run && off.run.steps - on.run.steps < opts.minStepCut)
    problems.push(`steps cut by only ${off.run.steps - on.run.steps} (expected >= ${opts.minStepCut})`)
  const dt = on.optimization ? on.optimization.dt : null
  if (opts.minDt !== undefined && (!dt || dt.matchesCompiled < opts.minDt))
    problems.push(`only ${dt ? dt.matchesCompiled : 0} matches compiled to decision trees (expected >= ${opts.minDt})`)
  if (opts.noDt && dt && dt.matchesCompiled !== 0)
    problems.push(`DT fired on ${dt.matchesCompiled} match(es) (expected none — already flat)`)
  if (opts.minJoins !== undefined && (!dt || dt.joinPoints < opts.minJoins))
    problems.push(`only ${dt ? dt.joinPoints : 0} join-points (expected >= ${opts.minJoins})`)
  if (opts.pure !== undefined) {
    const pureFns = on.optimization ? on.optimization.pureFns : []
    for (const f of opts.pure) if (!pureFns.includes(f)) problems.push(`'${f}' not proven pure (got [${pureFns}])`)
  }
  if (opts.notPure !== undefined) {
    const pureFns = on.optimization ? on.optimization.pureFns : []
    for (const f of opts.notPure) if (pureFns.includes(f)) problems.push(`'${f}' wrongly proven pure`)
  }
  record('opt:' + name, problems.length === 0, problems.join('; '))
}

// Every gallery example: optimizer must preserve the answer and not add steps.
for (const ex of EXAMPLES) checkOpt('example:' + ex.id, ex.code)

// Targeted per-pass programs. Each must reduce to the same answer and fire.
// const-folding + algebra fold a pure arithmetic tree to a literal.
checkOpt('const-fold arithmetic', 'let x = (2 + 3) * 4 - 10 / 2 in x * 1 + 0', { expect: '15', minRewrites: 4 })
// β: an immediately-applied lambda (what `|>` and dictionary calls desugar to).
checkOpt('beta reduce pipe', '5 |> (fn x -> x + 1) |> (fn x -> x * 2)', { expect: '12', minRewrites: 2 })
// known-match: matching a literal constructor collapses to its arm.
checkOpt('known-match Option', 'type Opt a = None | Some a in match Some (3 + 4) with None -> 0 | Some x -> x * 10', { expect: '70', minRewrites: 1 })
// known-match on a tuple + list literal, no match should remain.
checkOpt('known-match tuple', 'match (1, 2, 3) with (a, b, c) -> a + b + c', { expect: '6', noMatch: true })
checkOpt('known-match list', 'match [10, 20, 30] with [] -> 0 | h :: _ -> h', { expect: '10', noMatch: true })
// dead-binding elimination drops a pure unused let.
checkOpt('dead binding', 'let unused = 1 + 2 + 3 in let y = 7 in y', { expect: '7', minRewrites: 1 })
// field projection: a record literal field access reduces to the field value.
checkOpt('field projection', 'let r = { a = 1, b = 2 + 3, c = 9 } in r.b', { expect: '5', minRewrites: 1 })
// if-folding on a constant condition (after folding the comparison).
checkOpt('if fold', 'if 3 < 5 then 100 else 200', { expect: '100', minRewrites: 1 })
// The abstraction-melts-away showcase: a type-class call on a concrete instance
// should inline the dictionary, project the method and β-reduce it away.
checkOpt(
  'type-class dictionary melts',
  'class Disp a where disp : a -> String in instance Disp Int where disp = fn n -> show n in disp (1 + 1)',
  { expect: '"2"', minRewrites: 3 },
)
// do-notation over Option desugars to bind/then on dictionaries; still correct.
checkOpt(
  'do-notation optimized',
  'type Opt a = None | Some a in let bind = fn m f -> match m with None -> None | Some x -> f x in do { a <- Some 10; b <- Some 20; Some (a + b) }',
  { expect: 'Some 30' },
)

// Soundness corner cases — the optimizer must NOT change effects, ordering or
// scoping. checkOpt compares optimized vs unoptimized result *and* printed
// output, so any divergence here fails.
// A discarded constructor field with an effect must still run.
checkOpt('effect under discarded ctor field', 'type Box a = Box a in let _ = match Box (print 7) with Box _ -> 0 in 1', { expect: '1' })
// Print ordering across a let chain is preserved.
checkOpt('print ordering preserved', 'let _ = print 1 in let _ = print 2 in let _ = print 3 in 0', { expect: '0' })
// A dead but effectful binding keeps its effect.
checkOpt('dead effectful binding keeps effect', 'let unused = print 99 in 5', { expect: '5' })
// Capture avoidance: inlining a closure must keep its captured outer binding.
checkOpt('inline avoids capture', 'let y = 10 in let f = fn x -> x + y in let y = 999 in f 0 + y', { expect: '1009' })
// β with shadowed binder picks the inner binding.
checkOpt('beta respects shadowing', '(fn x -> (fn x -> x) 2) 1', { expect: '2' })
// known-match must not fire through an effect even on a literal-headed ctor.
checkOpt('known-match keeps scrutinee effect', 'type Opt a = None | Some a in match Some (print 1) with None -> 0 | Some _ -> 42', { expect: '42' })

// ---------------------------------------------------------------------------
// Common-subexpression elimination battery (Aether 11.0). CSE shares work that
// runs more than once on a guaranteed path — checkOpt already proves the result,
// output, effects and (never-increased) step count agree with the unoptimized
// run, so here we additionally assert CSE *fired*, *cut real steps*, and — the
// safety half — that it NEVER merges an effect or speculates across a branch.
// ---------------------------------------------------------------------------

// Repeated pure arithmetic in a tuple: computed once, fewer steps.
checkOpt('cse repeated arithmetic', 'let a = 3 in let b = 4 in (a * a + b * b, a * a + b * b)',
  { expect: '(25, 25)', minCse: 1, minStepCut: 5 })
// Squaring: (x)*(x) shares the inner expression even within one multiply.
checkOpt('cse squaring', 'let ax = 6 in let bx = 2 in (ax - bx) * (ax - bx)',
  { expect: '16', minCse: 1 })
// The headline: a proven-pure helper's repeated *call* is shared.
checkOpt('cse pure helper call',
  'let norm2 = fn x y -> x * x + y * y in let dx = 7 in let dy = 4 in (norm2 dx dy + norm2 dx dy, norm2 dx dy * 2)',
  { expect: '(130, 130)', minCse: 1, minStepCut: 10, pure: ['norm2'] })
// CSE composes with the rest of the middle-end (a record + a shared subterm).
checkOpt('cse inside record', 'let a = 5 in let b = 6 in { p = a * b + a, q = a * b + b }',
  { minCse: 1 })
// A repeated total, effect-free *native* call (sqrt) is shared too.
checkOpt('cse total native', 'let x = 16.0 in (sqrt x +. 1.0, sqrt x +. 2.0)',
  { expect: '(5.0, 6.0)', minCse: 1 })
// ...but a *shadowed* native is distrusted: the user's effectful sqrt is not merged.
checkOpt('cse distrusts a shadowed native',
  'let sqrt = fn x -> let u = print x in x in (sqrt 5, sqrt 5)',
  { expect: '(5, 5)', noCse: true })

// --- soundness: CSE must NOT change observable behaviour ---
// An effectful helper is never proven pure, so two calls are never merged: both
// 'print's must still run (checkOpt compares optimized vs unoptimized output).
checkOpt('cse never merges an effect',
  'let logId = fn x -> let u = print x in x in (logId 1, logId 1)',
  { notPure: ['logId'] })
// A bare repeated effectful call likewise keeps both effects.
checkOpt('cse keeps repeated prints', 'let p = fn x -> print x in let _ = p 1 in let _ = p 1 in 0',
  { expect: '0' })
// No speculation: a subexpression common to two *branches* (not guaranteed to
// run) must not be hoisted out of the `if`.
checkOpt('cse does not speculate across branches',
  'let a = 3 in let b = 4 in let c = a < b in if c then a * a + b * b + 1 else a * a + b * b + 2',
  { expect: '26', noCse: true })
// A genuinely recursive function is never admitted as pure-total (it could loop).
checkOpt('cse rejects recursive functions',
  'let rec f = fn n -> if n == 0 then 0 else n + f (n - 1) in (f 5, f 5)',
  { expect: '(15, 15)', notPure: ['f'] })

// ---------------------------------------------------------------------------
// Global value-numbering battery (Aether 14.0). GVN shares a pure, costly
// expression recomputed across BINDERS — work the binder-free frontier CSE
// (11.0) cannot reach. `checkOpt` already proves the result, output, effects and
// (never-increased) step count agree with the unoptimized run; here we also
// assert GVN *fired*, *cut real steps*, shared the right number of sites, and —
// the safety half — declined to speculate or to move an effect.
// ---------------------------------------------------------------------------

// The headline: a pure window recomputed as the value of three different `let`s
// (so frontier CSE never sees it) is hoisted once and shared across all three.
checkOpt('gvn shares a window across three lets',
  `let sq = fn x -> x * x in
   let rec k = fn n -> if n == 0 then 0
     else let a = sq n + sq (n + 1) + sq (n + 2) in
          let b = (sq n + sq (n + 1) + sq (n + 2)) * 3 in
          let c = (sq n + sq (n + 1) + sq (n + 2)) - 1 in
          a + b + c + k (n - 1) in
   k 12`,
  { expect: '12378', minGvn: 1, minGvnSites: 3, minStepCut: 300, pure: ['sq'] })

// A plain arithmetic expression recomputed across a single `let` binder. Frontier
// CSE leaves it (the two copies are the values of different lets); GVN shares it.
checkOpt('gvn shares across one let binder',
  'let rec f = fn n -> if n == 0 then 0 else let a = (n * n * n + n * n + n) in let b = (n * n * n + n * n + n) * 2 in a + b + f (n - 1) in f 12',
  { expect: '20436', minGvn: 1, minStepCut: 30 })

// --- safety: GVN must change nothing observable, and never speculate ---
// Redundant only in two `if` arms — each only conditionally evaluated — so
// hoisting would add work on the path that takes the other arm. GVN must decline.
checkOpt('gvn does not speculate across if-arms',
  'let rec f = fn n -> if n == 0 then 0 else if n % 2 == 0 then (n*n*n+n*n)+1 else (n*n*n+n*n)+2 in f 9 + f 8',
  { expect: '1389', noGvn: true })
// Guaranteed once (before the match) plus once inside an arm: only ONE guaranteed
// evaluation, so sharing could add work — GVN must decline (no speculation).
checkOpt('gvn needs two guaranteed evaluations',
  'let rec f = fn n -> if n == 0 then 0 else (n*n*n+n*n) + (match n % 2 with 0 -> (n*n*n+n*n) | _ -> n) + f (n-1) in f 9',
  { expect: '3255', noGvn: true })
// An effectful expression repeated across a let is NEVER moved (both effects run).
checkOpt('gvn never moves an effect',
  'let log = fn x -> let u = print x in x in let a = log 5 in let b = log 5 in a + b',
  { expect: '10', noGvn: true })

// ---------------------------------------------------------------------------
// Decision-tree pattern compilation battery (Aether 12.0). `checkOpt` already
// proves DT ≡ naive for every program (same result, output, effect count, and a
// never-increased step count). Here we additionally assert DT *fired* on the
// nested/shared-prefix cases, *cut real steps* on the showcase, exercises every
// lowering path (cons, ADT, tuple, literal, guard, join-point), preserves
// `MATCH_FAIL`, and is *skipped* on already-optimal flat matches.
// ---------------------------------------------------------------------------

// The headline showcase: a shared-prefix peephole simplifier really cuts steps.
checkOpt('dt expression simplifier',
  `type Expr = Lit Int | Add Expr Expr | Mul Expr Expr in
   let reduce = fn e -> match e with
     | Add (Lit 0) y -> y | Add x (Lit 0) -> x
     | Mul (Lit 0) _ -> Lit 0 | Mul _ (Lit 0) -> Lit 0
     | Mul (Lit 1) y -> y | Mul x (Lit 1) -> x | other -> other in
   let rec simp = fn e -> match e with
     | Lit n -> Lit n
     | Add a b -> reduce (Add (simp a) (simp b))
     | Mul a b -> reduce (Mul (simp a) (simp b)) in
   let rec eval = fn e -> match e with Lit n -> n | Add a b -> eval a + eval b | Mul a b -> eval a * eval b in
   eval (simp (Mul (Add (Mul (Lit 1) (Lit 7)) (Mul (Lit 0) (Lit 9))) (Add (Lit 3) (Mul (Lit 6) (Lit 1)))))`,
  { expect: '63', minDt: 1, minStepCut: 80 })

// Shared cons prefix: `a :: b :: rest` and `a :: []` both test the outer `::`.
checkOpt('dt shared cons prefix',
  'let rec f = fn xs -> match xs with a :: b :: r -> a + b + f r | a :: [] -> a | [] -> 0 in f [1, 2, 3, 4, 5]',
  { expect: '15', minDt: 1, minStepCut: 1 })

// Nested ADT constructors (`C (B x) y`): the inner `B` is tested under the `C` arm.
checkOpt('dt nested ADT',
  'type T = A | B T | C T T in let rec d = fn t -> match t with C (B x) y -> 1 + d x + d y | C x y -> 2 + d x + d y | B x -> 3 + d x | A -> 0 in d (C (B A) (C A A))',
  { expect: '3', minDt: 1, minStepCut: 1 })

// Nested literals inside a tuple destructure.
checkOpt('dt nested tuple literals',
  'let f = fn p -> match p with (0, _) -> 1 | (_, 0) -> 2 | (a, b) -> a + b in (f (0, 9), f (9, 0), f (3, 4))',
  { expect: '(1, 2, 7)', minDt: 1 })

// Guards: a failing `when` falls through to exactly the arms it would naively.
checkOpt('dt guards fall through',
  'let f = fn a b -> match (a, b) with (x, y) when x > y -> 1 | (x, y) when x < y -> 2 | (x, y) -> 3 in (f 5 1, f 1 5, f 4 4)',
  { expect: '(1, 2, 3)', minDt: 1 })

// Join-points: an overlapping wildcard row reachable from two arms is shared,
// not duplicated (so the tree never blows up code size).
checkOpt('dt shares overlapping arm via join-point',
  `let big = fn z -> z * z * z + z * z + z in
   let f = fn a b -> match (a, b) with (true, true) -> 0 | (_, false) -> big 5 + big 6 | (false, _) -> 1
   in (f true false, f false true, f true true, f false false)`,
  { expect: '(413, 1, 0, 413)', minDt: 1, minJoins: 1 })

// Signature completeness: a complete ADT switch needs no default arm.
checkOpt('dt complete signature, no default',
  'type C = R | G | B in let f = fn x y -> match (x, y) with (R, n) -> n | (G, n) -> n + 1 | (B, n) -> n + 2 in (f R 10, f G 10, f B 10)',
  { expect: '(10, 11, 12)', minDt: 1 })

// A nested match on a *dynamic* scrutinee (so the optimizer can't const-fold it
// away) returns the right arm's value — DT fired and is correct. `range` hides
// the list from constant folding.
checkOpt('dt on a dynamic list scrutinee',
  'let f = fn xs -> match xs with a :: b :: _ -> a + b | a :: [] -> a | [] -> 0 in (f (range 7 8), f (range 3 6))',
  { expect: '(7, 7)', minDt: 1 })

// A guard that falls through with no remaining arm MATCH_FAILs identically on
// both paths (checkOpt compares the optimized and unoptimized runs).
{
  const src = 'let f = fn n -> match n with x when x > 100 -> x in f 5'
  const on = runPipeline(src, { execute: true, optimize: true })
  const off = runPipeline(src, { execute: true, optimize: false })
  const bothFail = !!(on.error && off.error && on.error.stage === 'run' && off.error.stage === 'run')
  record('opt:dt guard-fail MATCH_FAILs on both', bothFail, `on=${on.error && on.error.message} off=${off.error && off.error.message}`)
}

// A flat match (distinct single-level heads, no nesting) is already optimal —
// DT must leave it untouched so the prelude/enums stay byte-identical.
checkOpt('dt skips a flat Option match',
  'type Opt a = None | Some a in match Some 5 with None -> 0 | Some x -> x + 1',
  { expect: '6', noDt: true })
checkOpt('dt skips a flat enum match',
  'type C = R | G | B in let f = fn c -> match c with R -> 1 | G -> 2 | B -> 3 in (f R, f G, f B)',
  { expect: '(1, 2, 3)', noDt: true })

// Aggregate: the optimizer fires somewhere on the gallery, and at least one
// example's core strictly shrinks (proves real reduction, not a no-op).
let totalRewrites = 0
let anyShrunk = false
for (const ex of EXAMPLES) {
  const r = runPipeline(ex.code, { execute: false, optimize: true })
  if (r.optimization) {
    totalRewrites += r.foldCount
    if (r.optimization.nodesAfter < r.optimization.nodesBefore) anyShrunk = true
  }
}
record('opt:gallery fires', totalRewrites > 0, `total rewrites across gallery: ${totalRewrites}`)
record('opt:gallery shrinks', anyShrunk, 'no gallery example shrank under optimization')

console.log(`\nAether harness: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
