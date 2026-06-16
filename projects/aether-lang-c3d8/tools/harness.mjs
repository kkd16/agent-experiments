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

console.log(`\nAether harness: ${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
