// Reinforcement-learning environments, written from scratch (no Gym, no bundled data).
//
// Each environment is a small Markov decision process: `reset()` returns a fresh observation,
// `step(action)` advances the simulation and returns the next observation, the scalar reward,
// and whether the episode ended (terminated on a real terminal state, or truncated by a time
// limit). The observations are pre-normalized so they feed an MLP policy directly. The raw
// internal state is exposed for the live canvas views.

export type EnvKind = 'cartpole' | 'gridworld' | 'pendulum' | 'mountaincar';

export interface StepResult {
  obs: Float64Array;
  reward: number;
  terminated: boolean; // a real terminal state (pole fell / reached goal or pit)
  truncated: boolean; // hit the step limit
}

export interface Env {
  readonly kind: EnvKind;
  readonly stateDim: number;
  readonly nActions: number; // discrete action count, or the action dimension when continuous
  readonly continuous: boolean; // false → categorical, true → diagonal-Gaussian (a real-valued action vector)
  readonly actDim: number; // continuous action dimension (0 for discrete)
  readonly actionLabels: string[];
  reset(): Float64Array;
  // Discrete envs take an action index; continuous envs take a real-valued action vector. Either
  // accepts a bare number for the 1-D case so callers don't have to box a single scalar.
  step(action: number | Float64Array): StepResult;
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
  readonly continuous = false;
  readonly actDim = 0;
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

  step(action: number | Float64Array): StepResult {
    const a = typeof action === 'number' ? action : action[0];
    const force = a === 1 ? CP_FORCE_MAG : -CP_FORCE_MAG;
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
  readonly continuous = false;
  readonly actDim = 0;
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

  step(action: number | Float64Array): StepResult {
    const act = typeof action === 'number' ? action : action[0];
    const { w, h, cells, stepCost, maxSteps } = this.layout;
    const r = Math.floor(this.pos / w);
    const c = this.pos % w;
    const [dr, dc] = GRID_MOVES[act];
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

// ---------------------------------------------------------------------------------------------
// Pendulum — the canonical *continuous-control* benchmark (the gym Pendulum-v1 dynamics). An
// underactuated pendulum hangs from a pivot; the agent applies a real-valued torque u ∈ [−2, 2]
// and must swing it up and balance it inverted. The torque alone is too weak to lift the pendulum
// directly, so the agent has to learn to pump energy in — the move you cannot get from a discrete
// left/right push. The angle θ is measured from upright (θ = 0 is balanced), and the reward
//   r = −(θ² + 0.1·θ̇² + 0.001·u²)
// is always negative, peaking at 0 when the pendulum is upright, still and untorqued; a good policy
// drives the per-episode return from roughly −1500 (flailing) up toward ≈ −150 (a clean swing-up).
// The episode never terminates; it is truncated at 200 steps. The action space is 1-D, so the
// diagonal-Gaussian policy has a single mean and a single learnable log-σ.
// ---------------------------------------------------------------------------------------------

const PEN_G = 10.0;
const PEN_M = 1.0;
const PEN_L = 1.0;
const PEN_DT = 0.05;
const PEN_MAX_SPEED = 8.0;
const PEN_MAX_TORQUE = 2.0;
const PEN_MAX_STEPS = 200;

// Wrap an angle into (−π, π].
function angleNormalize(x: number): number {
  return ((x + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

export class Pendulum implements Env {
  readonly kind = 'pendulum' as const;
  readonly stateDim = 3;
  readonly nActions = 1;
  readonly continuous = true;
  readonly actDim = 1;
  readonly actionLabels = ['torque'];
  // [theta, thetaDot]; theta = 0 is upright.
  state = new Float64Array(2);
  lastTorque = 0;
  steps = 0;
  private rng: () => number;

  constructor(rng: () => number) {
    this.rng = rng;
    this.reset();
  }

  reset(): Float64Array {
    // Start from a random angle (usually near hanging-down) with a small velocity.
    this.state[0] = (this.rng() * 2 - 1) * Math.PI;
    this.state[1] = (this.rng() * 2 - 1) * 1.0;
    this.lastTorque = 0;
    this.steps = 0;
    return this.observe();
  }

  observe(): Float64Array {
    const [th, thd] = this.state;
    return Float64Array.from([Math.cos(th), Math.sin(th), thd / PEN_MAX_SPEED]);
  }

  step(action: number | Float64Array): StepResult {
    const raw = typeof action === 'number' ? action : action[0];
    const u = Math.max(-PEN_MAX_TORQUE, Math.min(PEN_MAX_TORQUE, raw));
    this.lastTorque = u;
    const [th, thd] = this.state;
    const cost = angleNormalize(th) ** 2 + 0.1 * thd * thd + 0.001 * u * u;
    // Gravity pulls away from upright (θ = 0 is the unstable equilibrium).
    let newThd = thd + ((3 * PEN_G) / (2 * PEN_L) * Math.sin(th) + (3.0 / (PEN_M * PEN_L * PEN_L)) * u) * PEN_DT;
    newThd = Math.max(-PEN_MAX_SPEED, Math.min(PEN_MAX_SPEED, newThd));
    const newTh = th + newThd * PEN_DT;
    this.state[0] = newTh;
    this.state[1] = newThd;
    this.steps++;
    const truncated = this.steps >= PEN_MAX_STEPS;
    return { obs: this.observe(), reward: -cost, terminated: false, truncated };
  }
}

export const PENDULUM_LIMITS = { maxSpeed: PEN_MAX_SPEED, maxTorque: PEN_MAX_TORQUE, maxSteps: PEN_MAX_STEPS };

// ---------------------------------------------------------------------------------------------
// MountainCar — the classic *sparse-reward exploration* benchmark (the gym MountainCar-v0
// dynamics). An underpowered car sits in a valley between two hills; its engine cannot climb the
// right slope directly, so it must rock back and forth to build momentum. Three actions: push
// left (0), coast (1), push right (2). The native reward is −1 every step until the flag at the
// top is reached (terminate), truncating at 200 — a famously hard credit-assignment problem for a
// vanilla policy gradient because *every* early trajectory gets the same flat return.
//
// To make it learnable inside a live browser demo without changing the optimal policy, the env
// adds **potential-based reward shaping** (Ng, Harada & Russell, 1999): an extra reward
//   F(s, s′) = γ·Φ(s′) − Φ(s),  Φ(s) = κ · (mechanical energy of the car).
// This telescopes to a constant over any full trajectory, so it provably leaves the set of
// optimal policies unchanged while giving a dense gradient that rewards gaining height/speed.
// ---------------------------------------------------------------------------------------------

const MC_MIN_POS = -1.2;
const MC_MAX_POS = 0.6;
const MC_MAX_SPEED = 0.07;
const MC_GOAL_POS = 0.5;
const MC_FORCE = 0.001;
const MC_GRAVITY = 0.0025;
const MC_MAX_STEPS = 200;
const MC_SHAPE_K = 4.0; // potential scale (κ); 0 recovers the bare sparse reward.

// Hill height h(x) = sin(3x); the car's potential energy ∝ g·h and kinetic ∝ ½v². The shaping
// potential bundles both into a single mechanical-energy term (scaled to ~unit range).
function mcPotential(pos: number, vel: number): number {
  const height = Math.sin(3 * pos);
  const kinetic = 0.5 * (vel / MC_MAX_SPEED) * (vel / MC_MAX_SPEED);
  return MC_SHAPE_K * (height + kinetic);
}

export class MountainCar implements Env {
  readonly kind = 'mountaincar' as const;
  readonly stateDim = 2;
  readonly nActions = 3;
  readonly continuous = false;
  readonly actDim = 0;
  readonly actionLabels = ['← left', '— coast', '→ right'];
  // [position, velocity]
  state = new Float64Array(2);
  steps = 0;
  private rng: () => number;
  private gamma: number;

  constructor(rng: () => number, gamma = 0.99) {
    this.rng = rng;
    this.gamma = gamma;
    this.reset();
  }

  reset(): Float64Array {
    this.state[0] = -0.6 + this.rng() * 0.2; // valley floor, [-0.6, -0.4]
    this.state[1] = 0;
    this.steps = 0;
    return this.observe();
  }

  observe(): Float64Array {
    const [pos, vel] = this.state;
    // Centre/scale to roughly [-1, 1] so the policy/value MLP sees well-conditioned inputs.
    return Float64Array.from([(pos + 0.3) / 0.9, vel / MC_MAX_SPEED]);
  }

  step(action: number | Float64Array): StepResult {
    const act = typeof action === 'number' ? action : action[0];
    let [pos, vel] = this.state;
    const phiBefore = mcPotential(pos, vel);
    vel += (act - 1) * MC_FORCE - Math.cos(3 * pos) * MC_GRAVITY;
    vel = Math.max(-MC_MAX_SPEED, Math.min(MC_MAX_SPEED, vel));
    pos += vel;
    if (pos < MC_MIN_POS) {
      pos = MC_MIN_POS;
      if (vel < 0) vel = 0; // inelastic left wall
    }
    pos = Math.min(MC_MAX_POS, pos);
    this.state[0] = pos;
    this.state[1] = vel;
    this.steps++;
    const terminated = pos >= MC_GOAL_POS;
    const phiAfter = mcPotential(pos, vel);
    // Potential-based shaping: F = γ·Φ(s′) − Φ(s) (Φ(terminal) treated as 0 to keep the telescope clean).
    const shaping = (terminated ? 0 : this.gamma * phiAfter) - phiBefore;
    const reward = -1 + shaping;
    const truncated = this.steps >= MC_MAX_STEPS;
    return { obs: this.observe(), reward, terminated, truncated };
  }
}

export const MOUNTAINCAR_LIMITS = {
  minPos: MC_MIN_POS,
  maxPos: MC_MAX_POS,
  maxSpeed: MC_MAX_SPEED,
  goalPos: MC_GOAL_POS,
  maxSteps: MC_MAX_STEPS,
};

export function makeEnv(kind: EnvKind, gridLayoutId: string, rng: () => number, gamma = 0.99): Env {
  if (kind === 'gridworld') {
    const layout = GRID_LAYOUTS.find((l) => l.id === gridLayoutId) ?? GRID_LAYOUTS[0];
    return new GridWorld(layout);
  }
  if (kind === 'pendulum') return new Pendulum(rng);
  if (kind === 'mountaincar') return new MountainCar(rng, gamma);
  return new CartPole(rng);
}
