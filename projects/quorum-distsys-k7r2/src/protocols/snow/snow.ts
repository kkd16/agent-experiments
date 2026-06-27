// Snow* — metastable consensus by repeated random subsampling, on the kernel.
//
// Each node runs an asynchronous round loop:
//
//   round:  sample k random peers → ask each "what colour do you prefer?" →
//           collect the replies (a round-timeout backstops lost ones) → apply the
//           variant's update rule → if not finalised, schedule the next round.
//
// The update rule is where the three variants differ (see `processRound`):
//   • Slush     — adopt any colour that clears the α threshold; no memory, no
//                 finality; freeze after `slushRounds`.
//   • Snowflake — keep one streak counter `cnt`; decide at cnt ≥ β.
//   • Snowball  — also accumulate per-colour confidence `d[·]`; the preference
//                 tracks argmax d so a well-supported colour resists noise.
//
// The one shared bootstrap (the "Slush" part of all three): a responder with no
// opinion adopts the colour it is *asked about* before replying — that is how a
// seeded colour epidemically infects the network so the sampling can take over.
//
// Safety here is **probabilistic**, not absolute: with k/α/β set sanely and an
// honest majority, two honest nodes finalise different colours only with
// vanishing probability — which is exactly what the Agreement invariant watches.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  COLOURS,
  DEFAULT_SNOW_CONFIG,
  colourStr,
  type Colour,
  type SnowConfig,
  type SnowState,
  type SnowCmd,
  type QueryMsg,
  type RespMsg,
} from './types';

export function createSnow(config: SnowConfig = DEFAULT_SNOW_CONFIG): Protocol<SnowState, SnowCmd> {
  const palette = COLOURS.slice(0, Math.max(2, config.colours));

  /** Whether the node should keep running rounds. */
  function active(s: SnowState): boolean {
    if (!s.running) return false;
    if (config.variant === 'slush') return s.slushLeft > 0;
    return s.decided == null;
  }

  /** Record a preference change in the capped trail (for the over-time chart). */
  function setPref(ctx: NodeContext, s: SnowState, c: Colour | null): void {
    if (s.pref === c) return;
    s.pref = c;
    s.trail.push({ t: ctx.now, colour: c });
    if (s.trail.length > config.trailCap) s.trail.splice(0, s.trail.length - config.trailCap);
  }

  /** Kick a node into running rounds (idempotent). */
  function ensureRunning(ctx: NodeContext, s: SnowState, delay = 1): void {
    const was = s.running;
    s.running = true;
    if (!active(s)) {
      s.running = was; // nothing to do (already finalised / frozen)
      return;
    }
    if (!s.active) ctx.setTimer('round', delay);
  }

  /** Begin one query round: sample k peers and ask them all. */
  function beginRound(ctx: NodeContext, s: SnowState): void {
    if (!active(s) || s.active) return;
    const sample = ctx.rng.sample(ctx.peers, config.k);
    if (sample.length === 0) {
      // No peers to ask (e.g. fully isolated) — try again later.
      ctx.setTimer('round', config.roundDelay);
      return;
    }
    s.round++;
    s.active = { round: s.round, sampled: sample, responses: {} };
    for (const p of sample) ctx.send(p, 'Query', { round: s.round, colour: s.pref } as QueryMsg);
    ctx.setTimer('timeout', config.roundTimeout);
  }

  /** Finish the active round once all replies are in (or the timeout fired). */
  function finishRound(ctx: NodeContext, s: SnowState): void {
    const r = s.active;
    if (!r) return;
    s.active = null;
    s.roundsDone++;
    ctx.clearTimer('timeout');

    // Tally the replies (a ⊥ reply backs no colour).
    const counts: Record<Colour, number> = {};
    for (const c of palette) counts[c] = 0;
    for (const c of Object.values(r.responses)) if (c != null) counts[c] = (counts[c] ?? 0) + 1;

    // α > k/2 guarantees at most one colour can clear the threshold.
    let winner: Colour | null = null;
    for (const c of palette) if (counts[c] >= config.alpha) winner = c;

    processRound(ctx, s, winner);

    if (config.variant === 'slush') {
      s.slushLeft--;
      if (s.slushLeft <= 0) {
        s.note = `frozen after ${s.roundsDone} rounds @ ${colourStr(s.pref)}`;
        ctx.log('commit', `Slush frozen @ ${colourStr(s.pref)} (${s.roundsDone} rounds)`);
      }
    }

    if (active(s)) ctx.setTimer('round', config.roundDelay);
  }

  /** Apply the selected variant's confidence update for a round's `winner`. */
  function processRound(ctx: NodeContext, s: SnowState, winner: Colour | null): void {
    if (config.variant === 'slush') {
      if (winner != null) setPref(ctx, s, winner);
      s.note = `round ${s.roundsDone}: ${winner ? 'adopt ' + winner : 'no quorum'} · ${colourStr(s.pref)}`;
      return;
    }

    if (winner == null) {
      s.cnt = 0; // a round with no α-majority breaks the streak
      s.note = `round ${s.roundsDone}: no α-quorum · streak reset · ${colourStr(s.pref)}`;
      return;
    }

    if (config.variant === 'snowball') {
      s.d[winner] = (s.d[winner] ?? 0) + 1;
      if (s.d[winner] > (s.pref == null ? 0 : s.d[s.pref] ?? 0)) setPref(ctx, s, winner);
    } else {
      // Snowflake: the preference follows the winner directly.
      setPref(ctx, s, winner);
    }

    if (winner === s.last) s.cnt++;
    else {
      s.last = winner;
      s.cnt = 1;
    }

    if (s.cnt >= config.beta && s.decided == null) {
      s.decided = s.pref;
      s.note = `decided ${colourStr(s.decided)} (β=${config.beta} reached)`;
      ctx.log('commit', `finalised ${colourStr(s.decided)} after ${s.roundsDone} rounds`);
    } else {
      s.note = `round ${s.roundsDone}: ${winner} wins · streak ${s.cnt}/${config.beta} · ${colourStr(s.pref)}`;
    }
  }

  return {
    name: 'Snow',

    init(ctx) {
      const d: Record<Colour, number> = {};
      for (const c of palette) d[c] = 0;
      const s: SnowState = {
        self: ctx.self,
        pref: null,
        last: null,
        cnt: 0,
        d,
        decided: null,
        round: 0,
        active: null,
        roundsDone: 0,
        running: false,
        slushLeft: config.slushRounds,
        byzantine: false,
        adversary: null,
        trail: [],
        note: 'idle (⊥)',
      };
      return s;
    },

    onRestart(ctx, s) {
      // No stable storage to lose — but in-flight queries are abandoned. Resume
      // the round loop from the node's surviving opinion.
      s.active = null;
      if (s.running) {
        s.running = false; // force ensureRunning to re-arm cleanly
        ensureRunning(ctx, s, config.roundDelay);
      }
      s.note = `restarted @ ${colourStr(s.pref)}`;
    },

    onTimer(ctx, s, name) {
      if (s.byzantine) return; // a Byzantine node runs no honest round loop
      if (name === 'round') beginRound(ctx, s);
      else if (name === 'timeout') finishRound(ctx, s);
    },

    onCommand(ctx, s, cmd) {
      switch (cmd.type) {
        case 'seed': {
          if (s.decided != null) return; // a finalised decision is irrevocable
          const c = palette.includes(cmd.colour) ? cmd.colour : palette[0];
          setPref(ctx, s, c);
          s.last = c;
          if (config.variant === 'snowball') s.d[c] = (s.d[c] ?? 0) + 1;
          s.note = `seeded ${c}`;
          ctx.log('state', `seeded ${c}`);
          ensureRunning(ctx, s);
          return;
        }
        case 'byzantine': {
          s.byzantine = cmd.on;
          if (cmd.on) {
            s.adversary = cmd.adversary && palette.includes(cmd.adversary) ? cmd.adversary : palette[palette.length - 1];
            s.running = false;
            s.active = null;
            ctx.clearTimer('round');
            ctx.clearTimer('timeout');
            s.note = `Byzantine — always answers ${s.adversary}`;
            ctx.log('state', `turned Byzantine (answers ${s.adversary})`);
          } else {
            s.adversary = null;
            s.note = `honest again @ ${colourStr(s.pref)}`;
            ensureRunning(ctx, s);
          }
          return;
        }
        case 'wake': {
          s.note = `woken @ ${colourStr(s.pref)}`;
          ensureRunning(ctx, s);
          return;
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      switch (msg.type) {
        case 'Query': {
          const p = msg.payload as QueryMsg;
          if (s.byzantine) {
            // A Byzantine node lies: it always reports the adversary colour.
            ctx.send(msg.from, 'Resp', { round: p.round, colour: s.adversary, from: ctx.self } as RespMsg);
            return;
          }
          // The Slush bootstrap: an uncoloured node adopts the colour it is asked
          // about, then joins the round loop itself.
          if (s.pref == null && p.colour != null) {
            setPref(ctx, s, p.colour);
            s.last = p.colour;
            if (config.variant === 'snowball') s.d[p.colour] = (s.d[p.colour] ?? 0) + 1;
            ensureRunning(ctx, s, config.roundDelay);
          }
          ctx.send(msg.from, 'Resp', { round: p.round, colour: s.pref, from: ctx.self } as RespMsg);
          return;
        }
        case 'Resp': {
          if (s.byzantine) return;
          const p = msg.payload as RespMsg;
          const r = s.active;
          if (!r || r.round !== p.round) return; // a stale reply from an old round
          if (!r.sampled.includes(p.from)) return;
          r.responses[p.from] = p.colour;
          // Collect all replies before the round timeout; finish early when full.
          if (Object.keys(r.responses).length >= r.sampled.length) finishRound(ctx, s);
          return;
        }
      }
    },
  };
}
