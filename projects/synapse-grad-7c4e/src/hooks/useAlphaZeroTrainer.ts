import { useCallback, useEffect, useRef, useState } from 'react';
import { mulberry32 } from '../engine/nn';
import { gradCheck, type GradCheckResult } from '../engine/gradcheck';
import { makeGame, solve, type Game, type GameState, type GameId, type Player, type SolveResult } from '../engine/games';
import { makeAZNet, azLoss, type AZNet } from '../engine/aznet';
import {
  runSearch,
  visitPolicy,
  argmaxPolicy,
  sampleFrom,
  type SearchResult,
  type MctsConfig,
} from '../engine/mcts';
import {
  ReplayBuffer,
  playSelfPlayGame,
  makeOptimizer,
  trainStep,
  evaluate,
  netEvaluator,
  type Example,
  type EvalResult,
} from '../engine/selfplay';
import type { Optimizer } from '../engine/optim';

export interface AZConfigUI {
  gameId: GameId;
  // architecture (structural — triggers a rebuild)
  channels: number;
  blocks: number;
  valueHidden: number;
  seed: number;
  // self-play / search
  selfPlaySims: number;
  cPuct: number;
  dirichletAlpha: number;
  dirichletFrac: number;
  tempMoves: number;
  temperature: number;
  augment: boolean;
  // optimization
  lr: number;
  l2: number;
  clipNorm: number;
  batchSize: number;
  bufferCap: number;
  // loop pacing
  gamesPerFrame: number;
  trainStepsPerFrame: number;
  // interactive AI strength
  aiSims: number;
  loadId: number;
}

export interface AZMetrics {
  iter: number; // training updates applied
  selfPlayGames: number;
  bufferSize: number;
  policyLoss: number;
  valueLoss: number;
  policyLossHistory: number[];
  valueLossHistory: number[];
  vsPerfect: EvalResult | null;
  vsRandom: EvalResult | null;
  // history of losses-to-perfect and score-rate-vs-random, one point per evaluation
  lossesToPerfectHistory: number[];
  scoreVsRandomHistory: number[];
  drawRateVsPerfectHistory: number[];
  paramCount: number;
}

const EMPTY: AZMetrics = {
  iter: 0,
  selfPlayGames: 0,
  bufferSize: 0,
  policyLoss: NaN,
  valueLoss: NaN,
  policyLossHistory: [],
  valueLossHistory: [],
  vsPerfect: null,
  vsRandom: null,
  lossesToPerfectHistory: [],
  scoreVsRandomHistory: [],
  drawRateVsPerfectHistory: [],
  paramCount: 0,
};

const MAX_HISTORY = 400;

// The interactive game the human plays against the live network.
export interface PlayState {
  game: Game;
  state: GameState;
  humanPlayer: Player; // which colour the human controls
  status: { done: boolean; winner: number; line: readonly number[] };
  aiThinking: boolean;
  // The search the AI ran for the position currently shown (its read of the board): visit counts,
  // priors, Q and the value. Lets the board overlay "what the AI is thinking".
  analysis: SearchResult | null;
  lastAIMove: number; // the move the AI just played (−1 if none / human to move first)
}

export function useAlphaZeroTrainer(cfg: AZConfigUI) {
  const netRef = useRef<AZNet | null>(null);
  const optRef = useRef<Optimizer | null>(null);
  const bufRef = useRef<ReplayBuffer | null>(null);
  const gameRef = useRef<Game>(makeGame(cfg.gameId));
  const rngRef = useRef<() => number>(() => 0);
  const iterRef = useRef(0);
  const spGamesRef = useRef(0);
  const frameCountRef = useRef(0);
  const runningRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const cfgRef = useRef(cfg);
  // Mirror the latest config into a ref (read by the RAF loop and event callbacks). Writing the ref
  // in an effect keeps it out of the render phase. Declared before the build effect so a structural
  // rebuild always sees the freshest config.
  useEffect(() => {
    cfgRef.current = cfg;
  });

  // Interactive play state lives in refs + mirrored React state.
  const playRef = useRef<{ state: GameState; humanPlayer: Player; lastAIMove: number; analysis: SearchResult | null }>(
    { state: makeGame(cfg.gameId).initial(), humanPlayer: 1, lastAIMove: -1, analysis: null },
  );

  const [running, setRunning] = useState(false);
  const [metrics, setMetrics] = useState<AZMetrics>(EMPTY);
  const [play, setPlay] = useState<PlayState>(() => {
    const g = makeGame(cfg.gameId);
    const s = g.initial();
    return { game: g, state: s, humanPlayer: 1, status: g.status(s), aiThinking: false, analysis: null, lastAIMove: -1 };
  });
  const [tick, setTick] = useState(0);

  const structKey = JSON.stringify({
    gameId: cfg.gameId,
    channels: cfg.channels,
    blocks: cfg.blocks,
    valueHidden: cfg.valueHidden,
    seed: cfg.seed,
    bufferCap: cfg.bufferCap,
    loadId: cfg.loadId,
  });

  // Run a search for the position currently on the play board so the overlay always reflects the
  // live net's read of it (analysis is recomputed whenever the board changes).
  const analyzePlay = useCallback((s: GameState): SearchResult | null => {
    const net = netRef.current;
    const game = gameRef.current;
    if (!net) return null;
    const st = game.status(s);
    if (st.done) return null;
    const mcts: MctsConfig = {
      simulations: cfgRef.current.aiSims,
      cPuct: cfgRef.current.cPuct,
      dirichletAlpha: cfgRef.current.dirichletAlpha,
      dirichletFrac: 0,
    };
    return runSearch(game, s, netEvaluator(net, game), mcts, rngRef.current);
  }, []);

  const syncPlay = useCallback(() => {
    const game = gameRef.current;
    const p = playRef.current;
    setPlay({
      game,
      state: p.state,
      humanPlayer: p.humanPlayer,
      status: game.status(p.state),
      aiThinking: false,
      analysis: p.analysis,
      lastAIMove: p.lastAIMove,
    });
  }, []);

  const buildAll = useCallback(() => {
    setRunning(false);
    runningRef.current = false;
    const c = cfgRef.current;
    const game = makeGame(c.gameId);
    gameRef.current = game;
    const net = makeAZNet(
      {
        planes: game.planes,
        rows: game.rows,
        cols: game.cols,
        numActions: game.numActions,
        channels: c.channels,
        blocks: c.blocks,
        valueHidden: c.valueHidden,
      },
      c.seed,
    );
    netRef.current = net;
    optRef.current = makeOptimizer(net, c.lr);
    bufRef.current = new ReplayBuffer(c.bufferCap);
    rngRef.current = mulberry32((c.seed ^ 0x9e3779b9) >>> 0);
    iterRef.current = 0;
    spGamesRef.current = 0;
    frameCountRef.current = 0;
    const s0 = game.initial();
    playRef.current = { state: s0, humanPlayer: 1, lastAIMove: -1, analysis: null };
    // initial analysis
    playRef.current.analysis = analyzePlay(s0);
    setMetrics({ ...EMPTY, paramCount: net.paramCount() });
    syncPlay();
    setTick((t) => t + 1);
  }, [analyzePlay, syncPlay]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    buildAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  // Live, non-structural updates: optimizer lr.
  useEffect(() => {
    if (optRef.current) optRef.current.cfg.lr = cfg.lr;
  }, [cfg.lr]);

  // One training "micro-iteration": a few self-play games + a few SGD steps.
  const microTrain = useCallback(() => {
    const net = netRef.current;
    const opt = optRef.current;
    const buf = bufRef.current;
    const game = gameRef.current;
    if (!net || !opt || !buf) return;
    const c = cfgRef.current;
    const rng = rngRef.current;
    const spCfg = {
      mcts: {
        simulations: c.selfPlaySims,
        cPuct: c.cPuct,
        dirichletAlpha: c.dirichletAlpha,
        dirichletFrac: c.dirichletFrac,
      },
      tempMoves: c.tempMoves,
      temperature: c.temperature,
      augment: c.augment,
    };
    for (let g = 0; g < Math.max(1, c.gamesPerFrame); g++) {
      const res = playSelfPlayGame(net, game, spCfg, rng);
      buf.pushAll(res.examples);
      spGamesRef.current++;
    }
    let pl = NaN;
    let vl = NaN;
    if (buf.size >= Math.min(c.batchSize, 128)) {
      let psum = 0;
      let vsum = 0;
      let n = 0;
      for (let s = 0; s < c.trainStepsPerFrame; s++) {
        const batch: Example[] = buf.sample(c.batchSize, rng);
        const tr = trainStep(net, opt, batch, c.l2, c.clipNorm);
        psum += tr.policyLoss;
        vsum += tr.valueLoss;
        n++;
        iterRef.current++;
      }
      if (n > 0) {
        pl = psum / n;
        vl = vsum / n;
      }
    }
    return { pl, vl };
  }, []);

  const runEval = useCallback((): { vsPerfect: EvalResult; vsRandom: EvalResult } | null => {
    const net = netRef.current;
    const game = gameRef.current;
    if (!net) return null;
    const c = cfgRef.current;
    const perfectKind = c.gameId === 'ttt' ? 'perfect' : 'strong';
    const vsPerfect = evaluate(net, game, perfectKind, 30, c.aiSims, c.cPuct, mulberry32((iterRef.current * 2654435761) >>> 0), 7);
    const vsRandom = evaluate(net, game, 'random', 40, c.aiSims, c.cPuct, mulberry32((iterRef.current * 40503 + 7) >>> 0));
    return { vsPerfect, vsRandom };
  }, []);

  // The animation loop: trains while running, and refreshes the live analysis overlay.
  useEffect(() => {
    let alive = true;
    const frame = () => {
      if (!alive) return;
      frameCountRef.current++;
      if (runningRef.current) {
        const r = microTrain();
        // Periodic evaluation (cheap games but with search — throttle).
        const c = cfgRef.current;
        const evalEvery = Math.max(4, Math.round(40 / Math.max(1, c.gamesPerFrame)));
        let evalRes: { vsPerfect: EvalResult; vsRandom: EvalResult } | null = null;
        if (frameCountRef.current % evalEvery === 0) evalRes = runEval();
        // Refresh the play-board analysis against the improving net (if human hasn't finished).
        if (frameCountRef.current % 3 === 0) {
          const p = playRef.current;
          if (!gameRef.current.status(p.state).done) p.analysis = analyzePlay(p.state);
        }
        setMetrics((m) => {
          const cap = (arr: number[]) => (arr.length >= MAX_HISTORY ? arr.slice(1) : arr.slice());
          const pH = cap(m.policyLossHistory);
          const vH = cap(m.valueLossHistory);
          if (r && Number.isFinite(r.pl)) {
            pH.push(r.pl);
            vH.push(r.vl);
          }
          const lpH = m.lossesToPerfectHistory.slice();
          const srH = m.scoreVsRandomHistory.slice();
          const drH = m.drawRateVsPerfectHistory.slice();
          if (evalRes) {
            lpH.push(evalRes.vsPerfect.losses);
            srH.push(evalRes.vsRandom.scoreRate);
            drH.push(evalRes.vsPerfect.draws / Math.max(1, evalRes.vsPerfect.games));
            if (lpH.length > MAX_HISTORY) lpH.shift();
            if (srH.length > MAX_HISTORY) srH.shift();
            if (drH.length > MAX_HISTORY) drH.shift();
          }
          return {
            ...m,
            iter: iterRef.current,
            selfPlayGames: spGamesRef.current,
            bufferSize: bufRef.current?.size ?? 0,
            policyLoss: r && Number.isFinite(r.pl) ? r.pl : m.policyLoss,
            valueLoss: r && Number.isFinite(r.vl) ? r.vl : m.valueLoss,
            policyLossHistory: pH,
            valueLossHistory: vH,
            vsPerfect: evalRes ? evalRes.vsPerfect : m.vsPerfect,
            vsRandom: evalRes ? evalRes.vsRandom : m.vsRandom,
            lossesToPerfectHistory: lpH,
            scoreVsRandomHistory: srH,
            drawRateVsPerfectHistory: drH,
          };
        });
        if (frameCountRef.current % 3 === 0) syncPlay();
      }
      setTick((t) => (t + 1) % 1000000);
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      alive = false;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [microTrain, runEval, analyzePlay, syncPlay]);

  // --- interactive play -------------------------------------------------------------------------

  const aiMoveIfNeeded = useCallback(() => {
    const game = gameRef.current;
    const net = netRef.current;
    const p = playRef.current;
    if (!net) return;
    // Keep playing AI moves while it is the AI's turn and the game is live.
    while (!game.status(p.state).done && p.state.player !== p.humanPlayer) {
      const res = analyzePlay(p.state);
      const move = res ? argmaxPolicy(visitPolicy(res.counts, 0)) : game.legalMoves(p.state)[0];
      p.state = game.apply(p.state, move);
      p.lastAIMove = move;
    }
    p.analysis = game.status(p.state).done ? null : analyzePlay(p.state);
    syncPlay();
  }, [analyzePlay, syncPlay]);

  const humanMove = useCallback(
    (action: number) => {
      const game = gameRef.current;
      const p = playRef.current;
      if (game.status(p.state).done) return;
      if (p.state.player !== p.humanPlayer) return;
      if (!game.legalMask(p.state)[action]) return;
      p.state = game.apply(p.state, action);
      p.lastAIMove = -1;
      // Then let the AI respond.
      aiMoveIfNeeded();
    },
    [aiMoveIfNeeded],
  );

  const newGame = useCallback(
    (humanFirst: boolean) => {
      const game = gameRef.current;
      const p = playRef.current;
      p.state = game.initial();
      p.humanPlayer = humanFirst ? 1 : -1;
      p.lastAIMove = -1;
      p.analysis = null;
      if (!humanFirst) aiMoveIfNeeded();
      else {
        p.analysis = analyzePlay(p.state);
        syncPlay();
      }
    },
    [aiMoveIfNeeded, analyzePlay, syncPlay],
  );

  // --- controls ---------------------------------------------------------------------------------

  const start = useCallback(() => {
    runningRef.current = true;
    setRunning(true);
  }, []);
  const pause = useCallback(() => {
    runningRef.current = false;
    setRunning(false);
  }, []);
  const reset = useCallback(() => buildAll(), [buildAll]);
  const evalNow = useCallback(() => {
    const r = runEval();
    if (r) {
      setMetrics((m) => ({
        ...m,
        vsPerfect: r.vsPerfect,
        vsRandom: r.vsRandom,
        lossesToPerfectHistory: [...m.lossesToPerfectHistory, r.vsPerfect.losses].slice(-MAX_HISTORY),
        scoreVsRandomHistory: [...m.scoreVsRandomHistory, r.vsRandom.scoreRate].slice(-MAX_HISTORY),
        drawRateVsPerfectHistory: [
          ...m.drawRateVsPerfectHistory,
          r.vsPerfect.draws / Math.max(1, r.vsPerfect.games),
        ].slice(-MAX_HISTORY),
      }));
    }
  }, [runEval]);

  // Gradient-check the AlphaZero loss end-to-end on a small random batch with all-legal masks and
  // off-kink continuous inputs (the same convention the engine self-test uses).
  const runGradCheck = useCallback((): GradCheckResult | null => {
    const net = netRef.current;
    if (!net) return null;
    const c = net.cfg;
    const rng = mulberry32(0x5eed);
    const N = 4;
    const cells = c.rows * c.cols;
    const enc = new Float64Array(N * c.planes * cells);
    for (let i = 0; i < enc.length; i++) {
      let v = rng() * 2 - 1;
      if (Math.abs(v) < 0.15) v += v >= 0 ? 0.15 : -0.15;
      enc[i] = v;
    }
    const mask = new Float64Array(N * c.numActions).fill(1);
    const pi = new Float64Array(N * c.numActions);
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let a = 0; a < c.numActions; a++) {
        const v = rng();
        pi[n * c.numActions + a] = v;
        s += v;
      }
      for (let a = 0; a < c.numActions; a++) pi[n * c.numActions + a] /= s;
    }
    const z = new Float64Array(N);
    for (let n = 0; n < N; n++) z[n] = rng() * 1.6 - 0.8;
    return gradCheck(net.parameters(), () => azLoss(net, enc, mask, pi, z, N, 1e-4).loss, {
      samplesPerParam: 5,
      seed: 4321,
    });
  }, []);

  // The verifiable oracle property: with a PERFECT evaluator, MCTS must pick a minimax-optimal move
  // at a battery of random positions (and the perfect solver values the empty board as a draw).
  const runOracleCheck = useCallback((): { tested: number; optimal: number; emptyValue: number } | null => {
    const game = gameRef.current;
    if (game.id !== 'ttt') return null;
    const memo = new Map<string, SolveResult>();
    const perfect = (s: GameState) => {
      const legal = game.legalMoves(s);
      const policy = new Float64Array(game.numActions);
      for (const a of legal) policy[a] = 1 / legal.length;
      return { policy, value: solve(game, s, memo).score };
    };
    const rng = mulberry32(0xc0ffee);
    let tested = 0;
    let optimal = 0;
    for (let t = 0; t < 60; t++) {
      // Random reachable non-terminal position.
      let s = game.initial();
      const depth = Math.floor(rng() * 5);
      for (let d = 0; d < depth; d++) {
        if (game.status(s).done) break;
        const m = game.legalMoves(s);
        s = game.apply(s, m[Math.floor(rng() * m.length)]);
      }
      if (game.status(s).done) continue;
      const res = runSearch(game, s, perfect, { simulations: 48, cPuct: 1.5, dirichletAlpha: 0.3, dirichletFrac: 0 }, rng);
      const move = argmaxPolicy(visitPolicy(res.counts, 0));
      const opt = new Set(solve(game, s, memo).optimalMoves);
      tested++;
      if (opt.has(move)) optimal++;
    }
    const emptyValue = solve(game, game.initial(), memo).score;
    return { tested, optimal, emptyValue };
  }, []);

  return {
    running,
    tick,
    metrics,
    play,
    start,
    pause,
    reset,
    evalNow,
    humanMove,
    newGame,
    runGradCheck,
    runOracleCheck,
    sampleFrom,
  };
}
