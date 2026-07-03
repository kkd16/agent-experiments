// Live safety panel for the Nakamoto lab.
//
// Two of these are **hard, always-on** structural invariants — they hold no
// matter how cruel the network is, because they are per-node internal
// consistency guaranteed by construction:
//
//   • Chain validity   — every node's canonical chain reaches genesis with
//                         consecutive heights, every block's transactions apply
//                         cleanly against its parent (no in-chain double-spend),
//                         and the node's tip really is the heaviest block it holds
//                         (the longest-chain fork-choice rule, honestly applied).
//   • Conservation     — user-account balances on any node's chain always sum to
//                         the fixed opening total; only the separately-tracked
//                         coinbase reward ever mints coins.
//
// The third is the one Nakamoto safety property that is **probabilistic**, and
// the whole reason a 51% attack is interesting:
//
//   • No finalised reversal — once a block is k deep on a node it is treated as
//                         final; an honest network reorgs only near the tip, so a
//                         finalised block is never replaced. A majority attacker
//                         who mines a longer secret chain *can* replace one — and
//                         this invariant goes red the instant it does.
import type { InvariantResult, NodeView } from '../../sim/types';
import { chainOf, ledgerOf, blockTxsValid, heightOf, shortHash, USER_TOTAL, type NakState } from './types';

export function nakInvariants(views: ReadonlyArray<NodeView<NakState>>): InvariantResult[] {
  const live = views.filter((v) => v.up);

  // ---- Chain validity (structural, always-on) ----
  let validOk = true;
  let validDetail = 'every node holds a valid heaviest chain to genesis';
  for (const v of live) {
    const s = v.state;
    const chain = chainOf(s.blocks, s.tip);
    if (s.tip !== 'genesis' && chain.length === 0) {
      validOk = false;
      validDetail = `${v.id}: tip not connected to genesis`;
      break;
    }
    let bad = '';
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].height !== chain[i - 1].height + 1) bad = `${v.id}: non-consecutive height at #${chain[i].height}`;
      else if (chain[i].parent !== chain[i - 1].hash) bad = `${v.id}: broken parent link at #${chain[i].height}`;
    }
    if (!bad) {
      // the tip must be the heaviest block the node holds
      const tipH = heightOf(s.blocks, s.tip);
      for (const h in s.blocks) if (s.blocks[h].height > tipH) bad = `${v.id}: holds #${s.blocks[h].height} above tip #${tipH}`;
    }
    if (!bad) {
      // every block's transactions must apply cleanly against its parent
      for (const b of chain) if (b.hash !== 'genesis' && !blockTxsValid(s.blocks, b)) bad = `${v.id}: invalid txs in #${b.height}`;
    }
    if (bad) {
      validOk = false;
      validDetail = bad;
      break;
    }
  }

  // ---- Conservation (always-on) ----
  let consOk = true;
  let consDetail = `user balances always sum to ${USER_TOTAL}`;
  for (const v of live) {
    const { ledger } = ledgerOf(v.state.blocks, v.state.tip);
    const sum = Object.values(ledger).reduce((a, b) => a + b.balance, 0);
    if (sum !== USER_TOTAL) {
      consOk = false;
      consDetail = `${v.id}: balances sum to ${sum}, expected ${USER_TOTAL}`;
      break;
    }
    for (const acc of Object.keys(ledger)) {
      if (ledger[acc].balance < 0) {
        consOk = false;
        consDetail = `${v.id}: ${acc} balance ${ledger[acc].balance} < 0`;
      }
    }
    if (!consOk) break;
  }

  // ---- No finalised reversal (probabilistic safety) ----
  const reverted = views.find((v) => v.state.reverted);
  const finalOk = !reverted;
  const finalDetail = reverted
    ? `a finalised block was reverted — ${reverted.id}: ${reverted.state.revertedNote}`
    : 'no k-deep block has ever been replaced (holds with overwhelming probability)';

  return [
    { name: 'Chain validity', ok: validOk, detail: validDetail },
    { name: 'Conservation of coins', ok: consOk, detail: consDetail },
    { name: 'No finalised reversal (probabilistic)', ok: finalOk, detail: finalDetail },
  ];
}

export interface NakGauge {
  height: number;
  commonPrefix: number;
  deepestFork: number;
  agree: number;
  live: number;
  distinctTips: number;
  minted: number;
  orphanBlocks: number;
  totalBlocks: number;
  reverted: boolean;
}

/** Convergence / fork metrics (liveness, not asserted under arbitrary chaos). */
export function nakGauge(views: ReadonlyArray<NodeView<NakState>>): NakGauge {
  const live = views.filter((v) => v.up);
  const chains = live.map((v) => chainOf(v.state.blocks, v.state.tip));
  const heights = chains.map((c) => (c.length ? c[c.length - 1].height : 0));
  const height = heights.length ? Math.max(...heights) : 0;

  // Longest common prefix (by hash) across all live nodes' canonical chains.
  let commonPrefix = 0;
  if (chains.length) {
    const minLen = Math.min(...chains.map((c) => c.length));
    for (let i = 0; i < minLen; i++) {
      const h0 = chains[0][i].hash;
      if (chains.every((c) => c[i].hash === h0)) commonPrefix = chains[0][i].height;
      else break;
    }
  }

  const tipCounts = new Map<string, number>();
  for (const v of live) tipCounts.set(v.state.tip, (tipCounts.get(v.state.tip) ?? 0) + 1);
  let agree = 0;
  for (const c of tipCounts.values()) agree = Math.max(agree, c);

  // Distinct blocks known across the cluster, and how many are off the heaviest
  // chain (orphans / stale branches).
  const allBlocks = new Set<string>();
  const onChain = new Set<string>();
  for (const v of live) {
    for (const h in v.state.blocks) if (h !== 'genesis') allBlocks.add(h);
    for (const b of chainOf(v.state.blocks, v.state.tip)) if (b.hash !== 'genesis') onChain.add(b.hash);
  }
  let orphanBlocks = 0;
  for (const h of allBlocks) if (!onChain.has(h)) orphanBlocks++;

  const minted = live.length ? Math.max(...live.map((v) => ledgerOf(v.state.blocks, v.state.tip).minted)) : 0;

  return {
    height,
    commonPrefix,
    deepestFork: Math.max(0, height - commonPrefix),
    agree,
    live: live.length,
    distinctTips: tipCounts.size,
    minted,
    orphanBlocks,
    totalBlocks: allBlocks.size,
    reverted: views.some((v) => v.state.reverted),
  };
}

/** Short tip label for a node (its head block). */
export function tipLabel(s: NakState): string {
  return shortHash(s.tip);
}
