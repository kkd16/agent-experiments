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
        <h2>The optimizing middle-end</h2>
        <p>
          Before any backend runs, an <strong>optimizing middle-end</strong> rewrites the elaborated{' '}
          <em>core</em> (the program after type-class dictionaries, <code>deriving</code>,{' '}
          <code>do</code>-notation and comprehensions are desugared) into a smaller, faster
          equivalent — and all three backends compile <em>its</em> output, so one optimizer makes the
          VM, the JavaScript and the WebAssembly faster at once. It runs to a fixpoint: constant
          folding and algebra (<code>x + 0</code>, <code>x * 1</code>, <code>x ++ []</code>), branch
          elimination, β-reduction and η-contraction, capture-avoiding inlining, dead-binding
          elimination, <strong>known-constructor <code>match</code> reduction</strong>, record
          field projection and <strong>common-subexpression elimination</strong>. Every rewrite is
          semantics-preserving for a strict, effectful language — it never reorders, duplicates or
          drops anything that could <code>print</code>, loop or fail.
        </p>
        <p>
          The upshot: <em>abstraction melts away</em>. A type-class method call on a concrete value
          inlines the dictionary, projects the method out of its record, β-reduces, and — for a
          literal constructor — picks the <code>match</code> arm and folds the arithmetic. Open the{' '}
          <strong>Optimizer</strong> tab on the <em>optimizing middle-end</em> example:{' '}
          <code>area (Circle 2.0)</code> (a <code>class Area</code> method call) reduces all the way
          to the single literal <code>12.56636</code>, its core shrinking from 41 nodes to 4. The tab
          breaks the rewrites down by rule, shows the before/after core, and measures the VM-step
          reduction — and because the backends compile the optimized core, the same "matches the VM ✓"
          checks re-prove the answer never changed.
        </p>
        <p>
          And where 10.0 removed <em>abstraction</em> overhead, <strong>common-subexpression
          elimination</strong> removes <em>recomputation</em>: when a program evaluates the same thing
          more than once on a guaranteed path, CSE computes it <em>once</em> and shares the result. It
          stays honest with two rules on top of the purity analysis — it only touches effect-free,
          terminating expressions (a <code>print</code> is never merged) and only shares occurrences
          guaranteed to run (so it can never <em>add</em> a step). A from-scratch{' '}
          <strong>interprocedural effect-&amp;-totality analysis</strong> proves which functions are
          effect-free and total, so even a repeated <em>call</em> to a pure helper is shared. The{' '}
          <strong>common-subexpression elimination</strong> example writes one distance four times;
          the Optimizer tab's round-by-round trace shows it collapse to a single computation, lists
          the function it proved pure, and the VM steps falling with it.
        </p>
        <p>
          12.0 turns the same lens on <strong>pattern matching</strong>. The naive compiler tests
          each arm in turn, so arms that share a constructor prefix re-test it; the middle-end now
          compiles each non-trivial <code>match</code> to a <strong>good decision tree</strong>{' '}
          (Maranget, 2008) that tests every scrutinee position <em>once</em> — switching on the
          column tested by the most rows, specializing the matrix per constructor, and threading
          guards through as <code>if g then … else &lt;the rest&gt;</code>. It lowers to ordinary
          core (single-column <code>match</code>es plus join-points for shared arms), so all three
          backends run it unchanged. The <strong>decision-tree matching</strong> example is an
          expression simplifier whose rules share <code>Add</code>/<code>Mul</code> prefixes; the
          Optimizer tab draws the tree it compiles to and "Measure VM steps" shows the work it saves.
        </p>
        <p>
          14.0 lets CSE see <strong>through binders</strong>. The local CSE only shares work among one
          node's binder-free frontier, so the same computation on either side of a <code>let</code>,
          inside a <code>λ</code>, or across a <code>match</code> survives. <strong>Global value
          numbering</strong> is a top-down, dominator-style <strong>available-expressions</strong> pass
          that finds a pure, costly expression <em>guaranteed-evaluated twice</em> across binders and
          hoists it into one shared <code>let</code> at the dominating node — never speculating it onto
          a path that did not need it, so the step count only falls. The{' '}
          <strong>global value numbering</strong> example recomputes one window as the value of three
          different <code>let</code>s; GVN shares it once and roughly halves the kernel's VM steps.
        </p>
        <p>
          15.0 grows up the <strong>inliner</strong>. It used to copy a function only when its binding
          was used <em>once</em>; now a small, non-recursive helper is copied into every{' '}
          <strong>saturated call site</strong> — deleting the call overhead and letting its body fold
          against the literals there — while a partial application or a higher-order <em>escape</em>{' '}
          keeps one shared closure. An inlined call runs fewer instructions and an un-taken copy costs
          nothing, so the step count can only fall. The <strong>call-site inlining</strong> example
          folds <code>sq 3 + sq 4 + sq 12</code> to a single <code>169</code> and sheds a call per
          iteration from a hot loop, cutting its VM steps by ~45%.
        </p>
        <p>
          17.0 makes loops first-order. A recursive function often threads a parameter round its loop
          completely <em>unchanged</em> — the function argument of a recursive <code>map</code>, the
          limit of a counting loop. The <strong>static-argument transformation</strong> (Santos 1995;
          Peyton Jones &amp; Santos 1998) splits it into a thin <strong>wrapper</strong> that binds the
          static arguments once and a recursive <strong>worker</strong> that loops on only the{' '}
          <em>dynamic</em> ones, capturing the static ones as free variables — so each iteration passes
          one fewer argument (34–42% fewer VM steps on the canonical loops). Because the wrapper is no
          longer recursive, a <em>known</em> function flowing into a lifted slot is then inlined and
          β-reduced into the loop: the <strong>static-argument transformation</strong> example shows{' '}
          <code>each (fn x -&gt; x*x) xs</code> collapse to a bare first-order loop with the function
          parameter gone entirely — the effect SpecConstr is famous for, reached by composition.
        </p>
        <p>
          18.0 deletes <em>data</em>, not just code. A list pipeline like{' '}
          <code>sum (map f (filter p xs))</code> naively allocates a throwaway list at every arrow,
          walks it once and discards it. <strong>Short-cut fusion</strong> — deforestation (Wadler
          1990; Gill, Launchbury &amp; Peyton Jones, <em>A short cut to deforestation</em>, 1993) — is
          an algebraic rewrite system over the prelude combinators that turns a consumer applied to a
          producer into a single pass with <em>no intermediate list</em>: <code>map f (map g xs)</code>{' '}
          becomes <code>map (f ∘ g) xs</code>, <code>length (map g xs)</code> drops the map entirely,{' '}
          <code>reverse (reverse xs)</code> vanishes, and a four-stage{' '}
          <code>sum (map (filter (map (range …))))</code> collapses to one <code>foldl</code> over the
          range. Each law fires only on the <em>real</em> prelude combinator (a user binding of the
          same name shadows it) and only when the function whose call-timing it changes is proven{' '}
          <strong>pure &amp; total</strong>, so no effect is reordered and no exception hoisted. The{' '}
          <strong>short-cut fusion</strong> example fuses a five-combinator pipeline into a single
          traversal — the Optimizer tab lists each law that fired and "Measure VM steps" shows the
          intermediate lists, and more than half the work, disappear.
        </p>
      </section>

      <section>
        <h2>Three backends</h2>
        <p>
          The same type-checked, <strong>optimized</strong> program is compiled{' '}
          <strong>three ways</strong>. The{' '}
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
