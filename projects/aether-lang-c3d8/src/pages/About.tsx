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
    n: 12,
    title: 'The optimizing middle-end',
    body: "Between elaboration and the backends, a real multi-pass optimizer rewrites the core (the dictionary-passed, class-free program) to a fixpoint, and ALL THREE backends compile its output — so one optimizer speeds up the VM, the JavaScript and the WebAssembly at once. The passes: constant folding and algebraic identities (x+0, x*1, x++[], short-circuits), branch elimination, β-reduction ((fn x -> b) a becomes let x = a in b, with let-floating so curried calls keep reducing) and η-contraction, capture-avoiding inlining and copy-propagation of value bindings, dead-binding elimination, known-constructor match reduction (a match on a statically-known literal, tuple, list or constructor collapses to its arm), record field projection, and common-subexpression elimination. Every rewrite is semantics-preserving for a strict, effectful language: two predicates — isValue (no work, cannot diverge or raise) and isPure (no observable effect, terminates) — keep it from ever reordering, duplicating or dropping a computation that could print, loop or fail. Together they make abstraction melt away: a type-class method call on a concrete value inlines the dictionary, projects the method out of its record, β-reduces, and — for a literal constructor — selects the match arm and folds the arithmetic. The gallery's optimizer example reduces area (Circle 2.0) all the way to the literal 12.56636. COMMON-SUBEXPRESSION ELIMINATION is the dual move — it removes recomputation: when a program evaluates the same expression more than once on a guaranteed path, CSE computes it once into a fresh let and shares the result. It is kept honest by the same purity machinery plus two rules — it only ever touches effect-free, terminating expressions (so a print is never merged) and only shares occurrences guaranteed to run (so it can never add a step). To reach the most valuable targets it is powered by a from-scratch INTERPROCEDURAL EFFECT-&-TOTALITY ANALYSIS: a fixpoint that proves which never-shadowed, non-recursive functions are effect-free and total, so even a repeated call to a pure helper can be shared. The Optimizer tab shows the rewrites by rule, a round-by-round fixpoint trace, the functions proven pure, the node-count reduction, the before/after core and a one-click VM-step measurement — and because the backends compile the optimized core, the same equivalence checks re-prove the answer never changed.",
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
  {
    n: 12,
    title: 'Pattern matching compiled to good decision trees',
    body: "The naive way to compile a match tests each arm in turn, re-navigating the scrutinee from scratch — so two arms that share a constructor prefix (Cons a (Cons b r) then Cons a Nil) re-test that outer Cons twice. The optimizing middle-end instead compiles each non-trivial match to a GOOD DECISION TREE (Maranget, 2008): a pattern matrix whose columns track the sub-values matched so far. It repeatedly picks a column whose first-row pattern is refutable (the one tested by the most rows, to maximise sharing) and switches once on that occurrence — one arm per head constructor present, the matrix specialized for each (constructor rows expand their sub-patterns into new columns; wildcard rows propagate into every arm), with a default arm only when the column's signature is incomplete. So each scrutinee position is tested exactly once. Guards keep the naive 'first matching, guard-passing arm wins' semantics: a guarded leaf becomes if g then body else <compile the rest>, and a non-exhaustive switch is emitted without a default arm so it MATCH_FAILs at runtime exactly where the source would. The whole thing is a CORE-TO-CORE transformation — it lowers a complex match into a tree of single-column matches plus let-bound join-points for arm bodies reached from more than one leaf (so the tree never blows up code size) — so the VM, the JavaScript backend and the WebAssembly backend all compile it unchanged, and the equivalence checks re-prove the answer never changed while the Optimizer tab's per-example step measurement shows the saved work. The Optimizer tab draws each compiled match's decision tree and reports the pattern tests it shared away.",
  },
  {
    n: 13,
    title: 'Size-change termination — proving recursion halts',
    body: "The optimizer's effect-&-totality analysis used to call a function total only if it was NON-RECURSIVE — a safe but blunt rule that excluded every interesting function. It now PROVES termination with the size-change principle (Lee-Jones-Ben-Amram, POPL 2001). The well-founded order is the structural subterm order on finite data: a value peeled out of a constructor, cons-cell or tuple by a match is strictly smaller than the whole (Aether is strict, so all data is finite and that order is well-founded). For every call f -> g the analysis builds a SIZE-CHANGE GRAPH — arcs from f's parameters to g's arguments labelled ↓ (a strict subterm) or ↓= (an alias), read straight off the match/let destructurings in scope. It finds the program's strongly-connected components, closes each component's graphs under composition, and declares it terminating when every IDEMPOTENT self-graph carries a strict in-situ arc p ↓ p — a parameter that descends on every way around the loop. So 'length', 'append', 'reverse', tree folds, mutually-recursive even/odd and a Peano-Nat factorial are all proven, while the same countdown on a raw Int — which can diverge on a negative input — is honestly left unproven. The cut-off is FIRST-ORDER, which is exactly what also keeps it sound for the optimizer: a function that applies one of its own parameters (map, foldr) is never admitted, because both its termination and its effect-freedom depend on the function it is handed at runtime. Once a recursive function is proven effect-free AND terminating it joins the pure set, so common-subexpression elimination may share a repeated call and dead-code elimination may drop an unused one — and all three backends still agree byte-for-byte. The Termination tab shows each function's verdict, its ↓ descending thread, and the first-order call graph.",
  },
  {
    n: 14,
    title: 'Global value numbering — CSE across binders',
    body: "Aether's common-subexpression elimination is LOCAL: it only shares an expression among the children on a single node's binder-free strict frontier, so it cannot touch the same work recomputed on either side of a let, inside a λ body, or across a match. Global value numbering closes that gap with a top-down, dominator-style AVAILABLE-EXPRESSIONS pass. At each node it scans the subtree for a pure, costly expression whose free variables are all bound above the node (so the node may legally bind it) and that is GUARANTEED-EVALUATED at least twice across binders, then hoists it into one shared let gvn = e at that dominating node and rewrites every occurrence — including the conditional ones (a match/if arm, a λ body), which is pure bonus — to read the shared variable. Each occurrence is gathered by identity with the names bound on the way down to it, so an occurrence sitting under a binder that re-binds one of e's variables is correctly excluded (it would denote a different value). The hoist is sound on three counts: only effect-free, TERMINATING expressions are ever moved, and moving a pure computation earlier on a guaranteed path is observationally invisible in a strict language; the bound name is $-fresh and every free variable is in scope at the hoist point, so nothing is captured or shadowed; and the two guaranteed evaluations mean the value would have been computed at least twice anyway, so the VM step count can only fall — it never speculates a computation onto a path that did not need it (work split across two if-arms, or one guaranteed evaluation plus a conditional one, is deliberately left alone). Because it emits an ordinary let, the VM, the JavaScript backend and the WebAssembly backend all compile it unchanged and the equivalence checks re-prove the answer never changed. The gallery's 'Global value numbering' example recomputes a pure window as the value of three different lets — work the frontier CSE never sees — and GVN shares it once, roughly halving the kernel's VM steps; the Optimizer tab lists the gvn rule and the expression it shared across how many sites.",
  },
  {
    n: 15,
    title: 'Call-site inlining — the inliner grows up',
    body: "For its first fourteen versions Aether's inliner copied a function's body only when its binding was used EXACTLY ONCE — the blunt rule that guarantees code can never blow up, but that leaves the most common shape in real code untouched: a small helper (sq, lerp, a projection) called from several places, or from inside a loop, keeps paying the closure-application and frame overhead at every call and never gets to fold against the literals at the site. Call-site inlining lifts that cap for small, NON-RECURSIVE functions. When such a function is used more than once and its body fits a node budget (and is not match-bodied — the decision-tree pass owns those, sharing their arms via join-points), it is copied into every SATURATED call site (an application spine f e1 … ek of at least the function's arity), while every partial application or higher-order ESCAPE — where the function is handed to map or fold as a value — keeps referring to a single retained closure. The rewrite reuses the optimizer's already-proven machinery rather than re-deriving capture avoidance: it marks each saturated call-spine head with a globally fresh placeholder (stopping at any inner binder that re-binds the name), renames the surviving escape occurrences to a fresh binder, then substitutes the lambda for the placeholders — and because that substitution freshens any binder on the path that would capture one of the lambda's free variables, the inlined copies denote exactly what the call denoted (a helper closing over n, inlined at a site where n has been re-bound, still reads the definition-site n). If an escape survives the function keeps one closure; if not, it is fully inlined and no closure is ever built. The load-bearing property is MONOTONICITY: an inlined call (let x = a in body) runs strictly fewer VM instructions than the real call it replaces, the body runs the same number of times either way (only source text is duplicated, never runtime work), and a copy that lands on a branch never taken costs nothing — so the harness's 'optimizer never increases VM steps' gate holds by construction, with no speculation gate needed. Because it emits ordinary core, all three backends run the inlined program and the equivalence checks re-prove the answer; the gallery's 'Call-site inlining' example folds sq 3 + sq 4 + sq 12 to the literal 169 (sq gone entirely) and sheds a call per iteration from a hot loop, cutting its VM steps by about 45%. The Optimizer tab names each inlined function, its call-site count, and whether an escape closure was kept.",
  },
  {
    n: 16,
    title: 'Equality saturation — an e-graph superoptimizer',
    body: "Every pass so far is GREEDY: it commits to one rewrite per node, so it can pick a first move it can never undo — it can never factor a*2 + a*3 into a*5, because that needs to see the whole expression at once. Equality saturation removes the choice. Instead of rewriting destructively it grows an E-GRAPH — a set of equivalence classes (e-classes) of e-nodes — and applies every algebraic law NON-DESTRUCTIVELY, recording both the old and the new form in the same class: commutativity (free, folded into the hash-cons key by sorting operands), associativity, the factoring law (u*x + u*y = u*(x+y)), the identities (x+0, x*1, x*0), x+x = 2*x, double negation, and cancellation (x - x = 0). Rules keep firing until the graph stops growing — it SATURATES — at which point a single e-class compactly represents an astronomically large set of equivalent programs, and a bottom-up EXTRACTION with a cost model (a multiply dearer than an add, each leaf occurrence counted so duplication can never pay) pulls out the single cheapest program in the whole class at once. The pass runs on the program's INTEGER-ARITHMETIC ISLANDS — maximal trees of + - * and unary negation, which the type system guarantees are pure polynomials over their leaves — and a leaf is only admitted as a polynomial variable when the optimizer's purity oracle proves it effect-free and total, so an island holding a possibly-diverging or printing subterm is left untouched. Soundness is not taken on faith: because each island is a multivariate polynomial in ℤ[leaves], every candidate is DIFFERENTIALLY VALIDATED by polynomial identity testing (Schwartz–Zippel) — original and extracted are evaluated on dozens of random integer assignments and a single disagreement vetoes the rewrite — certifying a genuine integer identity. Aether's Int is a 64-bit double, exact within ±2^53, so within that range (every realistic program) the rewrite is bit-for-bit unchanged on the VM; beyond it, reassociating a product may re-round, exactly the overflow-free assumption GCC and LLVM make when they reassociate signed-integer arithmetic. The cost gate only ever adopts a STRICTLY cheaper form, so — like every other pass — the VM step count can only fall, and because it emits ordinary core all three backends compile the superoptimized program and the equivalence checks re-prove the answer. The gallery's 'Equality saturation' example rewrites a*2 + a*3 to a*5 and a*b - b*a to 0; the Eq-Sat tab names each improved island, its cost before/after, the validation verdict, and draws the saturated e-graph itself.",
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
