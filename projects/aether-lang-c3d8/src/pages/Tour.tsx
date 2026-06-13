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
      </section>

      <section>
        <h2>Operators</h2>
        <table className="op-table">
          <tbody>
            <tr><td><code>+ - * /</code></td><td>integer arithmetic</td></tr>
            <tr><td><code>+. -. *. /.</code></td><td>floating-point arithmetic</td></tr>
            <tr><td><code>== != &lt; &gt; &lt;= &gt;=</code></td><td>structural comparison (polymorphic)</td></tr>
            <tr><td><code>&amp;&amp; ||</code></td><td>short-circuiting boolean</td></tr>
            <tr><td><code>::</code></td><td>cons (prepend to a list)</td></tr>
            <tr><td><code>++</code></td><td>list append</td></tr>
            <tr><td><code>^</code></td><td>string concatenation</td></tr>
            <tr><td><code>;</code></td><td>sequence (evaluate, discard, continue)</td></tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>The prelude</h2>
        <p>These are written in Aether itself, on top of a few primitives:</p>
        <pre className="snippet">{`map filter foldl foldr
length append reverse sum range
// primitives:
head tail empty print show
sqrt sin cos floor toFloat pi`}</pre>
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
    </div>
  )
}
