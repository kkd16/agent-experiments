export default function Tour() {
  return (
    <div className="page tour-page">
      <h1>The Aether language</h1>
      <p className="page-lead">
        Aether is a small, statically-typed functional language in the ML family. It has no type
        annotations — every type is <em>inferred</em>. Here is the whole language.
      </p>

      <section>
        <h2>Values &amp; literals</h2>
        <pre className="snippet">{`42            // Int
3.14          // Float
true  false   // Bool
"hello"       // String
()            // Unit
[1, 2, 3]     // List Int
(1, "a", true) // a tuple`}</pre>
      </section>

      <section>
        <h2>Functions are curried</h2>
        <p>
          <code>fn a b -&gt; …</code> is sugar for nested one-argument lambdas, so partial
          application just works. <code>let f a b = …</code> is sugar for <code>let f = fn a b -&gt; …</code>.
        </p>
        <pre className="snippet">{`let add = fn a b -> a + b in
let inc = add 1 in   // partial application
inc 41               // => 42`}</pre>
      </section>

      <section>
        <h2>let, let rec, and if</h2>
        <pre className="snippet">{`let x = 10 in x * x

let rec fact n =
  if n <= 1 then 1 else n * fact (n - 1) in
fact 5`}</pre>
        <p>
          Bindings are <strong>generalised</strong>: <code>let id = fn x -&gt; x</code> has type{' '}
          <code>∀ a. a -&gt; a</code> and can be applied at many types in the same scope.
        </p>
        <p>
          Define <strong>mutually recursive</strong> functions with <code>and</code> — each is in
          scope for the others (and tail calls between them are still optimised):
        </p>
        <pre className="snippet">{`let rec isEven n = if n == 0 then true  else isOdd  (n - 1)
and     isOdd  n = if n == 0 then false else isEven (n - 1) in
isEven 10   // => true`}</pre>
      </section>

      <section>
        <h2>Your own types</h2>
        <p>
          Declare algebraic data types with <code>type</code>; they can be polymorphic and
          recursive. Constructors are ordinary (curried) functions, and you take them apart with
          <code>match</code>.
        </p>
        <pre className="snippet">{`type Option a = None | Some a in
type Tree a = Leaf | Node (Tree a) a (Tree a) in

let rec size t =
  match t with
  | Leaf       -> 0
  | Node l _ r -> 1 + size l + size r in
size (Node Leaf 1 (Node Leaf 2 Leaf))   // => 2`}</pre>
        <p>
          Nullary constructors like <code>None</code> are values; constructors with arguments (like{' '}
          <code>Some</code>) are functions you can even pass to <code>map</code>.
        </p>
      </section>

      <section>
        <h2>Pattern matching</h2>
        <p>
          <code>match</code> destructures values against patterns, tried top to bottom. Patterns
          can be literals, <code>_</code> (wildcard), variables, tuples, and lists
          (<code>[]</code>, <code>h :: t</code>, <code>[a, b]</code>).
        </p>
        <pre className="snippet">{`let rec len xs =
  match xs with
  | []      -> 0
  | _ :: t  -> 1 + len t in
len [10, 20, 30]   // => 3`}</pre>
        <p>
          Bindings introduced by a pattern are in scope in that case's body. A value that matches
          no case raises a runtime error.
        </p>
        <p>
          A clause can carry a <strong>guard</strong> with <code>when</code> — it only matches when
          the condition holds, otherwise the next clause is tried:
        </p>
        <pre className="snippet">{`match n with
| 0            -> "zero"
| n when n < 0 -> "negative"
| _            -> "positive"`}</pre>
        <p>
          Matches are checked for <strong>exhaustiveness</strong>: a missing case is flagged with a
          witness it doesn't cover (e.g. <code>_ :: _</code> or <code>None</code>), and clauses that
          can never be reached are warned about too. (Guarded clauses don't count toward coverage,
          since their guard might be false.)
        </p>
      </section>

      <section>
        <h2>Records (row-polymorphic)</h2>
        <p>
          Records are structural: <code>{'{ x = 1, y = 2 }'}</code> has type{' '}
          <code>{'{ x: Int, y: Int }'}</code>, and you read fields with <code>r.x</code>. Field
          access is <strong>row-polymorphic</strong>, so a function constraining one field works on
          any record that has it:
        </p>
        <pre className="snippet">{`let getX = fn r -> r.x in
( getX { x = 1, y = 2 }        // 1
, getX { x = 9, name = "z" } ) // 9 — extra fields are fine`}</pre>
        <p>
          That <code>getX</code> is inferred as <code>{'{ x: a | r } -> a'}</code> — the{' '}
          <code>r</code> is a row variable standing for "any other fields".
        </p>
        <p>
          Make a modified copy with <strong>functional update</strong>{' '}
          <code>{'{ r | field = … }'}</code> — every other field is carried over, and the field's
          type is preserved:
        </p>
        <pre className="snippet">{`let p = { x = 1, y = 2, name = "p" } in
{ p | x = 10 }    // { x = 10, y = 2, name = "p" }  (p is unchanged)`}</pre>
      </section>

      <section>
        <h2>Type classes (overloading)</h2>
        <p>
          A <strong>type class</strong> names an operation that many types can implement, and an{' '}
          <strong>instance</strong> implements it for one type. Inference produces a{' '}
          <em>qualified</em> type like <code>∀a. Disp a =&gt; a -&gt; String</code>: the{' '}
          <code>Disp a =&gt;</code> means "for any <code>a</code> that has a <code>Disp</code>{' '}
          instance".
        </p>
        <pre className="snippet">{`class Disp a where
  disp : a -> String
in
instance Disp Int  where disp = fn n -> show n in
instance Disp Bool where disp = fn b -> if b then "yes" else "no" in

(disp 42, disp true)              // ("42", "yes")`}</pre>
        <p>
          Instances can carry a <strong>context</strong>: to show a list you must be able to show
          its elements, written <code>instance Disp a =&gt; Disp (List a)</code>. Aether resolves
          every constraint and compiles classes to <strong>dictionary passing</strong> — an instance
          becomes a record of methods, a constrained function takes the dictionary as a hidden
          argument, and a method call is a field access. Open the <strong>Classes</strong> tab to see
          the elaborated core; both backends run it unchanged.
        </p>
        <pre className="snippet">{`instance Disp a => Disp (List a) where
  disp = fn xs -> "[" ^ join ", " (map disp xs) ^ "]"
in
disp [1, 2, 3]                    // "[1, 2, 3]"`}</pre>
        <p>
          A method may declare a <strong>default</strong> in terms of the others, so an instance
          only supplies what's missing — define <code>eq</code> and get <code>ne</code> free:
        </p>
        <pre className="snippet">{`class Eq a where
  eq : a -> a -> Bool,
  ne : a -> a -> Bool = fn x y -> if eq x y then false else true
in
instance Eq Int where eq = fn x y -> x == y in
(eq 3 3, ne 3 4)                  // (true, true)`}</pre>
      </section>

      <section>
        <h2>Higher-kinded classes &amp; superclasses</h2>
        <p>
          A class can range over a <strong>type constructor</strong>, not just a proper type. In{' '}
          <code>class Monad m where bind : m a -&gt; (a -&gt; m b) -&gt; m b</code>, the parameter{' '}
          <code>m</code> is applied to arguments, so it has <strong>kind</strong> <code>* -&gt; *</code>{' '}
          (a type that still needs one argument, like <code>Option</code> or <code>List</code>). Kinds
          are <em>inferred</em> — Aether reads each class parameter's kind off how its methods use it —
          and ill-kinded instances such as <code>instance Monad Int</code> are rejected
          (<code>Int : *</code>, not <code>* -&gt; *</code>). The <strong>Classes</strong> tab shows
          every class's inferred kind.
        </p>
        <p>
          Classes may have <strong>superclasses</strong> (<code>class Functor f =&gt; Monad f</code>):
          a <code>Monad m</code> constraint then <em>entails</em> a <code>Functor m</code> one, so a
          function written with only <code>Monad</code> in its context still gets <code>fmap</code>.
          Because <code>m</code> is higher-kinded, one generic combinator runs in <em>every</em> monad:
        </p>
        <pre className="snippet">{`class Functor f => Monad f where
  pure : a -> f a,
  bind : f a -> (a -> f b) -> f b
in
// defined once; works for Option, List, State, …
let rec mapM = fn f xs ->
  if empty xs then pure []
  else do { y <- f (head xs)
          ; ys <- mapM f (tail xs)
          ; pure (y :: ys) }
in
mapM (fn x -> if x > 0 then Some x else None) [1, 2, 3]  // Some [1, 2, 3]`}</pre>
        <p>
          See the <strong>Functor → Applicative → Monad</strong> and <strong>State monad</strong>{' '}
          examples in the gallery for the full instances.
        </p>
      </section>

      <section>
        <h2>deriving (instances for free)</h2>
        <p>
          Writing the rote, structural instances by hand gets old fast. A data type can end with a{' '}
          <code>deriving (…)</code> clause and the compiler <strong>synthesises the instances</strong>,
          generating each method from the type's shape:
        </p>
        <pre className="snippet">{`type Suit = Clubs | Diamonds | Hearts | Spades deriving (Eq, Ord, Show) in
type Card = Card Suit Int                       deriving (Eq, Ord, Show) in
compare (Card Clubs 14) (Card Spades 3)   // Clubs < Spades  =>  -1`}</pre>
        <p>
          <code>Eq</code> compares constructors structurally, <code>Ord</code> orders by constructor
          declaration order then lexicographically by fields (<code>compare : a -&gt; a -&gt; Int</code>,
          −1/0/1), and <code>Show</code> prints Haskell-style <code>(Ctor f₁ f₂ …)</code>. Recursion goes
          through the class method, so a parametric or recursive type gets an <strong>inferred
          context</strong> like <code>Eq a =&gt; Eq (Tree a)</code>. <code>Enum</code>/<code>Bounded</code>{' '}
          enumerate and fence a C-style enum (<code>fromEnum</code>/<code>toEnum</code>,{' '}
          <code>minBound</code>/<code>maxBound</code>).
        </p>
        <p>
          The headline is <strong>deriving Functor</strong> and <strong>deriving Foldable</strong>: the
          compiler writes <code>fmap</code> and <code>foldr</code> by walking the type's <em>last</em>{' '}
          parameter, recursing through the type itself, through <code>List</code> and through tuples.
        </p>
        <pre className="snippet">{`type Tree a = Leaf | Node (Tree a) a (Tree a) deriving (Functor, Foldable) in
let toList = fn xs -> foldr (fn x acc -> x :: acc) [] xs in
toList (fmap (fn x -> x * 10) (Node Leaf 1 (Node Leaf 2 Leaf)))  // [10, 20]`}</pre>
        <p>
          It is all <strong>parse-time desugaring</strong> into ordinary <code>instance</code>{' '}
          declarations — so both backends run derived instances unchanged, and the{' '}
          <strong>Classes</strong> tab badges them <em>derived</em>.
        </p>
      </section>

      <section>
        <h2>List comprehensions</h2>
        <p>
          <code>[ e | x &lt;- xs, guard, y &lt;- ys ]</code> builds a list from one or more{' '}
          <strong>generators</strong> (<code>x &lt;- xs</code>) and boolean <strong>guards</strong>.
          It's pure sugar: the parser desugars it to <code>concat</code>, <code>map</code> and{' '}
          <code>if</code>, so it's fully type-inferred and runs on both backends.
        </p>
        <pre className="snippet">{`[ x * x | x <- range 1 6 ]              // [1, 4, 9, 16, 25]
[ x | x <- range 1 20, x % 3 == 0 ]    // [3, 6, 9, 12, 15, 18]
[ (a, b, c)
| c <- range 1 21, b <- range 1 c, a <- range 1 b
, a * a + b * b == c * c ]             // Pythagorean triples`}</pre>
      </section>

      <section>
        <h2>do-notation (monads)</h2>
        <p>
          <code>do {'{'} x &lt;- e; … {'}'}</code> is pure sugar over a <code>bind</code> in scope —
          exactly how <code>do</code> works in Haskell, just resolved to whatever <code>bind</code>{' '}
          you've defined:
        </p>
        <pre className="snippet">{`do { x <- e ; rest }  =>  bind e (fn x -> rest)
do { e ; rest }       =>  bind e (fn _ -> rest)
do { e }              =>  e`}</pre>
        <p>
          Pick a <code>bind</code> and the same block expresses a different effect — the Option
          (Maybe) monad short-circuits on the first <code>None</code>, the List monad branches over
          every choice. Bind the genuine <code>Monad</code> class method instead and the block is
          resolved <em>by type</em>, so one <code>do</code> works for any monad:
        </p>
        <pre className="snippet">{`type Opt a = None | Some a in
let bind = fn m k -> match m with None -> None | Some x -> k x in
let sd = fn a b -> if b == 0 then None else Some (a / b) in
do { y <- sd 100 5 ; z <- sd y 2 ; Some (z + 1) }   // Some 11`}</pre>
      </section>

      <section>
        <h2>Property-based testing</h2>
        <p>
          Open the <strong>Check</strong> tab. Write a <code>prop_…</code> function that returns{' '}
          <code>Bool</code>; Aether reads its <em>inferred type</em>, generates random inputs from
          that type (numbers, strings, lists, tuples, records and your own ADTs — recursively), runs
          hundreds of cases through the VM, and <strong>shrinks</strong> any failure to a minimal
          counterexample. Polymorphic arguments default to <code>Int</code>; runs are deterministic.
        </p>
        <pre className="snippet">{`let prop_rev = fn xs -> reverse (reverse xs) == xs in   // ✓ passes
let prop_bad = fn xs -> reverse xs == xs in             // ✗ shrinks to [0, -1]
prop_rev`}</pre>
      </section>

      <section>
        <h2>Operators</h2>
        <table className="op-table">
          <tbody>
            <tr><td><code>+ - * / %</code></td><td>integer arithmetic (% is modulo)</td></tr>
            <tr><td><code>+. -. *. /.</code></td><td>floating-point arithmetic</td></tr>
            <tr><td><code>== != &lt; &gt; &lt;= &gt;=</code></td><td>structural comparison (polymorphic)</td></tr>
            <tr><td><code>&amp;&amp; ||</code></td><td>short-circuiting boolean</td></tr>
            <tr><td><code>::</code></td><td>cons (prepend to a list)</td></tr>
            <tr><td><code>++</code></td><td>list append</td></tr>
            <tr><td><code>^</code></td><td>string concatenation</td></tr>
            <tr><td><code>|&gt;</code></td><td>pipe: <code>x |&gt; f</code> means <code>f x</code></td></tr>
            <tr><td><code>;</code></td><td>sequence (evaluate, discard, continue)</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>The prelude</h2>
        <p>These are written in Aether itself, on top of a few primitives:</p>
        <pre className="snippet">{`map filter foldl foldr length append reverse sum range
take drop elem all any concat zip replicate
// primitives:
head tail empty print show
sqrt sin cos floor toFloat pi abs min max
strlen toUpper toLower chars join parseInt`}</pre>
      </section>

      <section>
        <h2>Turtle graphics</h2>
        <p>
          Side-effecting primitives drive a turtle (it starts facing up; <code>turn</code> is
          counter-clockwise, in degrees). Sequence them with <code>;</code> and recurse to draw
          fractals.
        </p>
        <pre className="snippet">{`forward 100.0   turn 90.0
penUp ()        penDown ()
push ()         pop ()        // save / restore state
color 255 120 0  width 2.0
back 50.0        clear ()`}</pre>
      </section>

      <section>
        <h2>Three backends</h2>
        <p>
          The same type-checked program is compiled <strong>three ways</strong>. The{' '}
          <strong>Bytecode</strong> tab shows it lowered to a stack machine run by a hand-written VM
          (with the time-travel debugger). The <strong>JavaScript</strong> tab shows it lowered to
          self-contained JavaScript and runs it right in your browser — a tiny runtime mirrors the
          VM's value model exactly, so the result, printed output and turtle drawing match the VM{' '}
          <em>byte-for-byte</em> (there's a live "matches the VM ✓" check).
        </p>
        <p>
          The <strong>WebAssembly</strong> tab goes one step further: it hand-assembles the program
          into a <em>real <code>.wasm</code> module</em> — a from-scratch binary encoder, no{' '}
          <code>wabt</code> or <code>binaryen</code> — then instantiates and runs it in the engine.
          Closures dispatch through <code>call_indirect</code> over a bump-allocator heap, tail calls
          use the WebAssembly <code>return_call</code> proposal for constant-space recursion, and the
          inherently host-side operations (printing, <code>show</code>, comparison, the turtle) are
          imports that reuse the VM's own code — so it too matches the VM <em>byte-for-byte</em>. The
          allocator keeps a shared <strong>small-integer cache</strong> so arithmetic-heavy code reuses
          cells instead of boxing fresh ones (it even reports the allocations saved), and the module
          carries a <code>name</code> section so the tab can <strong>disassemble its own bytes</strong>{' '}
          back into readable <strong>WAT text</strong> — a from-scratch decoder, the mirror of the
          encoder, that prints <code>call $map</code> rather than a raw index. You can download the{' '}
          <code>.wasm</code> and run it anywhere.
        </p>
        <p>
          That heap no longer leaks: a precise, non-moving <strong>tracing garbage collector</strong>{' '}
          (mark-sweep, hand-written in WebAssembly) reclaims dead cells. Since wasm hides the operand
          stack and locals from the collector, codegen keeps a <strong>shadow stack</strong> of roots
          alongside the real one; the collector marks from it plus the value globals and sweeps the
          heap into a reused free list. Tick <strong>stress GC</strong> to collect before every single
          allocation — the answer stays byte-for-byte identical (proof no root is missed) while a long
          allocator loop holds a <em>bounded</em> peak heap instead of growing forever. The{' '}
          <strong>Garbage collector</strong> example shows it off.
        </p>
        <p>
          The <strong>Derivation</strong> tab reconstructs the Hindley–Milner <em>proof tree</em>:
          every step is one typing rule (Var, Abs, App, Let, If…) whose premises justify its
          conclusion <code>expr : τ</code> — the "why", not just the final scheme.
        </p>
      </section>
    </div>
  )
}
