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

let squares = map (fn x -> x * x) (range 1 8) in

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
