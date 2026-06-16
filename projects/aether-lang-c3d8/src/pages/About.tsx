const STAGES = [
  {
    n: 1,
    title: 'Lexer',
    body: 'A hand-written scanner turns source text into tokens, each carrying an exact source span. Nested block comments, string escapes, and int/float distinction are all handled here.',
  },
  {
    n: 2,
    title: 'Parser',
    body: 'A Pratt (precedence-climbing) parser builds the AST. Function application is juxtaposition and binds tighter than every operator; let / fn / if are prefix forms. Multi-argument functions desugar to curried lambdas, list comprehensions [ e | x <- xs, guard ] desugar to concat / map / if, and monadic do { x <- e; … } desugars to bind e (fn x -> …) — so each is typed and compiled like any other core expression.',
  },
  {
    n: 3,
    title: 'Type inference',
    body: 'Algorithm W (Hindley–Milner). Unification is by mutation of type variables with an occurs-check; let-bindings are generalised over the variables not free in the environment, giving full parametric polymorphism — with no annotations anywhere. User-declared algebraic data types add their own type constructors, each data constructor gets a polymorphic scheme, and records use row unification so field access is row-polymorphic.',
  },
  {
    n: 3.3,
    title: 'Type-class elaboration',
    body: "Type classes are compiled by a type-directed translation into the ordinary core language. Inference resolves every class constraint to evidence — a concrete instance dictionary (applied to whatever its context needs), a dictionary parameter passed down, or a superclass dictionary projected out of another (Functor from Monad) — and an elaboration pass rewrites the program: an instance becomes a record of methods (plus $super_ fields for its superclasses), a constrained binding gains leading dictionary parameters, a method call becomes a field access, and each use site applies its evidence. Because the output is plain core AST, the compiler and the JavaScript backend run dictionaries with no special support. The Classes tab shows the elaborated core.",
  },
  {
    n: 3.4,
    title: 'Kinds & higher-kinded types',
    body: "A kind classifies a type the way a type classifies a value: Int : *, List : * -> *, Either : * -> * -> *. Kinds make higher-kinded classes principled — Monad m abstracts over an m of kind * -> *, so one generic combinator runs in every monad (Option, List, the partially-applied State s). Kinds are inferred by unification, exactly like types: each class parameter's kind is read off how its methods use it, every class/instance/type declaration is kind-checked, and instance Monad Int is rejected because Int : * ≠ * -> *. A type variable may now stand for a constructor — a TApp node represents m a and unification decomposes ordinary constructors into application spines to bridge the two.",
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
    title: 'WebAssembly backend',
    body: "A third compilation target: the same typed AST is hand-assembled into a real .wasm module by a from-scratch binary encoder (no wabt, no binaryen), then instantiated and run by the engine. Every value is a tagged cell in linear memory over a bump allocator; each lambda becomes a WASM function and closures dispatch through call_indirect; tail calls use the WebAssembly tail-call proposal (return_call) for the VM's constant-space recursion. Arithmetic, comparison of numbers, list/tuple/record/ADT building and match all run as native WebAssembly, while printing, show, structural comparison, string ops and the turtle are imports that decode heap pointers and reuse the VM's own code — so the result, output and drawing match the bytecode VM byte-for-byte. The allocator keeps a shared small-integer cache (one pre-built cell per value in a small range), so arithmetic-heavy code reuses cells instead of boxing fresh ones — invisible to results because every value is compared structurally — and the module counts what it does (allocations, bytes, cache hits). The module also carries a name section, and the WebAssembly tab disassembles its own bytes back into readable WAT text by a from-scratch decoder (the mirror of the encoder) that resolves every call/global/local to a $name, alongside the sections, live allocation stats, and a download for the .wasm to run anywhere.",
  },
  {
    n: 9,
    title: 'Type-derivation tree',
    body: 'Inference records the type of every sub-expression as it goes; the Derivation tab reconstructs the Hindley–Milner proof tree from those, rendering each step as one typing rule (Var, Abs, App, Let, If, …) whose premises justify its conclusion expr : τ. It turns the final inferred scheme into the full argument for why it holds.',
  },
  {
    n: 10,
    title: 'Property-based testing (Aether Check)',
    body: "The Check tab turns inferred types into machine-checked evidence about behaviour. Write a prop_… function returning Bool; Check reads its type, builds a random generator straight from that type — numbers, strings, lists, tuples, records, your own ADTs (recursively, with a size budget so types like Tree always terminate) and even functions (rendered as a finite table fn x -> if x == k then v … else default) — and runs hundreds of cases through the real VM. Leftover polymorphism defaults to Int and the RNG is seeded, so a report is reproducible. On a failure it performs integrated shrinking (ints toward zero, lists dropped and halved, ADTs replaced by sub-terms, functions reduced to fewer entries) down to a minimal counterexample, and a runtime crash is reported with the exact input that caused it.",
  },
  {
    n: 11,
    title: 'A tracing garbage collector for WebAssembly',
    body: "The WebAssembly heap used to be a bump allocator that never freed. It is now collected by a precise, non-moving mark-sweep garbage collector, hand-assembled in WebAssembly with no host help. The hard part of a tracing GC under WebAssembly is finding the roots: the live pointers sit in the operand stack and in locals, which running wasm cannot inspect. So codegen maintains a shadow stack — a second stack in linear memory holding exactly the pointers that must survive an allocation: each function roots its arguments and let/match bindings and pops its whole frame at every exit, and every compound value is built by rooting its parts first. The collector marks from the shadow stack and the module's value globals (cons spines iterate, so even huge lists mark in constant stack), then sweeps the heap into a coalesced free list that the allocator reuses. Because nothing moves, the pointers already in wasm locals stay valid across a collection. A GC stress mode collects before every single allocation, and the result is byte-for-byte identical to a normal run — a live proof that the root set is complete — while a long allocator loop keeps a bounded peak heap even as it churns megabytes of garbage. The WebAssembly tab reports collections, bytes reclaimed, cells reused and the peak heap, and offers the stress toggle.",
  },
]

export default function About() {
  return (
    <div className="page about-page">
      <h1>How it works</h1>
      <p className="page-lead">
        Aether is a complete language toolchain that runs entirely in your browser — no server, no
        external libraries, and it even assembles its own WebAssembly. Source flows through these
        stages, and every intermediate artifact is something you can inspect in the playground.
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
            <strong>Higher-kinded types &amp; a kind system.</strong> Classes range over type
            constructors, so <code>class Monad m where bind : m a -&gt; (a -&gt; m b) -&gt; m b</code>{' '}
            is real — one <code>mapM</code> works in <code>Option</code>, <code>List</code> and the
            partially-applied <code>State s</code>. Kinds are <em>inferred</em> (<code>Monad</code>'s
            parameter is <code>* -&gt; *</code>) and <strong>superclasses</strong> (
            <code>Functor f =&gt; Monad f</code>) let a <code>Monad</code> constraint entail a{' '}
            <code>Functor</code> one via superclass dictionaries.
          </li>
          <li>
            <strong>
              <code>deriving</code>
            </strong>{' '}
            synthesises instances from a data type's shape —{' '}
            <code>deriving (Eq, Ord, Show, Enum, Bounded, Functor, Foldable)</code>, including
            position-aware <code>deriving Functor</code> and <code>deriving Foldable</code> that write{' '}
            <code>fmap</code>/<code>foldr</code> by walking the last type parameter (recursing through
            itself, lists and tuples). It is pure parse-time desugaring
            into ordinary <code>instance</code> declarations, so inference infers each instance's
            context and both backends run derived instances with no added code.
          </li>
          <li>
            <code>match</code> is checked for exhaustiveness and redundancy using Maranget's
            usefulness algorithm — non-exhaustive matches are reported with a concrete witness
            pattern, and unreachable clauses are flagged.
          </li>
          <li>
            <strong>Aether Check</strong> is from-scratch property-based testing (QuickCheck)
            driven by the type checker: it generates random inputs from each <code>prop_…</code>{' '}
            function's inferred type and <strong>shrinks</strong> any failure to a minimal
            counterexample. <strong>do-notation</strong> (<code>do {'{'} x &lt;- e; … {'}'}</code>)
            desugars to <code>bind</code>; bound to the real <code>Monad</code> class method, the same
            block is the Option, List or State monad depending on its <em>type</em>.
          </li>
          <li>
            There are <strong>three backends</strong> for one front end: a bytecode VM, a
            JavaScript code generator, and a native <strong>WebAssembly</strong> backend that
            assembles a real <code>.wasm</code> module. They share the lexer, parser, type
            inferencer and optimizer, and agree on every program — the JavaScript and WebAssembly
            tabs prove it live.
          </li>
          <li>
            The <strong>Tests</strong> page runs a self-test suite live in your browser — every case
            goes through the whole pipeline and, when it yields a value, is run on both the VM and
            the JavaScript backend, so a green row is a proof the two backends agree.
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
