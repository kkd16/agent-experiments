// A gallery of curated ASP programs — each one dramatises a different facet of
// the paradigm: pure Datalog recursion, nonmonotonic defaults, the
// generate-and-test idiom (choice rules + integrity constraints), and classic
// NP-complete combinatorics whose answer-set counts are known mathematically.

export interface AspExample {
  id: string
  name: string
  blurb: string
  code: string
  /** Exact number of answer sets, when known a priori (for the self-test). */
  expected?: number
}

export const ASP_EXAMPLES: AspExample[] = [
  {
    id: 'choice-basics',
    name: 'Choice & constraint',
    blurb:
      'The generate-and-test heart of ASP in four lines: two independent choices, one constraint forbidding both. Answer sets: {}, {a}, {b}.',
    expected: 3,
    code: `% Each of a, b may independently be in or out...
{ a }.
{ b }.
% ...but never both.
:- a, b.
`,
  },
  {
    id: 'reach',
    name: 'Reachability (Datalog)',
    blurb:
      'A stratified, negation-free program has exactly one answer set — its least model. Transitive closure of a directed graph, computed by recursion.',
    expected: 1,
    code: `edge(a,b).  edge(b,c).  edge(c,d).  edge(d,b).
reach(X,Y) :- edge(X,Y).
reach(X,Y) :- edge(X,Z), reach(Z,Y).
`,
  },
  {
    id: 'tweety',
    name: 'Tweety flies (defaults)',
    blurb:
      "Nonmonotonic default reasoning: birds fly unless known abnormal. Penguins are abnormal. The single answer set has Polly flying and Tweety grounded — and adding a fact can retract a conclusion.",
    expected: 1,
    code: `bird(tweety).  bird(polly).
penguin(tweety).
ab(X)    :- penguin(X).
flies(X) :- bird(X), not ab(X).
`,
  },
  {
    id: 'graph-color',
    name: '3-colouring',
    blurb:
      'Generate one colour per node with an exactly-one choice, then reject any edge whose endpoints clash. Every answer set is a proper colouring.',
    code: `node(1..5).
edge(1,2).  edge(2,3).  edge(3,4).  edge(4,5).  edge(5,1).  edge(1,3).
color(r).  color(g).  color(b).

% exactly one colour per node
1 { assign(X,C) : color(C) } 1 :- node(X).

% adjacent nodes must differ
:- edge(X,Y), assign(X,C), assign(Y,C).
`,
  },
  {
    id: 'queens',
    name: 'N-Queens (n = 6)',
    blurb:
      'One queen per row (an exactly-one choice over columns), forbidding shared columns and both diagonals. The 6×6 board has exactly 4 solutions.',
    expected: 4,
    code: `row(1..6).

% one queen per row
1 { q(R,C) : row(C) } 1 :- row(R).

% no two queens share a column...
:- q(R1,C), q(R2,C), R1 < R2.
% ...or a diagonal (both directions)
:- q(R1,C1), q(R2,C2), R1 < R2, R1 - C1 = R2 - C2.
:- q(R1,C1), q(R2,C2), R1 < R2, R1 + C1 = R2 + C2.
`,
  },
  {
    id: 'hamilton',
    name: 'Hamiltonian cycle',
    blurb:
      'Pick exactly one outgoing and one incoming edge per node, then insist every node is reachable from the start — the textbook ASP encoding of an NP-complete tour.',
    expected: 1,
    code: `node(1..4).
edge(1,2). edge(2,3). edge(3,4). edge(4,1).
edge(2,4). edge(4,2). edge(1,3). edge(3,1).

% exactly one successor and one predecessor per node
1 { hc(X,Y) : edge(X,Y) } 1 :- node(X).
1 { hc(X,Y) : edge(X,Y) } 1 :- node(Y).

% the tour must be connected: everything reachable from node 1
reached(1).
reached(Y) :- reached(X), hc(X,Y).
:- node(Y), not reached(Y).
`,
  },
  {
    id: 'indset',
    name: 'Independent sets',
    blurb:
      'A free subset choice plus a single constraint enumerates every independent set of a graph — the whole solution space, not just one witness.',
    code: `node(1..6).
edge(1,2). edge(2,3). edge(3,4). edge(4,5). edge(5,6). edge(6,1). edge(1,4).

{ in(X) : node(X) }.
:- edge(X,Y), in(X), in(Y).
`,
  },
  {
    id: 'evenloop',
    name: 'Even loop (two stable models)',
    blurb:
      'A negative loop `p :- not q. q :- not p.` is the canonical source of multiple answer sets — completion alone admits an unsupported model that the unfounded check must kill.',
    expected: 2,
    code: `p :- not q.
q :- not p.
`,
  },
  {
    id: 'diamond',
    name: 'Positive loop (loop formula)',
    blurb:
      "A positive loop a↔b that can only be founded from outside. Clark's completion admits the model {a,b} with c false, but nothing founds the cycle — so a loop formula prunes it. The two answer sets are {} and {a,b,c}; watch the loop-formula counter tick.",
    expected: 2,
    code: `% c is a free choice; a and b prop around a positive loop,
% but the loop can only be *founded* through c.
{ c }.
a :- c.
a :- b.
b :- a.
`,
  },
]
