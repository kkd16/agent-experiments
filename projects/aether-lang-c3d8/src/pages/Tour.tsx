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
        <h2>Two backends</h2>
        <p>
          The same type-checked program is compiled <strong>two ways</strong>. The{' '}
          <strong>Bytecode</strong> tab shows it lowered to a stack machine run by a hand-written VM
          (with the time-travel debugger). The <strong>JavaScript</strong> tab shows it lowered to
          self-contained JavaScript and runs it right in your browser — a tiny runtime mirrors the
          VM's value model exactly, so the result, printed output and turtle drawing match the VM{' '}
          <em>byte-for-byte</em> (there's a live "matches the VM ✓" check).
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
