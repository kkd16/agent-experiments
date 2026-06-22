// Aether — an in-browser self-test suite.
//
// Every case runs through the whole pipeline (lex → parse → infer → elaborate →
// compile → VM) and, when it produces a value, is *also* compiled to JavaScript
// and run, so each row proves the two backends agree. The Tests page renders the
// results live; this module is pure logic so it can also run under Node.

import type { Expr } from './ast.ts'
import { runPipeline } from './pipeline.ts'
import { compileToJs, runJsModule } from './jsBackend.ts'
import { valueToString } from './values.ts'

export interface TestCase {
  group: string
  name: string
  code: string
  /** expected VM result string, or null to only check it runs */
  expected: string | null
  /** the case is expected to fail type-checking / parsing */
  expectError?: boolean
}

export interface TestResult {
  group: string
  name: string
  ok: boolean
  detail: string
  type: string | null
  /** whether the JS backend matched the VM (n/a for error cases) */
  jsMatch: boolean | null
}

export const TEST_CASES: TestCase[] = [
  // ---- core language (regression) ----
  { group: 'core', name: 'arithmetic & let', code: 'let x = 6 in x * 7', expected: '42' },
  {
    group: 'core',
    name: 'recursion (factorial)',
    code: 'let rec f = fn n -> if n <= 1 then 1 else n * f (n - 1) in f 6',
    expected: '720',
  },
  {
    group: 'core',
    name: 'higher-order + comprehension',
    code: 'map (fn x -> x * x) [ n | n <- range 1 6 ]',
    expected: '[1, 4, 9, 16, 25]',
  },
  {
    group: 'core',
    name: 'ADT + match',
    code: 'type Opt a = None | Some a in match Some 5 with None -> 0 | Some x -> x + 1',
    expected: '6',
  },
  {
    group: 'core',
    name: 'records (row polymorphism)',
    code: 'let getx = fn r -> r.x in (getx { x = 1, y = 2 }, getx { x = 9, z = "q" })',
    expected: '(1, 9)',
  },

  // ---- type classes ----
  {
    group: 'type classes',
    name: 'basic overloading',
    code: `class Disp a where disp : a -> String in
instance Disp Int  where disp = fn n -> show n in
instance Disp Bool where disp = fn b -> if b then "yes" else "no" in
(disp 42, disp true)`,
    expected: '("42", "yes")',
  },
  {
    group: 'type classes',
    name: 'constrained polymorphism',
    code: `class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
let twice = fn x -> disp x ^ disp x in twice 7`,
    expected: '"77"',
  },
  {
    group: 'type classes',
    name: 'instance context (List)',
    code: `class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
instance Disp a => Disp (List a) where disp = fn xs -> "[" ^ join ", " (map disp xs) ^ "]" in
disp [[1, 2], [3]]`,
    expected: '"[[1, 2], [3]]"',
  },
  {
    group: 'type classes',
    name: 'two-constraint tuple instance',
    code: `class Disp a where disp : a -> String in
instance Disp Int  where disp = fn n -> show n in
instance Disp Bool where disp = fn b -> if b then "T" else "F" in
instance Disp a, Disp b => Disp (a, b) where disp = fn p -> match p with (x, y) -> "<" ^ disp x ^ "," ^ disp y ^ ">" in
disp (1, true)`,
    expected: '"<1,T>"',
  },
  {
    group: 'type classes',
    name: 'recursive self-referential instance (Tree)',
    code: `type Tree a = Leaf | Node (Tree a) a (Tree a) in
class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
instance Disp a => Disp (Tree a) where
  disp = fn t -> match t with Leaf -> "." | Node l x r -> "(" ^ disp l ^ " " ^ disp x ^ " " ^ disp r ^ ")" in
disp (Node (Node Leaf 1 Leaf) 2 Leaf)`,
    expected: '"((. 1 .) 2 .)"',
  },
  {
    group: 'type classes',
    name: 'dictionary threaded through let rec',
    code: `class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
let rec all = fn xs -> if empty xs then "" else disp (head xs) ^ all (tail xs) in all [1, 2, 3]`,
    expected: '"123"',
  },
  {
    group: 'type classes',
    name: 'method as a first-class value',
    code: `class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
join " " (map disp [1, 2, 3])`,
    expected: '"1 2 3"',
  },

  // ---- default methods ----
  {
    group: 'default methods',
    name: 'default used',
    code: `class Eq2 a where eq : a -> a -> Bool, ne : a -> a -> Bool = fn x y -> if eq x y then false else true in
instance Eq2 Int where eq = fn x y -> x == y in
(ne 3 3, ne 3 4)`,
    expected: '(false, true)',
  },
  {
    group: 'default methods',
    name: 'default overridden',
    code: `class G a where hi : a -> String, bye : a -> String = fn x -> "bye " ^ hi x in
instance G Int where hi = fn n -> show n, bye = fn n -> "custom" in
(hi 5, bye 5)`,
    expected: '("5", "custom")',
  },

  // ---- do-notation (desugars to `bind`; both backends run it) ----
  {
    group: 'do-notation',
    name: 'Option monad short-circuits',
    code: `type Opt a = None | Some a in
let bind = fn m k -> match m with None -> None | Some x -> k x in
let sd = fn a b -> if b == 0 then None else Some (a / b) in
do { y <- sd 100 5 ; z <- sd y 2 ; Some (z + 1) }`,
    expected: 'Some 11',
  },
  {
    group: 'do-notation',
    name: 'Option monad aborts on None',
    code: `type Opt a = None | Some a in
let bind = fn m k -> match m with None -> None | Some x -> k x in
let sd = fn a b -> if b == 0 then None else Some (a / b) in
do { y <- sd 100 0 ; z <- sd y 2 ; Some (z + 1) }`,
    expected: 'None',
  },
  {
    group: 'do-notation',
    name: 'List monad branches (cartesian)',
    code: `let bind = fn m k -> concat (map k m) in
do { x <- [1, 2] ; y <- [10, 20] ; [ (x, y) ] }`,
    expected: '[(1, 10), (1, 20), (2, 10), (2, 20)]',
  },
  {
    group: 'do-notation',
    name: 'discard statement (bind _)',
    code: `type Opt a = None | Some a in
let bind = fn m k -> match m with None -> None | Some x -> k x in
do { Some 1 ; None ; Some 99 }`,
    expected: 'None',
  },

  // ---- higher-kinded type classes ----
  {
    group: 'higher-kinded',
    name: 'Monad Option (bind + pure)',
    code: `type Opt a = None | Some a in
class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad Opt where
  pure = fn x -> Some x,
  bind = fn m k -> match m with None -> None | Some x -> k x in
bind (Some 20) (fn x -> pure (x + 1))`,
    expected: 'Some 21',
  },
  {
    group: 'higher-kinded',
    name: 'polymorphic mapM over two monads',
    code: `type Opt a = None | Some a in
class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad Opt where pure = fn x -> Some x, bind = fn m k -> match m with None -> None | Some x -> k x in
instance Monad List where pure = fn x -> [x], bind = fn m k -> concat (map k m) in
let rec mapM = fn f xs -> if empty xs then pure []
  else bind (f (head xs)) (fn y -> bind (mapM f (tail xs)) (fn ys -> pure (y :: ys))) in
( mapM (fn x -> Some (x + 1)) [1, 2, 3], mapM (fn x -> [x, x * 10]) [1, 2] )`,
    expected: '(Some [2, 3, 4], [[1, 2], [1, 20], [10, 2], [10, 20]])',
  },
  {
    group: 'higher-kinded',
    name: 'do-notation through the Monad class',
    code: `type Opt a = None | Some a in
class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad Opt where pure = fn x -> Some x, bind = fn m k -> match m with None -> None | Some x -> k x in
let sd = fn a b -> if b == 0 then None else Some (a / b) in
do { y <- sd 100 5 ; z <- sd y 2 ; pure (z + 1) }`,
    expected: 'Some 11',
  },
  {
    group: 'higher-kinded',
    name: 'superclass entailment (Functor from Monad)',
    code: `type Opt a = None | Some a in
class Functor f where fmap : (a -> b) -> f a -> f b in
class Functor m => Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Functor Opt where fmap = fn g x -> match x with None -> None | Some v -> Some (g v) in
instance Monad Opt where pure = fn x -> Some x, bind = fn m k -> match m with None -> None | Some x -> k x in
let twice = fn mx -> bind mx (fn x -> fmap (fn y -> y + y) (pure x)) in
twice (Some 21)`,
    expected: 'Some 42',
  },
  {
    group: 'higher-kinded',
    name: 'State monad (partially-applied constructor)',
    code: `type St s a = St (s -> (a, s)) in
let run = fn st s -> match st with St f -> f s in
class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad (St s) where
  pure = fn x -> St (fn s -> (x, s)),
  bind = fn m k -> St (fn s0 -> match run m s0 with (a, s1) -> run (k a) s1) in
let tick = St (fn n -> (n, n + 1)) in
run (bind tick (fn a -> bind tick (fn b -> pure (a, b)))) 0`,
    expected: '((0, 1), 2)',
  },

  // ---- deriving (synthesised instances) ----
  {
    group: 'deriving',
    name: 'Eq over a parametric, recursive type',
    code: `class Eq a where eq : a -> a -> Bool in
instance Eq Int where eq = fn a b -> a == b in
type Tree a = Leaf a | Node (Tree a) (Tree a) deriving (Eq) in
let t = Node (Leaf 1) (Node (Leaf 2) (Leaf 3)) in
(eq t t, eq t (Node (Leaf 1) (Node (Leaf 9) (Leaf 3))))`,
    expected: '(true, false)',
  },
  {
    group: 'deriving',
    name: 'Ord by constructor order then fields',
    code: `class Ord a where compare : a -> a -> Int in
instance Ord Int where compare = fn a b -> if a < b then -1 else if a == b then 0 else 1 in
type T = A | B Int | C deriving (Ord) in
(compare A C, compare C A, compare (B 1) (B 4), compare (B 5) (B 5), compare C (B 9))`,
    expected: '(-1, 1, -1, 0, 1)',
  },
  {
    group: 'deriving',
    name: 'Show is Haskell-style and recurses',
    code: `class Show a where show : a -> String in
type Tree = Tip | Bin Tree Tree deriving (Show) in
show (Bin (Bin Tip Tip) Tip)`,
    expected: '"(Bin (Bin Tip Tip) Tip)"',
  },
  {
    group: 'deriving',
    name: 'Enum + Bounded enumerate a C-style enum',
    code: `class Enum a where fromEnum : a -> Int, toEnum : Int -> a in
class Bounded a where minBound : a, maxBound : a in
type RGB = R | G | B deriving (Enum, Bounded) in
let lo = max R minBound in
let hi = max B maxBound in
let mid = head (toEnum 1 :: [G]) in
(fromEnum lo, fromEnum hi, fromEnum mid)`,
    expected: '(0, 2, 1)',
  },
  {
    group: 'deriving',
    name: 'Functor maps the last parameter (self + tuple)',
    code: `class Functor f where fmap : (a -> b) -> f a -> f b in
type Pair k a = Pair k (a, a) deriving (Functor) in
type Tree a = Leaf a | Node (Tree a) (Tree a) deriving (Functor) in
let p = fmap (fn x -> x + 1) (Pair "k" (10, 20)) in
let t = fmap (fn x -> x * 2) (Node (Leaf 3) (Leaf 4)) in
(match p with Pair k xs -> (k, xs), match t with Node (Leaf a) (Leaf b) -> (a, b) | _ -> (0, 0))`,
    expected: '(("k", (11, 21)), (6, 8))',
  },
  {
    group: 'deriving',
    name: 'Foldable folds the last parameter (toList + sum)',
    code: `class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in
type Tree a = Leaf | Node (Tree a) a (Tree a) deriving (Foldable) in
let t = Node (Node Leaf 1 Leaf) 2 (Node Leaf 3 Leaf) in
let toList = fn xs -> foldr (fn x acc -> x :: acc) [] xs in
(toList t, foldr (fn x acc -> x + acc) 0 t)`,
    expected: '([1, 2, 3], 6)',
  },
  {
    group: 'deriving',
    name: 'Foldable over a list field',
    code: `class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in
type Bag a = Bag (List a) (a, a) deriving (Foldable) in
foldr (fn x acc -> x :: acc) [] (Bag [1, 2] (3, 4))`,
    expected: '[1, 2, 3, 4]',
  },
  {
    group: 'deriving',
    name: 'multiple classes in one clause cooperate',
    code: `class Eq a where eq : a -> a -> Bool in
class Show a where show : a -> String in
type Color = Red | Green | Blue deriving (Eq, Show) in
(eq Green Green, eq Red Blue, show Blue)`,
    expected: '(true, false, "Blue")',
  },

  // ---- optimizer: common-subexpression elimination (Aether 11.0) ----
  {
    group: 'cse',
    name: 'repeated pure work is shared (and equals the unshared answer)',
    code: 'let a = 3 in let b = 4 in (a * a + b * b, a * a + b * b)',
    expected: '(25, 25)',
  },
  {
    group: 'cse',
    name: 'a proven-pure helper call is shared',
    code: 'let norm2 = fn x y -> x * x + y * y in let dx = 7 in let dy = 4 in norm2 dx dy + norm2 dx dy',
    expected: '130',
  },
  {
    group: 'cse',
    name: 'an effectful call is never merged (both effects run)',
    code: 'let logId = fn x -> let u = print x in x in (logId 1, logId 1)',
    expected: '(1, 1)',
  },

  // ---- optimizer: global value numbering (Aether 14.0) ----
  // CSE across binders. Each runs the whole pipeline (so the shared `let` ships)
  // and is also run on JS — a green row proves GVN preserved the answer.
  {
    group: 'gvn',
    name: 'work shared across a `let` binder equals the unshared answer',
    code: 'let rec f = fn n -> if n == 0 then 0 else let a = (n * n * n + n) in let b = (n * n * n + n) * 2 in a + b + f (n - 1) in f 6',
    expected: '1386',
  },
  {
    group: 'gvn',
    name: 'a pure window across three lets is shared once',
    code: 'let sq = fn x -> x * x in let rec k = fn n -> if n == 0 then 0 else let a = sq n + sq (n+1) in let b = (sq n + sq (n+1)) * 3 in a + b + k (n-1) in k 6',
    expected: '920',
  },
  {
    group: 'gvn',
    name: 'redundancy split across if-arms is NOT hoisted (no speculation)',
    code: 'let rec f = fn n -> if n == 0 then 0 else if n % 2 == 0 then (n*n*n+n)+1 else (n*n*n+n)+2 in f 6 + f 5',
    expected: '355',
  },

  // ---- decision-tree pattern compilation (Aether 12.0) ----
  // Each runs through the whole pipeline (so the decision-tree lowering ships)
  // and is also run on the JavaScript backend — a green row proves DT ≡ naive.
  {
    group: 'decision trees',
    name: 'shared cons prefix',
    code: `let rec f = fn xs -> match xs with
| a :: b :: rest -> a + b + f rest
| a :: [] -> a
| [] -> 0 in f [1, 2, 3, 4, 5]`,
    expected: '15',
  },
  {
    group: 'decision trees',
    name: 'nested ADT constructors',
    code: `type T = A | B T | C T T in
let rec d = fn t -> match t with
| C (B x) y -> 1 + d x + d y
| C x y -> 2 + d x + d y
| B x -> 3 + d x
| A -> 0 in d (C (B A) (C A A))`,
    expected: '3',
  },
  {
    group: 'decision trees',
    name: 'nested literals in a tuple',
    code: `let f = fn p -> match p with
| (0, _) -> 1
| (_, 0) -> 2
| (a, b) -> a + b in (f (0, 9), f (9, 0), f (3, 4))`,
    expected: '(1, 2, 7)',
  },
  {
    group: 'decision trees',
    name: 'guards fall through correctly',
    code: `let f = fn a b -> match (a, b) with
| (x, y) when x > y -> 1
| (x, y) when x < y -> 2
| (x, y) -> 3 in (f 5 1, f 1 5, f 4 4)`,
    expected: '(1, 2, 3)',
  },
  {
    group: 'decision trees',
    name: 'peephole simplifier (shared prefixes)',
    code: `type Expr = Lit Int | Add Expr Expr | Mul Expr Expr in
let reduce = fn e -> match e with
| Add (Lit 0) y -> y
| Add x (Lit 0) -> x
| Mul (Lit 0) _ -> Lit 0
| Mul _ (Lit 0) -> Lit 0
| Mul (Lit 1) y -> y
| Mul x (Lit 1) -> x
| other -> other in
let rec simp = fn e -> match e with
| Lit n -> Lit n
| Add a b -> reduce (Add (simp a) (simp b))
| Mul a b -> reduce (Mul (simp a) (simp b)) in
let rec eval = fn e -> match e with
| Lit n -> n | Add a b -> eval a + eval b | Mul a b -> eval a * eval b in
eval (simp (Mul (Add (Mul (Lit 1) (Lit 7)) (Mul (Lit 0) (Lit 9))) (Add (Lit 3) (Mul (Lit 6) (Lit 1)))))`,
    expected: '63',
  },

  // ---- errors (must be rejected) ----
  {
    group: 'errors',
    name: 'deriving a non-derivable class is rejected',
    code: 'class Foo a where foo : a -> Int in type T = A deriving (Foo) in 0',
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'deriving Enum on a type with fields is rejected',
    code: `class Enum a where fromEnum : a -> Int, toEnum : Int -> a in
type T = A Int deriving (Enum) in 0`,
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'deriving Functor on a nullary type is rejected',
    code: `class Functor f where fmap : (a -> b) -> f a -> f b in
type T = A | B deriving (Functor) in 0`,
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'kind error: instance Monad Int is rejected',
    code: `class Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad Int where pure = fn x -> x, bind = fn m k -> k m in 0`,
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'missing superclass instance is rejected',
    code: `type Box a = Box a in
class Functor f where fmap : (a -> b) -> f a -> f b in
class Functor m => Monad m where pure : a -> m a, bind : m a -> (a -> m b) -> m b in
instance Monad Box where pure = fn x -> Box x, bind = fn m k -> match m with Box x -> k x in 0`,
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'no instance is rejected',
    code: 'class Disp a where disp : a -> String in disp 5',
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'missing method is rejected',
    code: 'class C a where m : a -> Int, n : a -> Int in instance C Int where m = fn x -> x in 0',
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'ambiguous constraint is rejected',
    code: 'class Def a where def : a in def',
    expected: null,
    expectError: true,
  },
  {
    group: 'errors',
    name: 'duplicate instance is rejected',
    code: `class Disp a where disp : a -> String in
instance Disp Int where disp = fn n -> show n in
instance Disp Int where disp = fn n -> "x" in disp 1`,
    expected: null,
    expectError: true,
  },

  // ---- size-change termination (Aether 13.0): optimization preserves results ----
  {
    group: 'termination',
    name: 'recursive length, repeated (CSE shares it)',
    code: `let rec len = fn xs -> match xs with [] -> 0 | _ :: t -> 1 + len t in
let xs = [1,2,3,4,5] in len xs + len xs`,
    expected: '10',
  },
  {
    group: 'termination',
    name: 'tree fold shared across a product',
    code: `type Tree = Leaf Int | Node Tree Tree in
let rec sumT = fn t -> match t with Leaf n -> n | Node l r -> sumT l + sumT r in
let t = Node (Node (Leaf 1) (Leaf 2)) (Leaf 3) in sumT t * sumT t`,
    expected: '36',
  },
  {
    group: 'termination',
    name: 'Peano-Nat factorial (structural recursion)',
    code: `type Nat = Z | S Nat in
let rec add = fn a b -> match a with Z -> b | S m -> S (add m b) in
let rec mul = fn a b -> match a with Z -> Z | S m -> add b (mul m b) in
let rec fact = fn n -> match n with Z -> S Z | S m -> mul n (fact m) in
let rec toInt = fn n -> match n with Z -> 0 | S m -> 1 + toInt m in
toInt (fact (S (S (S (S Z)))))`,
    expected: '24',
  },
  {
    group: 'termination',
    name: 'mutually-recursive even/odd, unused call dropped',
    code: `let rec ev = fn xs -> match xs with [] -> true | _ :: t -> od t
and od = fn xs -> match xs with [] -> false | _ :: t -> ev t in
let unused = ev [1,2,3] in ev [1,2,3,4]`,
    expected: 'true',
  },
  {
    group: 'termination',
    name: 'Ackermann on Nat (lexicographic descent)',
    code: `type Nat = Z | S Nat in
let rec ack = fn m n -> match m with
  | Z   -> S n
  | S p -> match n with Z -> ack p (S Z) | S q -> ack p (ack (S p) q) in
let rec toInt = fn n -> match n with Z -> 0 | S m -> 1 + toInt m in
toInt (ack (S (S Z)) (S Z))`,
    expected: '5',
  },
  {
    group: 'termination',
    name: 'higher-order map still correct (left unproven)',
    code: `let rec map = fn f xs -> match xs with [] -> [] | h :: t -> f h :: map f t in
map (fn x -> x * x) [1,2,3,4]`,
    expected: '[1, 4, 9, 16]',
  },
]

export function runCase(tc: TestCase): TestResult {
  const base = { group: tc.group, name: tc.name }
  const r = runPipeline(tc.code, { execute: true })

  if (tc.expectError) {
    return r.error
      ? { ...base, ok: true, detail: `rejected: ${r.error.message}`, type: null, jsMatch: null }
      : { ...base, ok: false, detail: 'expected an error but type-checked', type: r.programType, jsMatch: null }
  }

  if (r.error) {
    return { ...base, ok: false, detail: `${r.error.stage} error: ${r.error.message}`, type: null, jsMatch: null }
  }

  const vm = r.run?.result ? valueToString(r.run.result) : '()'
  const vmOut = r.run?.output ?? []
  const valueOk = tc.expected === null || vm === tc.expected
  const jsMatch = checkJsMatch(r.coreAst, vm, vmOut)
  const ok = valueOk && jsMatch
  const detail = !valueOk
    ? `got ${vm}, expected ${tc.expected}`
    : !jsMatch
      ? 'JavaScript backend disagreed with the VM'
      : `${vm}${jsMatch ? '  · JS ≡ VM' : ''}`
  return { ...base, ok, detail, type: r.programType, jsMatch }
}

// Compile the elaborated core to JavaScript, run it, and check the result &
// output match the VM (the byte-for-byte two-backend equivalence claim).
function checkJsMatch(coreAst: Expr | null, vm: string, vmOut: string[]): boolean {
  if (!coreAst) return false
  try {
    const js = runJsModule(compileToJs(coreAst).full)
    return js.error === null && js.result === vm && JSON.stringify(js.output) === JSON.stringify(vmOut)
  } catch {
    return false
  }
}

export function runSuite(): TestResult[] {
  return TEST_CASES.map(runCase)
}
