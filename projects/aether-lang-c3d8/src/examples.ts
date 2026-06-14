// Curated example programs for the gallery and the playground's default.

export interface Example {
  id: string
  title: string
  blurb: string
  /** does this example draw to the canvas? */
  visual: boolean
  code: string
}

export const EXAMPLES: Example[] = [
  {
    id: 'tour',
    title: 'Language tour',
    blurb: 'Polymorphism, closures, lists and recursion in one snippet.',
    visual: false,
    code: `// Aether — a tiny ML-family language compiled to bytecode.
// Everything below is type-inferred (hover the type panel).

let id = fn x -> x in          // ∀ a. a -> a
let compose = fn f g x -> f (g x) in

let rec fact n =
  if n <= 1 then 1 else n * fact (n - 1) in

let squares = [ x * x | x <- range 1 8 ] in   // a list comprehension

(id 42, compose (fn x -> x + 1) (fn x -> x * 2) 10, fact 6, squares)`,
  },
  {
    id: 'fib',
    title: 'Fibonacci',
    blurb: 'Naive tree recursion — great for the time-travel debugger.',
    visual: false,
    code: `let rec fib n =
  if n < 2 then n
  else fib (n - 1) + fib (n - 2) in

map fib (range 0 15)`,
  },
  {
    id: 'quicksort',
    title: 'Quicksort',
    blurb: 'Higher-order filtering and list append.',
    visual: false,
    code: `let rec sort xs =
  if empty xs then []
  else
    let pivot = head xs in
    let rest  = tail xs in
    let lo = filter (fn x -> x < pivot) rest in
    let hi = filter (fn x -> x >= pivot) rest in
    sort lo ++ (pivot :: sort hi) in

sort [5, 3, 8, 1, 9, 2, 7, 4, 6, 0]`,
  },
  {
    id: 'tree',
    title: 'Fractal tree',
    blurb: 'A recursive function drives the turtle to draw a binary tree.',
    visual: true,
    code: `// A functional program that draws. The turtle starts facing up.
let rec tree len depth =
  if depth == 0 then ()
  else (
    width (toFloat depth);
    color (40 + depth * 22) (120 + depth * 12) 90;
    forward len;
    push ();
      turn 28.0;
      tree (len *. 0.72) (depth - 1);
    pop ();
    push ();
      turn (0.0 -. 32.0);
      tree (len *. 0.72) (depth - 1);
    pop ();
    back len
  ) in

tree 120.0 10`,
  },
  {
    id: 'koch',
    title: 'Koch snowflake',
    blurb: 'Classic L-system curve via mutual recursion over depth.',
    visual: true,
    code: `let rec koch len depth =
  if depth == 0 then forward len
  else
    let l = len /. 3.0 in (
      koch l (depth - 1); turn 60.0;
      koch l (depth - 1); turn (0.0 -. 120.0);
      koch l (depth - 1); turn 60.0;
      koch l (depth - 1)
    ) in

let rec side n =
  if n == 0 then ()
  else ( koch 240.0 3; turn (0.0 -. 120.0); side (n - 1) ) in

color 120 200 255;
side 3`,
  },
  {
    id: 'sierpinski',
    title: 'Sierpinski arrowhead',
    blurb: 'The Sierpinski triangle drawn by two mutually recursive turtle rules.',
    visual: true,
    code: `// An L-system (A -> B-A-B, B -> A+B+A) as two mutually
// recursive functions — a great use of 'let rec … and …'.
let rec a n len =
  if n == 0 then forward len
  else (
    color (60 + n * 18) 200 (120 + n * 10);
    b (n - 1) (len /. 2.0); turn (0.0 -. 60.0);
    a (n - 1) (len /. 2.0); turn (0.0 -. 60.0);
    b (n - 1) (len /. 2.0)
  )
and b n len =
  if n == 0 then forward len
  else (
    a (n - 1) (len /. 2.0); turn 60.0;
    b (n - 1) (len /. 2.0); turn 60.0;
    a (n - 1) (len /. 2.0)
  ) in

a 6 320.0`,
  },
  {
    id: 'dragon',
    title: 'Dragon curve',
    blurb: 'The Heighway dragon — a self-similar fractal from a tiny recursion.',
    visual: true,
    code: `let rec dragon n sign =
  if n == 0 then forward 7.0
  else (
    dragon (n - 1) 1.0;
    turn (sign *. 90.0);
    dragon (n - 1) (0.0 -. 1.0)
  ) in

color 120 200 255;
dragon 12 1.0`,
  },
  {
    id: 'spiral',
    title: 'Polygon spiral',
    blurb: 'Accumulating angle and length with simple recursion.',
    visual: true,
    code: `let rec spiral len angle steps =
  if steps == 0 then ()
  else (
    color (steps * 3) (120 + steps) 200;
    forward len;
    turn angle;
    spiral (len +. 2.0) angle (steps - 1)
  ) in

spiral 4.0 59.5 140`,
  },
  {
    id: 'patterns',
    title: 'Pattern matching',
    blurb: 'Destructure lists and tuples with match — run-length encoding.',
    visual: false,
    code: `// match destructures lists (::, [], [x, y]) and tuples.
let rec encode xs =
  match xs with
  | [] -> []
  | x :: rest ->
      match encode rest with
      | (n, y) :: tl ->
          if x == y then (n + 1, y) :: tl
          else (1, x) :: (n, y) :: tl
      | other -> (1, x) :: other in

let decode =
  let rec go pairs =
    match pairs with
    | [] -> []
    | (n, x) :: tl ->
        let rec rep k = if k == 0 then [] else x :: rep (k - 1) in
        rep n ++ go tl in
  go in

let data = [1, 1, 1, 2, 2, 3, 1, 1] in
let packed = encode data in
(packed, decode packed)`,
  },
  {
    id: 'adt',
    title: 'Algebraic data types',
    blurb: 'Declare your own types, then write a tiny expression interpreter.',
    visual: false,
    code: `// Define a recursive data type, then pattern-match over it.
type Expr =
  | Num Int
  | Add Expr Expr
  | Mul Expr Expr
  | Neg Expr in

let rec eval e =
  match e with
  | Num n     -> n
  | Add a b   -> eval a + eval b
  | Mul a b   -> eval a * eval b
  | Neg x     -> 0 - eval x in

// (3 + 4) * -(5)   ==>  -35
let program = Mul (Add (Num 3) (Num 4)) (Neg (Num 5)) in
eval program`,
  },
  {
    id: 'maybe',
    title: 'Option & safe lookup',
    blurb: 'A polymorphic Option type for computations that can fail.',
    visual: false,
    code: `type Option a = None | Some a in

let rec lookup key pairs =
  match pairs with
  | []           -> None
  | (k, v) :: tl -> if k == key then Some v else lookup key tl in

let withDefault d o =
  match o with
  | None   -> d
  | Some x -> x in

let table = [(1, "one"), (2, "two"), (3, "three")] in
( withDefault "?" (lookup 2 table)
, withDefault "?" (lookup 9 table) )`,
  },
  {
    id: 'mutual',
    title: 'Mutual recursion',
    blurb: 'Two functions that call each other, defined with let rec … and ….',
    visual: false,
    code: `// Mutually recursive predicates — each is in scope for the other.
let rec isEven n = if n == 0 then true  else isOdd  (n - 1)
and     isOdd  n = if n == 0 then false else isEven (n - 1) in

( filter isEven (range 0 12)
, filter isOdd  (range 0 12) )`,
  },
  {
    id: 'records',
    title: 'Records & row polymorphism',
    blurb: 'Structural records where one function works on any record with the right field.',
    visual: false,
    code: `// Records are structural; field access is row-polymorphic, so this
// 'norm' works on ANY record that has x and y (whatever else it holds).
let norm = fn p -> p.x *. p.x +. p.y *. p.y in

let a = { x = 3.0, y = 4.0 } in
let b = { x = 1.0, y = 2.0, label = "b", tag = 7 } in

// functional update { r | … } keeps every other field (and is row-polymorphic)
let move = fn p dx dy -> { p | x = p.x +. dx, y = p.y +. dy } in

( norm a                  // 25.0
, norm b                  // 5.0  — extra fields are fine
, (move b 1.0 1.0).label  // "b" — update preserved it
)`,
  },
  {
    id: 'fizzbuzz',
    title: 'FizzBuzz',
    blurb: 'Modulo, the pipe operator, map and join.',
    visual: false,
    code: `let fizzbuzz = fn n ->
  if n % 15 == 0 then "FizzBuzz"
  else if n % 3 == 0 then "Fizz"
  else if n % 5 == 0 then "Buzz"
  else show n in

// the pipe operator |> threads a value through a chain of functions
range 1 21
  |> map fizzbuzz
  |> join " "`,
  },
  {
    id: 'guards',
    title: 'Pattern guards',
    blurb: 'Refine match clauses with `when` boolean guards.',
    visual: false,
    code: `// A guard (when …) lets a clause match only if a condition holds.
let classify = fn n ->
  match n with
  | 0                 -> "zero"
  | n when n < 0      -> "negative"
  | n when n % 2 == 0 -> "even"
  | _                 -> "odd" in

[0, 0 - 4, 6, 7]
  |> map classify
  |> join ", "`,
  },
  {
    id: 'comprehensions',
    title: 'List comprehensions',
    blurb: 'Primes and Pythagorean triples — generators & guards desugar to map/filter/concat.',
    visual: false,
    code: `// [ e | x <- xs, guard, y <- ys ] is sugar that desugars to
// concat / map / filter — so it type-checks (HM) and runs on BOTH
// the bytecode VM and the JavaScript backend.

let isPrime = fn n ->
  n > 1 && empty [ d | d <- range 2 n, n % d == 0 ] in

let primes = [ n | n <- range 2 60, isPrime n ] in

// every (a, b, c) with a <= b <= c and a*a + b*b == c*c
let triples =
  [ (a, b, c)
  | c <- range 1 21
  , b <- range 1 c
  , a <- range 1 b
  , a * a + b * b == c * c ] in

(primes, triples)`,
  },
  {
    id: 'js-backend',
    title: 'Compile me to JavaScript',
    blurb: 'Open the JavaScript tab, hit Run — this program is compiled to JS and matches the VM.',
    visual: false,
    code: `// Aether has two backends. This program is compiled to a stack-machine
// bytecode AND (open the "JavaScript" tab) to self-contained JavaScript.
// Press "Run JavaScript & compare" — the two backends agree byte-for-byte.

let greet = fn name -> "Hello, " ^ name ^ "!" in

type Shape =
  | Circle Float
  | Rect Float Float in

let area = fn s ->
  match s with
  | Circle r   -> pi *. r *. r
  | Rect w h   -> w *. h in

( map greet ["Ada", "Alan", "Grace"]
, [ n * n | n <- range 1 11 ]
, map area [Circle 1.0, Rect 3.0 4.0]
, foldl (fn a x -> a + x) 0 (range 1 101) )`,
  },
  {
    id: 'church',
    title: 'Church numerals',
    blurb: 'Encoding numbers as higher-order functions — pure lambda calculus.',
    visual: false,
    code: `// Numbers as functions: n applies f n times.
let zero = fn f x -> x in
let succ = fn n f x -> f (n f x) in
let add  = fn m n f x -> m f (n f x) in

let two   = succ (succ zero) in
let three = succ two in
let five  = add two three in

// Reify a Church numeral into an Int by counting (+1) from 0.
let toInt = fn n -> n (fn x -> x + 1) 0 in

(toInt two, toInt three, toInt five)`,
  },
]

export const DEFAULT_CODE = EXAMPLES[0].code

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id)
}
