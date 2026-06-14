const STAGES = [
  {
    n: 1,
    title: 'Lexer',
    body: 'A hand-written scanner turns source text into tokens, each carrying an exact source span. Nested block comments, string escapes, and int/float distinction are all handled here.',
  },
  {
    n: 2,
    title: 'Parser',
    body: 'A Pratt (precedence-climbing) parser builds the AST. Function application is juxtaposition and binds tighter than every operator; let / fn / if are prefix forms. Multi-argument functions desugar to curried lambdas, and list comprehensions [ e | x <- xs, guard ] desugar to concat / map / if — so they are typed and compiled like any other core expression.',
  },
  {
    n: 3,
    title: 'Type inference',
    body: 'Algorithm W (Hindley–Milner). Unification is by mutation of type variables with an occurs-check; let-bindings are generalised over the variables not free in the environment, giving full parametric polymorphism — with no annotations anywhere. User-declared algebraic data types add their own type constructors, each data constructor gets a polymorphic scheme, and records use row unification so field access is row-polymorphic.',
  },
  {
    n: 3.3,
    title: 'Type-class elaboration',
    body: "Type classes are compiled by a type-directed translation into the ordinary core language. Inference resolves every class constraint to evidence — a concrete instance dictionary (applied to whatever its context needs) or a dictionary parameter passed down — and an elaboration pass rewrites the program: an instance becomes a record of methods, a constrained binding gains leading dictionary parameters, a method call becomes a field access, and each use site applies its evidence. Because the output is plain core AST, the compiler and the JavaScript backend run dictionaries with no special support. The Classes tab shows the elaborated core.",
  },
  {
    n: 3.5,
    title: 'Optimizer',
    body: 'An optional semantics-preserving pass folds constant arithmetic / comparison / boolean / string expressions, eliminates dead branches (if true …), and simplifies short-circuit operators — before compilation. Toggle it in the playground and watch the folded count and VM step total drop.',
  },
  {
    n: 4,
    title: 'Compiler',
    body: 'The typed AST is lowered to bytecode for a stack machine. Each function becomes its own proto; free variables are captured as clox-style upvalues (by reference), so closures and recursion compose. let opens a real local slot that is closed and slid off the stack at end of scope, and match is compiled into a decision sequence of constructor tests plus variable extractions.',
  },
  {
    n: 5,
    title: 'Virtual machine',
    body: 'An iterative stack VM with an explicit frame stack, so recursion depth is bounded by memory, not the host call stack. Calls in tail position reuse the current frame (tail-call optimisation), giving constant-space tail recursion — watch the call-frame count stay flat in the debugger. Builtins are curried native values; the VM can record a per-instruction snapshot trace.',
  },
  {
    n: 6,
    title: 'Turtle & debugger',
    body: 'Drawing primitives emit a command stream that a separate interpreter folds into line segments for the canvas. The recorded VM trace powers the time-travel debugger: scrub through every instruction and watch the stack and call frames evolve.',
  },
  {
    n: 7,
    title: 'JavaScript backend',
    body: "A second compilation target beside the VM: the very same typed AST is lowered to readable, self-contained JavaScript and run in your browser. Functions become curried arrow functions, let/type flatten into a const spine, match becomes pattern tests, and a tiny runtime mirrors the VM's value model exactly — tagged ints/floats, the same structural comparison, the same turtle effect log. The result is that the JS backend's value, printed output and drawing match the bytecode VM byte-for-byte (there's a live equivalence check in the JavaScript tab).",
  },
  {
    n: 8,
    title: 'Type-derivation tree',
    body: 'Inference records the type of every sub-expression as it goes; the Derivation tab reconstructs the Hindley–Milner proof tree from those, rendering each step as one typing rule (Var, Abs, App, Let, If, …) whose premises justify its conclusion expr : τ. It turns the final inferred scheme into the full argument for why it holds.',
  },
]

export default function About() {
  return (
    <div className="page about-page">
      <h1>How it works</h1>
      <p className="page-lead">
        Aether is a complete language toolchain that runs entirely in your browser — no server, no
        WebAssembly, no external libraries. Source flows through these stages, and every
        intermediate artifact is something you can inspect in the playground.
      </p>

      <div className="pipeline">
        {STAGES.map((s, i) => (
          <div className="pipeline-stage" key={s.title}>
            <div className="stage-num">{i + 1}</div>
            <div className="stage-body">
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
            {i < STAGES.length - 1 && <div className="stage-arrow">↓</div>}
          </div>
        ))}
      </div>

      <section className="colophon">
        <h2>Notes</h2>
        <ul>
          <li>
            The whole core (lexer, parser, inferencer, compiler, VM) is plain TypeScript with zero
            runtime dependencies beyond React for the UI.
          </li>
          <li>
            Comparison operators are structural and polymorphic; the prelude (map, filter, fold, …)
            is written in Aether and compiled in with every program.
          </li>
          <li>
            <strong>Type classes</strong> add principled overloading on top of Hindley–Milner:{' '}
            <code>class</code> / <code>instance</code> declarations, qualified types like{' '}
            <code>Disp a =&gt; a -&gt; String</code>, instance contexts, and dictionary-passing
            elaboration that both backends share. The Classes tab makes the generated dictionaries
            visible.
          </li>
          <li>
            <code>match</code> is checked for exhaustiveness and redundancy using Maranget's
            usefulness algorithm — non-exhaustive matches are reported with a concrete witness
            pattern, and unreachable clauses are flagged.
          </li>
          <li>
            There are <strong>two backends</strong> for one front end: a bytecode VM and a
            JavaScript code generator. They share the lexer, parser, type inferencer and optimizer,
            and agree on every program — the JavaScript tab proves it live.
          </li>
          <li>
            Routing is hash-based and the build uses a relative base, so everything works as a
            static bundle under a sub-path.
          </li>
        </ul>
      </section>
    </div>
  )
}
