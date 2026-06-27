// PUCT Monte-Carlo Tree Search — the "planning" half of AlphaZero.
//
// The network gives a fast, shallow opinion about a position (a move policy and a value). MCTS
// turns that opinion into a much stronger one by *looking ahead*: it grows a search tree, spending
// its simulations where the network's policy says to look but correcting course wherever the values
// it backs up disagree. The output is a visit-count distribution over moves — a policy improved by
// search — which is exactly what we train the network's policy head to imitate, closing the loop.
//
// Each simulation walks from the root to a leaf by the PUCT rule
//
//     a* = argmax_a  Q(s,a) + c_puct · P(s,a) · √(ΣN) / (1 + N(s,a))
//
// (exploit high-value edges via Q, explore high-prior / rarely-visited edges via the second term),
// expands the leaf with one network evaluation, and backs the leaf value up the path — flipping
// sign every ply, because a position that is good for me is bad for my opponent.

import type { Game, GameState, Player } from './games';

// A position evaluator: a (masked) move-prior distribution and a scalar value in [−1, 1], both from
// the side-to-move's perspective. The network is one such evaluator; a perfect solver is another
// (used by the self-tests to prove the search is sound).
export type Evaluator = (s: GameState) => { policy: Float64Array; value: number };

export interface MctsConfig {
  simulations: number;
  cPuct: number;
  dirichletAlpha: number; // root-noise concentration (lower ⇒ spikier noise)
  dirichletFrac: number; // 0 = no noise (evaluation), ~0.25 for self-play exploration
}

export interface SearchResult {
  /** Raw visit counts at the root, per action (0 for illegal). */
  counts: Float64Array;
  /** Mean action values Q at the root, per action. */
  q: Float64Array;
  /** The (noised) priors the search used at the root. */
  priors: Float64Array;
  /** The network/solver value of the root position. */
  rootValue: number;
  /** Total simulations actually run. */
  sims: number;
  /** An optional snapshot of the tree the search grew (for the "watch it think" view). */
  tree?: TreeNode;
}

/** A serializable snapshot of one search-tree node, decoupled from the live mutable `Node`. */
export interface TreeNode {
  move: number; // the action that reached this node (−1 at the root)
  n: number; // visits along the edge into this node
  q: number; // mean value of this node from the *root mover's* perspective
  p: number; // prior of the edge into this node
  depth: number;
  children: TreeNode[];
}

export interface TreeOptions {
  topK: number; // keep the most-visited K children per node
  maxDepth: number; // stop expanding past this depth
}

class Node {
  readonly toMove: Player;
  readonly legal: number[];
  readonly P: Float64Array;
  readonly N: Float64Array;
  readonly W: Float64Array;
  readonly children: (Node | null)[];
  expanded = false;
  visits = 0; // parent-visit count used in the PUCT exploration term
  terminal = false;
  terminalValue = 0; // value to `toMove` if terminal

  constructor(numActions: number, state: GameState) {
    this.toMove = state.player;
    this.legal = [];
    this.P = new Float64Array(numActions);
    this.N = new Float64Array(numActions);
    this.W = new Float64Array(numActions);
    this.children = new Array(numActions).fill(null);
  }
}

// --- Dirichlet noise (root exploration) ----------------------------------------------------------

// Marsaglia–Tsang Gamma(shape, 1) sampler, used to draw symmetric Dirichlet noise.
function sampleGamma(shape: number, rng: () => number): number {
  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a+1) · U^{1/a}.
    const u = Math.max(rng(), 1e-12);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x!: number;
    let v!: number;
    do {
      // Standard normal via Box–Muller.
      const u1 = Math.max(rng(), 1e-12);
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function dirichlet(n: number, alpha: number, rng: () => number): Float64Array {
  const g = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    g[i] = sampleGamma(alpha, rng);
    sum += g[i];
  }
  if (sum > 0) for (let i = 0; i < n; i++) g[i] /= sum;
  return g;
}

// --- The search ----------------------------------------------------------------------------------

function expand(node: Node, game: Game, state: GameState, evaluate: Evaluator): number {
  const status = game.status(state);
  if (status.done) {
    node.terminal = true;
    // The side to move at a finished position has no move; if the game is decided it must have been
    // lost (the opponent just completed it), otherwise drawn.
    node.terminalValue = status.winner === 0 ? 0 : -1;
    node.expanded = true;
    node.visits = 1;
    return node.terminalValue;
  }
  const { policy, value } = evaluate(state);
  const legal = game.legalMoves(state);
  let sum = 0;
  for (const a of legal) sum += policy[a];
  for (const a of legal) {
    node.legal.push(a);
    node.P[a] = sum > 0 ? policy[a] / sum : 1 / legal.length;
  }
  node.expanded = true;
  node.visits = 1;
  return value;
}

function selectAction(node: Node, cPuct: number): number {
  const sqrtN = Math.sqrt(node.visits);
  let best = -Infinity;
  let bestA = node.legal[0];
  for (const a of node.legal) {
    const q = node.N[a] > 0 ? node.W[a] / node.N[a] : 0;
    const u = cPuct * node.P[a] * (sqrtN / (1 + node.N[a]));
    const score = q + u;
    if (score > best) {
      best = score;
      bestA = a;
    }
  }
  return bestA;
}

export function runSearch(
  game: Game,
  root: GameState,
  evaluate: Evaluator,
  cfg: MctsConfig,
  rng: () => number,
  treeOpts?: TreeOptions,
): SearchResult {
  const A = game.numActions;
  const rootNode = new Node(A, root);
  const rootValue = expand(rootNode, game, root, evaluate);

  // Dirichlet exploration noise mixed into the root priors (self-play only).
  if (cfg.dirichletFrac > 0 && rootNode.legal.length > 0) {
    const noise = dirichlet(rootNode.legal.length, cfg.dirichletAlpha, rng);
    for (let i = 0; i < rootNode.legal.length; i++) {
      const a = rootNode.legal[i];
      rootNode.P[a] = (1 - cfg.dirichletFrac) * rootNode.P[a] + cfg.dirichletFrac * noise[i];
    }
  }

  for (let sim = 0; sim < cfg.simulations; sim++) {
    const path: { node: Node; action: number }[] = [];
    let node = rootNode;
    let state = root;
    // Selection: descend until we hit a node we must expand (or a terminal).
    for (;;) {
      if (node.terminal) break;
      const a = selectAction(node, cfg.cPuct);
      path.push({ node, action: a });
      state = game.apply(state, a);
      let child = node.children[a];
      if (child === null) {
        child = new Node(A, state);
        node.children[a] = child;
        node = child;
        break; // newly created leaf — evaluate it below
      }
      node = child;
      if (!node.expanded) break;
    }

    // Evaluate the leaf (value from the leaf player's perspective).
    const leafValue = node.expanded ? node.terminalValue : expand(node, game, state, evaluate);
    const leafPlayer = node.toMove;

    // Backup: add the leaf value to every edge on the path, signed by whether that node shares the
    // leaf player's perspective. Increment parent visit counts so the PUCT term grows.
    for (const step of path) {
      const sign = step.node.toMove === leafPlayer ? 1 : -1;
      step.node.N[step.action] += 1;
      step.node.W[step.action] += sign * leafValue;
      step.node.visits += 1;
    }
  }

  const counts = new Float64Array(A);
  const q = new Float64Array(A);
  const priors = new Float64Array(A);
  for (const a of rootNode.legal) {
    counts[a] = rootNode.N[a];
    q[a] = rootNode.N[a] > 0 ? rootNode.W[a] / rootNode.N[a] : 0;
    priors[a] = rootNode.P[a];
  }
  const tree = treeOpts ? buildTree(rootNode, -1, rootNode.visits, 1, 0, rootValue, treeOpts) : undefined;
  return { counts, q, priors, rootValue, sims: cfg.simulations, tree };
}

// Snapshot the most-visited slice of the live search tree into a plain, serializable structure.
// Each node's `q` is expressed from the *root mover's* perspective (so "green = good for the player
// to move at the root" holds at every depth, flipping the raw per-node value by parity).
function buildTree(
  node: Node,
  move: number,
  n: number,
  p: number,
  depth: number,
  qRoot: number,
  opts: TreeOptions,
): TreeNode {
  const children: TreeNode[] = [];
  if (depth < opts.maxDepth) {
    const edges = node.legal
      .filter((a) => node.N[a] > 0)
      .sort((a, b) => node.N[b] - node.N[a])
      .slice(0, opts.topK);
    const sign = (depth + 1) % 2 === 1 ? 1 : -1; // child perspective relative to the root mover
    for (const a of edges) {
      const childQRoot = (node.W[a] / node.N[a]) * sign;
      const child = node.children[a];
      children.push(
        child
          ? buildTree(child, a, node.N[a], node.P[a], depth + 1, childQRoot, opts)
          : { move: a, n: node.N[a], q: childQRoot, p: node.P[a], depth: depth + 1, children: [] },
      );
    }
  }
  return { move, n, q: qRoot, p, depth, children };
}

// Turn visit counts into a move-selection distribution at a temperature τ:
//   π(a) ∝ N(a)^{1/τ}.  τ→0 collapses to a one-hot on the most-visited move (greedy play); larger
// τ keeps the distribution soft (used for exploration on the opening moves of self-play).
export function visitPolicy(counts: Float64Array, temperature: number): Float64Array {
  const A = counts.length;
  const pi = new Float64Array(A);
  if (temperature <= 1e-3) {
    // Greedy: all mass on the argmax (ties split evenly).
    let max = -Infinity;
    for (let a = 0; a < A; a++) if (counts[a] > max) max = counts[a];
    let ties = 0;
    for (let a = 0; a < A; a++) if (counts[a] === max && max > 0) ties++;
    if (ties === 0) {
      // No visits at all (shouldn't happen) — uniform over nonzero, else uniform.
      for (let a = 0; a < A; a++) pi[a] = 1 / A;
      return pi;
    }
    for (let a = 0; a < A; a++) pi[a] = counts[a] === max ? 1 / ties : 0;
    return pi;
  }
  let sum = 0;
  for (let a = 0; a < A; a++) {
    if (counts[a] > 0) {
      pi[a] = Math.pow(counts[a], 1 / temperature);
      sum += pi[a];
    }
  }
  if (sum > 0) for (let a = 0; a < A; a++) pi[a] /= sum;
  return pi;
}

// Sample a move index from a distribution.
export function sampleFrom(pi: Float64Array, rng: () => number): number {
  let r = rng();
  for (let a = 0; a < pi.length; a++) {
    r -= pi[a];
    if (r <= 0) return a;
  }
  // Numerical fallback: the last nonzero entry.
  for (let a = pi.length - 1; a >= 0; a--) if (pi[a] > 0) return a;
  return 0;
}

export function argmaxPolicy(pi: Float64Array): number {
  let best = -Infinity;
  let bestA = 0;
  for (let a = 0; a < pi.length; a++) {
    if (pi[a] > best) {
      best = pi[a];
      bestA = a;
    }
  }
  return bestA;
}
