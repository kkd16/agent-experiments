const STAGES = [
  {
    n: 1,
    title: 'Lexer',
    body: 'A hand-written scanner turns source text into tokens, each carrying an exact source span. Nested block comments, string escapes, and int/float distinction are all handled here.',
  },
  {
    n: 2,
    title: 'Parser',
    body: 'A Pratt (precedence-climbing) parser builds the AST. Function application is juxtaposition and binds tighter than every operator; let / fn / if are prefix forms. Multi-argument functions desugar to curried lambdas.',
  },
  {
    n: 3,
    title: 'Type inference',
    body: 'Algorithm W (Hindley–Milner). Unification is by mutation of type variables with an occurs-check; let-bindings are generalised over the variables not free in the environment, giving full parametric polymorphism — with no annotations anywhere. User-declared algebraic data types add their own type constructors, and each data constructor gets a polymorphic scheme.',
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
]

export default function About() {
  return (
    <div className="page about-page">
      <h1>How it works</h1>
      <p className="page-lead">
        Aether is a complete language toolchain that runs entirely in your browser — no server, no
        WebAssembly, no external libraries. Source flows through six stages, and every intermediate
        artifact is something you can inspect in the playground.
      </p>

      <div className="pipeline">
        {STAGES.map((s, i) => (
          <div className="pipeline-stage" key={s.n}>
            <div className="stage-num">{s.n}</div>
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
            Routing is hash-based and the build uses a relative base, so everything works as a
            static bundle under a sub-path.
          </li>
        </ul>
      </section>
    </div>
  )
}
