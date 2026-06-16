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
    id: 'typeclasses',
    title: 'Type classes',
    blurb: 'Principled overloading: one `disp` works for ints, bools, lists and tuples.',
    visual: false,
    code: `// A type class declares an overloaded operation; instances implement it
// for each type. Aether infers qualified types (open the Types tab:
// disp gets used at many types) and compiles classes to DICTIONARY
// PASSING — see the Classes tab for the elaborated core.

class Disp a where
  disp : a -> String
in

instance Disp Int  where disp = fn n -> show n in
instance Disp Bool where disp = fn b -> if b then "yes" else "no" in

// instances can have a context: to show a list, you must be able to
// show its elements. The dictionary for the elements is passed in.
instance Disp a => Disp (List a) where
  disp = fn xs -> "[" ^ join ", " (map disp xs) ^ "]"
in
instance Disp a, Disp b => Disp (a, b) where
  disp = fn p -> match p with (x, y) -> "(" ^ disp x ^ ", " ^ disp y ^ ")"
in

// a constrained, polymorphic helper — note it never names a concrete type
let label = fn x -> "= " ^ disp x in

( disp 42
, disp true
, disp [1, 2, 3]
, disp [(1, true), (2, false)]
, label [[1], [2, 3]] )`,
  },
  {
    id: 'shapes',
    title: 'Ad-hoc polymorphism (Shape)',
    blurb: 'One `area` / `describe` dispatched across distinct Circle and Rect types.',
    visual: false,
    code: `// Unlike an ADT (one type, many constructors), a type class dispatches
// across SEPARATE types. Circle and Rect are different types that both
// have an instance of Shape.

type Circle = MkCircle Float in
type Rect   = MkRect Float Float in

class Shape a where
  area : a -> Float,
  name : a -> String
in

instance Shape Circle where
  area = fn c -> match c with MkCircle r -> pi *. r *. r,
  name = fn c -> "circle"
in
instance Shape Rect where
  area = fn s -> match s with MkRect w h -> w *. h,
  name = fn s -> "rectangle"
in

// constrained polymorphism: describe works for ANY Shape
let describe = fn s -> name s ^ " of area " ^ show (area s) in

( describe (MkCircle 2.0)
, describe (MkRect 3.0 4.0) )`,
  },
  {
    id: 'default-methods',
    title: 'Classes with default methods',
    blurb: 'Define `eq`, get `ne` for free — a default method an instance may override.',
    visual: false,
    code: `// A class method can carry a DEFAULT implementation (in terms of the
// others). An instance only needs to supply what's missing — so an
// "Eq" instance need only define eq, and ne comes along for free.

class Eq a where
  eq : a -> a -> Bool,
  ne : a -> a -> Bool = fn x y -> if eq x y then false else true
in

// Colour as a small enum-like type
type Colour = Red | Green | Blue in

instance Eq Int where
  eq = fn x y -> x == y
in
instance Eq Colour where
  eq = fn x y -> match (x, y) with
    | (Red, Red)     -> true
    | (Green, Green) -> true
    | (Blue, Blue)   -> true
    | _              -> false
in

// a generic membership test, constrained by Eq (note: never names a type)
let rec member = fn x xs ->
  if empty xs then false
  else eq x (head xs) || member x (tail xs) in

( ne 3 4                       // true   — via the default
, eq Green Green               // true
, ne Red Blue                  // true   — default works for Colour too
, member Blue [Red, Green, Blue] )`,
  },
  {
    id: 'semigroup',
    title: 'Semigroup & a generic fold',
    blurb: 'An associative `combine`, then `mconcat` folds any non-empty list of it.',
    visual: false,
    code: `// A Semigroup is anything with an associative "combine" (<>). One
// generic mconcat then works for every instance, because the right
// dictionary is threaded in for us.

type Sum = MkSum Int in

class Semigroup a where
  combine : a -> a -> a
in

instance Semigroup String where combine = fn x y -> x ^ y in
instance Semigroup Sum    where combine = fn x y ->
  match (x, y) with (MkSum a, MkSum b) -> MkSum (a + b) in
// a list is a Semigroup no matter what it holds — no context needed
instance Semigroup (List a) where
  combine = fn x y -> x ++ y
in

// mconcat : Semigroup a => a -> List a -> a   (folds with combine)
let rec mconcat = fn seed xs ->
  if empty xs then seed
  else combine (head xs) (mconcat seed (tail xs)) in

let total = fn xs -> match mconcat (MkSum 0) (map MkSum xs) with MkSum n -> n in

( mconcat "" ["a", "b", "c"]
, total [1, 2, 3, 4, 5]
, mconcat [] [[1, 2], [3], [4, 5]] )`,
  },
  {
    id: 'do-notation',
    title: 'Monadic do-notation',
    blurb: 'do { x <- e; … } desugars to bind — Option short-circuits, List branches.',
    visual: false,
    code: `// do-notation is pure sugar over a 'bind' in scope:
//   do { x <- e ; rest }  ⇒  bind e (fn x -> rest)
//   do { e ; rest }       ⇒  bind e (fn _ -> rest)
// Pick a bind and the same do-block expresses different effects.

type Opt a = None | Some a in

// --- the Option (Maybe) monad: short-circuit on the first None ---
let bind = fn m k -> match m with None -> None | Some x -> k x in
let safeDiv = fn a b -> if b == 0 then None else Some (a / b) in

let chain = fn x ->
  do {
    y <- safeDiv 100 x ;   // None here aborts the whole block
    z <- safeDiv y 2 ;
    Some (z + 1)
  } in

// --- the List monad: every bind branches (cartesian product) ---
let pythag =
  let bind = fn m k -> concat (map k m) in   // shadow bind locally
  do {
    a <- range 1 21 ;
    b <- range a 21 ;
    c <- range b 21 ;
    if a * a + b * b == c * c then [ (a, b, c) ] else []
  } in

( chain 5      // Some 11
, chain 0      // None  — division by zero short-circuits
, pythag )     // every Pythagorean triple with sides ≤ 20`,
  },
  {
    id: 'property',
    title: 'Property-based testing',
    blurb: 'Open the Check tab: laws are tested on random inputs, failures shrink.',
    visual: false,
    code: `// Aether Check — QuickCheck, driven by the type checker.
// Open the "Check" tab and press "Run property tests": each prop_* function
// is fed random inputs generated from its INFERRED type, and any failure is
// shrunk to a minimal counterexample.

let rec insert = fn x xs ->
  match xs with
    [] -> [x]
  | h :: t -> if x <= h then x :: xs else h :: insert x t in

let rec sort = fn xs ->
  match xs with [] -> [] | h :: t -> insert h (sort t) in

let rec isSorted = fn xs ->
  match xs with
    [] -> true
  | x :: rest ->
      match rest with [] -> true | y :: _ -> if x <= y then isSorted rest else false in

// Laws that hold for every list (Check reports ✓ passed):
let prop_rev_involutive = fn xs -> reverse (reverse xs) == xs in
let prop_sort_is_sorted = fn xs -> isSorted (sort xs) in
let prop_sort_keeps_len = fn xs -> length (sort xs) == length xs in

// Higher-order: Check even generates random FUNCTIONS from their type.
// (map fusion: mapping g then f equals mapping their composition.)
let prop_map_fusion = fn f g xs -> map f (map g xs) == map (fn x -> f (g x)) xs in

// A deliberately BUGGY sort that drops duplicates. Check falsifies the
// length law and shrinks to a minimal two-element list of equal values.
let rec badInsert = fn x xs ->
  match xs with
    [] -> [x]
  | h :: t ->
      if x == h then xs
      else if x <= h then x :: xs else h :: badInsert x t in
let rec badSort = fn xs ->
  match xs with [] -> [] | h :: t -> badInsert h (badSort t) in
let prop_badsort_keeps_len = fn xs -> length (badSort xs) == length xs in

sort [5, 3, 8, 1, 3, 9, 2]`,
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
  {
    id: 'monad-hierarchy',
    title: 'Functor → Applicative → Monad',
    blurb: 'A higher-kinded class hierarchy: one mapM, every monad — Option and List.',
    visual: false,
    code: `// Higher-kinded type classes. \`Monad m\` abstracts over a type
// CONSTRUCTOR m (kind * -> *), so a single generic combinator runs in
// every monad. Open the Classes tab to see each class's inferred kind
// and the superclass dictionaries; the Types tab shows mapM's scheme.
type Option a = None | Some a in

class Functor f where
  fmap : (a -> b) -> f a -> f b in
class Functor f => Applicative f where
  pure : a -> f a,
  ap   : f (a -> b) -> f a -> f b in
class Applicative m => Monad m where
  bind : m a -> (a -> m b) -> m b in

instance Functor Option where
  fmap = fn g x -> match x with None -> None | Some v -> Some (g v) in
instance Applicative Option where
  pure = fn x -> Some x,
  ap   = fn mf mx -> match mf with None -> None | Some f -> fmap f mx in
instance Monad Option where
  bind = fn m k -> match m with None -> None | Some x -> k x in

instance Functor List where
  fmap = fn g xs -> map g xs in
instance Applicative List where
  pure = fn x -> [x],
  ap   = fn fs xs -> concat (map (fn f -> map f xs) fs) in
instance Monad List where
  bind = fn m k -> concat (map k m) in

// Defined ONCE, constrained only by Monad — runs in any monad.
// do-notation desugars to the overloaded \`bind\`, resolved by type.
let rec mapM = fn f xs ->
  if empty xs then pure []
  else do {
    y  <- f (head xs) ;
    ys <- mapM f (tail xs) ;
    pure (y :: ys)
  } in

let safe = fn x -> if x > 0 then Some x else None in

( mapM safe [1, 2, 3]                 // Some [1, 2, 3]
, mapM safe [1, 0, 3]                 // None — one failure aborts
, mapM (fn x -> [x, x * 10]) [1, 2] ) // List monad: every combination`,
  },
  {
    id: 'state-monad',
    title: 'The State monad',
    blurb: 'Monad (State s): a partially-applied constructor as a monad, threaded by do.',
    visual: false,
    code: `// A two-parameter type used as a one-parameter monad: the instance head
// is the PARTIALLY-APPLIED constructor \`State s\` (kind * -> *). do-notation
// threads the hidden state for you — no mutation anywhere.
type State s a = State (s -> (a, s)) in
let runState = fn st s -> match st with State f -> f s in

class Functor f where fmap : (a -> b) -> f a -> f b in
class Functor f => Applicative f where
  pure : a -> f a,
  ap   : f (a -> b) -> f a -> f b in
class Applicative m => Monad m where
  bind : m a -> (a -> m b) -> m b in

instance Functor (State s) where
  fmap = fn g st -> State (fn s0 -> match runState st s0 with (a, s1) -> (g a, s1)) in
instance Applicative (State s) where
  pure = fn x -> State (fn s0 -> (x, s0)),
  ap = fn stf stx -> State (fn s0 ->
    match runState stf s0 with (f, s1) ->
    match runState stx s1 with (x, s2) -> (f x, s2)) in
instance Monad (State s) where
  bind = fn m k -> State (fn s0 -> match runState m s0 with (a, s1) -> runState (k a) s1) in

// tick: read the counter and increment it
let tick = State (fn n -> (n, n + 1)) in

// number a list with an increasing index, all in the State monad
let rec number = fn xs ->
  if empty xs then pure []
  else do {
    i    <- tick ;
    rest <- number (tail xs) ;
    pure ((i, head xs) :: rest)
  } in

runState (number [10, 20, 30]) 0   // ([(0,10), (1,20), (2,30)], 3)`,
  },
  {
    id: 'result-monad',
    title: 'Typed errors — the Result monad',
    blurb: 'Result e a as a monad; Kleisli >=> and a polymorphic traverse short-circuit on Err.',
    visual: false,
    code: `// Error handling without exceptions: a two-parameter type \`Result e a\`
// used as the monad \`Result e\`. bind threads the Ok value and
// short-circuits on the first Err — and traverse inherits that for free.
type Result e a = Err e | Ok a in

class Functor f where fmap : (a -> b) -> f a -> f b in
class Functor f => Applicative f where
  pure : a -> f a,
  ap   : f (a -> b) -> f a -> f b in
class Applicative m => Monad m where
  bind : m a -> (a -> m b) -> m b in

instance Functor (Result e) where
  fmap = fn g r -> match r with Err x -> Err x | Ok v -> Ok (g v) in
instance Applicative (Result e) where
  pure = fn x -> Ok x,
  ap = fn rf rx -> match rf with Err x -> Err x | Ok f -> fmap f rx in
instance Monad (Result e) where
  bind = fn r k -> match r with Err x -> Err x | Ok v -> k v in

// Kleisli composition (f >=> g): chain two error-producing steps
let kleisli = fn f g -> fn x -> bind (f x) g in

let checkPos = fn x -> if x > 0 then Ok x else Err "not positive" in
let half     = fn x -> if x % 2 == 0 then Ok (x / 2) else Err "odd number" in
let step     = kleisli checkPos half in

// traverse a list, short-circuiting on the first Err — defined generically
let rec traverse = fn f xs ->
  if empty xs then pure []
  else do { y <- f (head xs) ; ys <- traverse f (tail xs) ; pure (y :: ys) } in

( step 8                       // Ok 4
, step 7                       // Err "odd number"
, traverse checkPos [1, 2, 3]  // Ok [1, 2, 3]
, traverse checkPos [1, 0, 3]) // Err "not positive" (aborts on 0)`,
  },
  {
    id: 'deriving',
    title: 'deriving (Eq, Ord, Show)',
    blurb: 'One clause synthesises whole instances — then sort cards by them.',
    visual: false,
    code: `// A 'deriving' clause makes the compiler WRITE the instances for you,
// generating each method from the data type's shape. Here Suit & Card get
// structural equality, lexicographic ordering and a Haskell-style show — all
// synthesised, all running identically on the bytecode VM and the JS backend.
//
// Only the leaf types need hand-written instances; everything structural is
// derived, and the instance contexts (Eq a => …) are inferred for you.

let primShow = show in
class Eq a   where eq      : a -> a -> Bool in
class Ord a  where compare : a -> a -> Int  in     // -1 / 0 / 1
class Show a where show    : a -> String    in

instance Eq Int   where eq      = fn a b -> a == b in
instance Ord Int  where compare = fn a b -> if a < b then -1 else if a == b then 0 else 1 in
instance Show Int where show    = primShow in

type Suit = Clubs | Diamonds | Hearts | Spades   deriving (Eq, Ord, Show) in
type Card = Card Suit Int                         deriving (Eq, Ord, Show) in

// insertion sort using the DERIVED ordering (suit first, then rank):
let rec insert = fn x ys ->
  if empty ys then [x]
  else if compare x (head ys) <= 0 then x :: ys
  else head ys :: insert x (tail ys) in
let sortCards = foldr insert [] in

let hand = [Card Spades 10, Card Clubs 14, Card Spades 3, Card Hearts 14] in
( map show (sortCards hand)
, eq (Card Hearts 14) (Card Hearts 14)
, compare (Card Clubs 14) (Card Spades 3) )   // Clubs < Spades  ⇒  -1`,
  },
  {
    id: 'deriving-enum',
    title: 'deriving (Enum, Bounded)',
    blurb: 'Turn a plain enum into something you can enumerate and bound.',
    visual: false,
    code: `// Deriving Enum and Bounded turns a C-style enum into something the rest of
// the language can iterate over: fromEnum/toEnum index each constructor, and
// minBound/maxBound fence the type. (There are no type annotations in Aether,
// so we 'pin' a polymorphic method's type with a concrete constructor.)

class Eq a      where eq       : a -> a -> Bool in
class Show a    where show     : a -> String    in
class Enum a    where fromEnum : a -> Int, toEnum : Int -> a in
class Bounded a where minBound : a, maxBound : a in

type Day = Mon | Tue | Wed | Thu | Fri | Sat | Sun
  deriving (Eq, Show, Enum, Bounded) in

let allDays = Mon :: map toEnum (range 1 7) in   // 'Mon ::' pins toEnum to Day
let first   = max Mon minBound in                // = minBound, pinned to Day
let last    = max Sun maxBound in                // = maxBound, pinned to Day
let isWeekend = fn d -> eq d Sat || eq d Sun in

( map show allDays
, map show (filter isWeekend allDays)
, (show first, show last, fromEnum Wed) )`,
  },
  {
    id: 'deriving-functor',
    title: 'deriving (Functor, Foldable)',
    blurb: 'The compiler writes fmap AND foldr from a type’s shape.',
    visual: false,
    code: `// The headline: 'deriving Functor' synthesises fmap and 'deriving Foldable'
// synthesises foldr, both by reading the data type's shape — walking the LAST
// type parameter where it sits directly and RECURSING through the type itself,
// through lists and through tuples. No instance body to write.

class Functor f  where fmap  : (a -> b) -> f a -> f b in
class Foldable t where foldr : (a -> b -> b) -> b -> t a -> b in

type Tree a = Leaf | Node (Tree a) a (Tree a) deriving (Functor, Foldable) in
type Rose a = Rose a (List (Rose a))          deriving (Functor) in

// generic, work for ANY Foldable:
let toList = fn xs -> foldr (fn x acc -> x :: acc) [] xs in
let total  = fn xs -> foldr (fn x acc -> x + acc) 0 xs in

let t = Node (Node Leaf 1 Leaf) 2 (Node Leaf 3 Leaf) in
let r = Rose 1 [Rose 2 [], Rose 3 [Rose 4 []]] in
let rec sumRose = fn rs -> match rs with
  Rose x kids -> x + sum (map sumRose kids) in

( toList t                            // in-order: [1, 2, 3]
, total (fmap (fn x -> x * x) t)      // 1 + 4 + 9 = 14
, sumRose (fmap (fn x -> x + 100) r)) // (1+2+3+4) + 4*100 = 410`,
  },
]

export const DEFAULT_CODE = EXAMPLES[0].code

export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((e) => e.id === id)
}
