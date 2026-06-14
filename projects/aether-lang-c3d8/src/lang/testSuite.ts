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

  // ---- errors (must be rejected) ----
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
