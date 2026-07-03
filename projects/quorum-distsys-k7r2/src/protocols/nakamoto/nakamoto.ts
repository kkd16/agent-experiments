// Nakamoto proof-of-work longest-chain consensus, on the kernel.
//
// Mining is modelled as a memoryless **Poisson process**: a node of hash power
// `p` arms a `mine` timer whose delay is exponentially distributed with mean
// `baseBlockMs / p`, drawn from the seeded RNG (so a whole run — every fork,
// every reorg — is reproducible and time-travels). When the timer fires the
// node produces a block on its current tip, floods it to its peers, and re-arms.
//
// Fork choice is the longest-chain rule: a node adopts the **heaviest block it
// knows** (with constant difficulty, the greatest height), keeping its current
// tip on a tie (first-seen). A block that loses the race is orphaned; its
// transactions flow back into the mempool so they can be re-mined.
//
// Blocks gossip by flooding: a node relays every block it newly learns to its
// other peers. A block whose parent is unknown (e.g. after a crash or partition)
// is buffered as an orphan and its missing ancestor requested with `GetBlock`,
// so a lagging node backfills the gap one link at a time.
//
// The **attacker** is a withholding (51%/selfish) miner: it mines on a *private*
// chain it never broadcasts, staging a double-spend, and reveals the whole
// secret chain on cue — if it out-raced the honest chain, every honest node
// reorgs onto it and the earlier "confirmed" payment is reverted.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  GENESIS,
  ledgerOf,
  selectTxs,
  blockTxsValid,
  heightOf,
  chainOf,
  shortHash,
  DEFAULT_NAK_CONFIG,
  type Block,
  type NakConfig,
  type NakState,
  type NakCmd,
  type BlockMsg,
  type GetBlockMsg,
} from './types';

export function createNakamoto(config: NakConfig = DEFAULT_NAK_CONFIG): Protocol<NakState, NakCmd> {
  /** Draw an exponential mining delay and (re)arm the `mine` timer. */
  function armMine(ctx: NodeContext, s: NakState): void {
    if (!s.mining) return;
    const power = Math.max(0.01, s.power);
    const mean = config.baseBlockMs / power;
    const u = ctx.rng.next(); // [0, 1)
    const delay = Math.max(1, Math.round(-Math.log(1 - u) * mean));
    ctx.setTimer('mine', delay);
  }

  /** The heaviest known block (greatest height); keep the current tip on a tie. */
  function chooseTip(s: NakState): string {
    let best = s.blocks[s.tip] ? s.tip : 'genesis';
    let bestH = heightOf(s.blocks, best);
    for (const h in s.blocks) {
      const b = s.blocks[h];
      if (b.height > bestH) {
        best = h;
        bestH = b.height;
      }
    }
    return best;
  }

  /** Record every height that is now ≥ k deep as finalised; flag a violation if a
   *  previously-finalised height is ever occupied by a different block (a reorg
   *  deeper than k — exactly what a successful 51% attack causes). */
  function checkFinal(s: NakState): void {
    const tipH = heightOf(s.blocks, s.tip);
    const finalH = tipH - config.k;
    if (finalH < 1) return;
    for (const b of chainOf(s.blocks, s.tip)) {
      if (b.height < 1 || b.height > finalH) continue;
      const prev = s.finalized[b.height];
      if (prev === undefined) s.finalized[b.height] = b.hash;
      else if (prev !== b.hash) {
        s.reverted = true;
        s.revertedNote = `#${b.height} ${shortHash(prev)} → ${shortHash(b.hash)}`;
      }
    }
  }

  /** Adopt the heaviest chain; on a reorg, move transactions between the mempool
   *  and the chain so nothing is lost and nothing is double-mined. */
  function updateTip(ctx: NodeContext, s: NakState): void {
    const old = s.tip;
    const next = chooseTip(s);
    if (next !== old) {
      const oldChain = chainOf(s.blocks, old);
      const newChain = chainOf(s.blocks, next);
      const newTxIds = new Set<string>();
      for (const b of newChain) for (const tx of b.txs) newTxIds.add(tx.id);
      // txs that were only in the abandoned branch return to the mempool
      for (const b of oldChain)
        for (const tx of b.txs)
          if (!newTxIds.has(tx.id) && !s.mempool.some((t) => t.id === tx.id)) s.mempool.push(tx);
      // txs now on the canonical chain leave the mempool
      s.mempool = s.mempool.filter((t) => !newTxIds.has(t.id));
      s.tip = next;
      const oldH = oldChain.length ? oldChain[oldChain.length - 1].height : 0;
      const depth = Math.max(0, oldH - forkHeight(oldChain, newChain));
      ctx.log('state', depth > 1 ? `reorg ${depth} deep → #${heightOf(s.blocks, next)}` : `tip → #${heightOf(s.blocks, next)}`);
    }
    checkFinal(s);
  }

  /** The height at which two chains last agreed (their fork point). */
  function forkHeight(a: Block[], b: Block[]): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i].hash === b[i].hash) i++;
    return i > 0 ? a[i - 1].height : 0;
  }

  /** Take in one block: dedup, buffer+request if the parent is missing, validate,
   *  store, and connect any orphans it unblocks. Returns the newly-stored hashes. */
  function ingest(ctx: NodeContext, s: NakState, block: Block, from: string | null): string[] {
    const added: string[] = [];
    if (block.hash === 'genesis' || s.blocks[block.hash]) return added;
    const parentKnown = block.parent === 'genesis' || !!s.blocks[block.parent];
    if (!parentKnown) {
      s.orphans[block.hash] = block;
      if (from && !s.requested[block.parent] && !s.orphans[block.parent]) {
        s.requested[block.parent] = true;
        ctx.send(from, 'GetBlock', { hash: block.parent } as GetBlockMsg);
      }
      return added;
    }
    if (block.height !== heightOf(s.blocks, block.parent) + 1 || !blockTxsValid(s.blocks, block)) {
      ctx.log('drop', `rejected ${shortHash(block.hash)}`);
      return added;
    }
    s.blocks[block.hash] = block;
    delete s.orphans[block.hash];
    added.push(block.hash);
    // Fixpoint: connect any buffered orphans whose parents now exist.
    let progress = true;
    while (progress) {
      progress = false;
      for (const h of Object.keys(s.orphans)) {
        const b = s.orphans[h];
        const pk = b.parent === 'genesis' || !!s.blocks[b.parent];
        if (!pk) continue;
        delete s.orphans[h];
        if (s.blocks[b.hash]) continue;
        if (b.height === heightOf(s.blocks, b.parent) + 1 && blockTxsValid(s.blocks, b)) {
          s.blocks[b.hash] = b;
          added.push(b.hash);
          progress = true;
        }
      }
    }
    return added;
  }

  /** Flood freshly-learned blocks to every peer except the one we heard them from. */
  function relay(ctx: NodeContext, s: NakState, hashes: string[], except: string | null): void {
    for (const h of hashes) {
      const blk = s.blocks[h];
      if (!blk) continue;
      for (const p of ctx.peers) if (p !== except) ctx.send(p, 'Block', { block: blk } as BlockMsg);
    }
  }

  /** Produce one block on the current tip (or the attacker's private tip). */
  function doMine(ctx: NodeContext, s: NakState, force: boolean): void {
    if (!s.mining && !force) return;
    const parent = s.attacker ? s.privateTip || s.tip : s.tip;
    const parentBlock = s.blocks[parent] ?? s.hidden[parent] ?? (parent === 'genesis' ? GENESIS : undefined);
    if (!parentBlock) {
      armMine(ctx, s);
      return;
    }
    const store = s.attacker ? { ...s.blocks, ...s.hidden } : s.blocks;
    const { ledger } = ledgerOf(store, parent);
    const pool = s.attacker && s.attackTx ? [s.attackTx, ...s.mempool] : s.mempool;
    const chosen = selectTxs(pool, ledger, config.blockTxs);
    const block: Block = {
      hash: `${s.self}#${s.seq++}`,
      parent,
      height: parentBlock.height + 1,
      miner: s.self,
      txs: chosen,
      nonce: ctx.rng.int(0, 0xffffff),
      createdAt: ctx.now,
    };
    s.blocksMined++;
    s.mempool = s.mempool.filter((t) => !chosen.some((c) => c.id === t.id));

    if (s.attacker) {
      s.hidden[block.hash] = block;
      s.privateTip = block.hash;
      if (s.attackTx && chosen.some((t) => t.id === s.attackTx!.id)) s.attackTx = null;
      const lead = block.height - heightOf(s.blocks, s.tip);
      s.note = `secret #${block.height} · lead ${lead >= 0 ? '+' : ''}${lead}`;
      ctx.log('state', `⛏ secret #${block.height} (lead ${lead})`);
    } else {
      s.blocks[block.hash] = block;
      updateTip(ctx, s);
      relay(ctx, s, [block.hash], null);
      s.note = `mined #${block.height}`;
      ctx.log('commit', `⛏ #${block.height} ${shortHash(block.hash)} (${chosen.length} tx)`);
    }
    armMine(ctx, s);
  }

  return {
    name: 'Nakamoto',

    init(ctx): NakState {
      return {
        self: ctx.self,
        blocks: { genesis: GENESIS },
        tip: 'genesis',
        orphans: {},
        requested: {},
        hidden: {},
        privateTip: '',
        mempool: [],
        attackTx: null,
        seq: 0,
        power: 1,
        mining: false,
        attacker: false,
        finalized: {},
        reverted: false,
        revertedNote: '',
        blocksMined: 0,
        note: 'idle',
      };
    },

    onRestart(ctx, s) {
      // The chain, finalised heights and any secret blocks persist (a real node
      // keeps them on disk); only the mining timer is volatile — re-arm it.
      s.note = `restarted @ #${heightOf(s.blocks, s.tip)}`;
      if (s.mining) armMine(ctx, s);
    },

    onTimer(ctx, s, name) {
      if (name === 'mine') doMine(ctx, s, false);
    },

    onCommand(ctx, s, cmd) {
      switch (cmd.type) {
        case 'submitTx': {
          if (!s.mempool.some((t) => t.id === cmd.tx.id)) {
            s.mempool.push(cmd.tx);
            ctx.log('info', `tx ${cmd.tx.from}→${cmd.tx.to} ${cmd.tx.amount}`);
          }
          return;
        }
        case 'setMining': {
          s.mining = cmd.on;
          if (cmd.on) {
            s.note = 'mining';
            armMine(ctx, s);
          } else {
            s.note = 'idle';
            ctx.clearTimer('mine');
          }
          return;
        }
        case 'setAttacker': {
          s.attacker = cmd.on;
          if (cmd.on) {
            if (s.privateTip === '') s.privateTip = s.tip;
            s.note = 'attacker: mining privately';
            ctx.log('state', 'turned attacker (withholding)');
          } else {
            s.note = 'honest miner';
          }
          return;
        }
        case 'setPower': {
          s.power = Math.max(0.01, cmd.power);
          if (s.mining) armMine(ctx, s);
          return;
        }
        case 'setAttackTx': {
          s.attackTx = cmd.tx;
          return;
        }
        case 'release': {
          const hiddenBlocks = Object.values(s.hidden).sort((a, b) => a.height - b.height);
          if (!hiddenBlocks.length) {
            s.note = 'nothing to release';
            return;
          }
          s.attacker = false;
          for (const blk of hiddenBlocks) {
            s.blocks[blk.hash] = blk;
            for (const p of ctx.peers) ctx.send(p, 'Block', { block: blk } as BlockMsg);
          }
          s.hidden = {};
          s.privateTip = '';
          updateTip(ctx, s);
          s.note = `released ${hiddenBlocks.length} secret blocks`;
          ctx.log('state', `💥 released ${hiddenBlocks.length} secret blocks`);
          return;
        }
        case 'mineNow': {
          doMine(ctx, s, true);
          return;
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Block': {
          const p = msg.payload as BlockMsg;
          const added = ingest(ctx, s, p.block, msg.from);
          if (added.length) {
            updateTip(ctx, s);
            relay(ctx, s, added, msg.from);
          }
          return;
        }
        case 'GetBlock': {
          const p = msg.payload as GetBlockMsg;
          const blk = s.blocks[p.hash];
          if (blk) ctx.send(msg.from, 'Block', { block: blk } as BlockMsg);
          return;
        }
      }
    },
  };
}
