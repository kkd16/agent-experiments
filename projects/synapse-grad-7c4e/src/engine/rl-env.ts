// Reinforcement-learning environments, written from scratch (no Gym, no bundled data).
//
// Each environment is a small Markov decision process: `reset()` returns a fresh observation,
// `step(action)` advances the simulation and returns the next observation, the scalar reward,
// and whether the episode ended (terminated on a real terminal state, or truncated by a time
// limit). The observations are pre-normalized so they feed an MLP policy directly. The raw
// internal state is exposed for the live canvas views.

export type EnvKind = 'cartpole' | 'gridworld';

export interface StepResult {
  obs: Float64Array;
  reward: number;
  terminated: boolean; // a real terminal state (pole fell / reached goal or pit)
  truncated: boolean; // hit the step limit
}

export interface Env {
  readonly kind: EnvKind;
  readonly stateDim: number;
  readonly nActions: number;
  readonly actionLabels: string[];
  reset(): Float64Array;
  step(action: number): StepResult;
  observe(): Float64Array;
  steps: number; // steps taken in the current episode
}

// ---------------------------------------------------------------------------------------------
// CartPole — the classic control benchmark (the gym CartPole-v1 dynamics, semi-implicit Euler).
// A pole is hinged on a cart that slides on a frictionless track; the agent pushes the cart left
// (0) or right (1) and earns +1 for every step the pole stays up. The episode ends when the pole
// tips past 12° or the cart runs off the ±2.4 track, and is truncated at 500 steps.
// ---------------------------------------------------------------------------------------------

const CP_GRAVITY = 9.8;
const CP_MASSCART = 1.0;
const CP_MASSPOLE = 0.1;
const CP_TOTAL_MASS = CP_MASSCART + CP_MASSPOLE;
const CP_LENGTH = 0.5; // half the pole's length
const CP_POLEMASS_LENGTH = CP_MASSPOLE * CP_LENGTH;
const CP_FORCE_MAG = 10.0;
const CP_TAU = 0.02; // seconds between state updates
const CP_THETA_LIMIT = (12 * 2 * Math.PI) / 360; // 12 degrees in radians
const CP_X_LIMIT = 2.4;
const CP_MAX_STEPS = 500;

export class CartPole implements Env {
  readonly kind = 'cartpole' as const;
  readonly stateDim = 4;
  readonly nActions = 2;
  readonly actionLabels = ['← push', 'push →'];
  // [x, x_dot, theta, theta_dot]
  state = new Float64Array(4);
  steps = 0;
  private rng: () => number;

  constructor(rng: () => number) {
    this.rng = rng;
    this.reset();
  }

  reset(): Float64Array {
    for (let i = 0; i < 4; i++) this.state[i] = (this.rng() * 2 - 1) * 0.05;
    this.steps = 0;
    return this.observe();
  }

  // Scale each state component to roughly unit range so the policy/value MLP sees well-conditioned
  // inputs (raw theta is tiny, raw velocities can be large).
  observe(): Float64Array {
    const [x, xd, th, thd] = this.state;
    return Float64Array.from([x / CP_X_LIMIT, xd / 3, th / CP_THETA_LIMIT, thd / 3]);
  }

  step(action: number): StepResult {
    const force = action === 1 ? CP_FORCE_MAG : -CP_FORCE_MAG;
    let [x, xDot, theta, thetaDot] = this.state;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const temp = (force + CP_POLEMASS_LENGTH * thetaDot * thetaDot * sin) / CP_TOTAL_MASS;
    const thetaAcc =
      (CP_GRAVITY * sin - cos * temp) /
      (CP_LENGTH * (4 / 3 - (CP_MASSPOLE * cos * cos) / CP_TOTAL_MASS));
    const xAcc = temp - (CP_POLEMASS_LENGTH * thetaAcc * cos) / CP_TOTAL_MASS;
    // Semi-implicit Euler (update velocity first, then position) — matches gym.
    x += CP_TAU * xDot;
    xDot += CP_TAU * xAcc;
    theta += CP_TAU * thetaDot;
    thetaDot += CP_TAU * thetaAcc;
    this.state[0] = x;
    this.state[1] = xDot;
    this.state[2] = theta;
    this.state[3] = thetaDot;
    this.steps++;

    const terminated = Math.abs(x) > CP_X_LIMIT || Math.abs(theta) > CP_THETA_LIMIT;
    const truncated = this.steps >= CP_MAX_STEPS;
    return { obs: this.observe(), reward: 1, terminated, truncated };
  }
}

export const CARTPOLE_LIMITS = {
  x: CP_X_LIMIT,
  theta: CP_THETA_LIMIT,
  maxSteps: CP_MAX_STEPS,
};

// ---------------------------------------------------------------------------------------------
// GridWorld — a small maze the agent navigates with four moves (up / right / down / left). Each
// step costs a little (−0.005) to encourage short paths; stepping onto the goal pays +1 and ends
// the episode, stepping into a pit pays −1 and ends it. Walls block movement (the agent stays
// put). The observation is a one-hot of the current cell, which makes the value/policy networks
// behave like a smoothly-learned lookup table — perfect for the value-heatmap and policy-arrow
// views, where you watch value propagate backward from the goal.
// ---------------------------------------------------------------------------------------------

export type Cell = 'empty' | 'wall' | 'pit' | 'goal' | 'start';

export interface GridLayout {
  id: string;
  label: string;
  w: number;
  h: number;
  cells: Cell[]; // row-major, length w*h
  start: number; // start cell index
  stepCost: number;
  maxSteps: number;
}

// A few hand-designed mazes. `S` start, `G` goal, `#` wall, `X` pit, `.` empty.
function parseLayout(id: string, label: string, rows: string[], stepCost = 0.005, maxSteps = 80): GridLayout {
  const h = rows.length;
  const w = rows[0].length;
  const cells: Cell[] = [];
  let start = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      const idx = r * w + c;
      if (ch === '#') cells.push('wall');
      else if (ch === 'X') cells.push('pit');
      else if (ch === 'G') cells.push('goal');
      else if (ch === 'S') {
        cells.push('start');
        start = idx;
      } else cells.push('empty');
    }
  }
  return { id, label, w, h, cells, start, stepCost, maxSteps };
}

export const GRID_LAYOUTS: GridLayout[] = [
  parseLayout('cliff', 'Cliff walk', [
    '........',
    '........',
    '........',
    '........',
    '.####...',
    '.#......',
    'S#XXXX.G',
    '...XXX..',
  ]),
  parseLayout('rooms', 'Four rooms', [
    '...#...G',
    '...#....',
    '........',
    '...#....',
    '.#.#.##.',
    '....#...',
    'S...#...',
    '....#...',
  ]),
  parseLayout('snake', 'Snake corridor', [
    'S.......',
    '#######.',
    '........',
    '.#######',
    '........',
    '#######.',
    '......G.',
    '........',
  ], 0.005, 110),
  parseLayout('lakes', 'Twin lakes', [
    'S......G',
    '........',
    '..XXXX..',
    '........',
    '..XXXX..',
    '........',
    '........',
    '........',
  ], 0.005, 90),
];

const GRID_MOVES = [
  [-1, 0], // 0 up
  [0, 1], // 1 right
  [1, 0], // 2 down
  [0, -1], // 3 left
];

export class GridWorld implements Env {
  readonly kind = 'gridworld' as const;
  readonly nActions = 4;
  readonly actionLabels = ['↑ up', '→ right', '↓ down', '← left'];
  readonly stateDim: number;
  layout: GridLayout;
  pos: number; // current cell index
  steps = 0;

  constructor(layout: GridLayout) {
    this.layout = layout;
    this.stateDim = layout.w * layout.h;
    this.pos = layout.start;
    this.reset();
  }

  reset(): Float64Array {
    this.pos = this.layout.start;
    this.steps = 0;
    return this.observe();
  }

  observe(): Float64Array {
    const v = new Float64Array(this.stateDim);
    v[this.pos] = 1;
    return v;
  }

  // One-hot observation for any cell (used by the value/policy field views).
  observeCell(idx: number): Float64Array {
    const v = new Float64Array(this.stateDim);
    v[idx] = 1;
    return v;
  }

  step(action: number): StepResult {
    const { w, h, cells, stepCost, maxSteps } = this.layout;
    const r = Math.floor(this.pos / w);
    const c = this.pos % w;
    const [dr, dc] = GRID_MOVES[action];
    let nr = r + dr;
    let nc = c + dc;
    // Out of bounds or into a wall → stay put.
    if (nr < 0 || nr >= h || nc < 0 || nc >= w || cells[nr * w + nc] === 'wall') {
      nr = r;
      nc = c;
    }
    this.pos = nr * w + nc;
    this.steps++;
    const cell = cells[this.pos];
    let reward = -stepCost;
    let terminated = false;
    if (cell === 'goal') {
      reward = 1;
      terminated = true;
    } else if (cell === 'pit') {
      reward = -1;
      terminated = true;
    }
    const truncated = this.steps >= maxSteps;
    return { obs: this.observe(), reward, terminated, truncated };
  }
}

export function makeEnv(kind: EnvKind, gridLayoutId: string, rng: () => number): Env {
  if (kind === 'gridworld') {
    const layout = GRID_LAYOUTS.find((l) => l.id === gridLayoutId) ?? GRID_LAYOUTS[0];
    return new GridWorld(layout);
  }
  return new CartPole(rng);
}
