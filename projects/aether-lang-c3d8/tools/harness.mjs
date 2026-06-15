// Aether — headless semantic harness.
//
// Runs Aether programs through the real pipeline (lexer → parser → HM inference
// → dictionary-passing elaboration → bytecode VM), and the JavaScript backend,
// asserting the two backends agree byte-for-byte. Used during development to
// guard the language against regressions; run with:
//   node --experimental-strip-types tools/harness.mjs
import { runPipeline } from '../src/lang/pipeline.ts'
import { compileToJs, runJsModule } from '../src/lang/jsBackend.ts'
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
  // JS ≡ VM equivalence on the elaborated core
  if (r.coreAst && !expect.skipJs) {
    const mod = compileToJs(r.coreAst)
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

console.log(`\nAether harness: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
