// Bracha reliable broadcast on the kernel.
//
// Each correct node, for the single broadcast instance:
//   • on SEND(v) from the sender (accepted once): ECHO(v).
//   • on ECHO(v): once it has > (N+f)/2 distinct echoes of v, go READY(v).
//   • on READY(v): once f+1 distinct readies of v, also go READY(v) (amplify);
//     once 2f+1 distinct readies of v, DELIVER(v).
//
// A node records its *own* echo/ready in the tally too, so quorum counts include
// it. A Byzantine node ignores all of this: it equivocates, sending value A to
// some peers and B to others (a per-recipient payload), trying to make different
// correct nodes deliver different values — which Bracha's quorums forbid as long
// as the traitors number ≤ f.
import type { NodeContext, Message, Protocol } from '../../sim/types';
import {
  DEFAULT_BRB_CONFIG,
  faultBudget,
  echoQuorum,
  readyAmplify,
  readyDeliver,
  type BrbConfig,
  type BrbState,
  type BrbCmd,
  type BrbMsg,
  type Value,
} from './types';

export function createBrb(config: BrbConfig = DEFAULT_BRB_CONFIG): Protocol<BrbState, BrbCmd> {
  /** The value a traitor feeds peer `p` — split the cluster by peer index. */
  function faction(ctx: NodeContext, p: string): Value {
    const i = ctx.all.indexOf(p);
    return config.values[i % 2];
  }

  function addEcho(s: BrbState, value: Value, from: string): void {
    const set = (s.echoes[value] ??= []);
    if (!set.includes(from)) set.push(from);
  }
  function addReady(s: BrbState, value: Value, from: string): void {
    const set = (s.readies[value] ??= []);
    if (!set.includes(from)) set.push(from);
  }

  /** A Byzantine node's one-time equivocation: split echoes AND readies. */
  function byzantineAct(ctx: NodeContext, s: BrbState): void {
    if (s.byzActed) return;
    s.byzActed = true;
    s.note = 'equivocating (A to some, B to others)';
    ctx.log('state', 'Byzantine: equivocates ECHO+READY');
    ctx.broadcast('Echo', (p) => ({ value: faction(ctx, p) } as BrbMsg));
    ctx.broadcast('Ready', (p) => ({ value: faction(ctx, p) } as BrbMsg));
  }

  function goReady(ctx: NodeContext, s: BrbState, value: Value): void {
    if (s.readySent != null) return;
    s.readySent = value;
    addReady(s, value, ctx.self); // count our own ready
    s.note = `READY(${value})`;
    ctx.broadcast('Ready', () => ({ value } as BrbMsg));
    maybeDeliver(ctx, s, value);
  }

  function maybeReadyFromEchoes(ctx: NodeContext, s: BrbState, value: Value, n: number, f: number): void {
    if (s.readySent == null && (s.echoes[value]?.length ?? 0) >= echoQuorum(n, f)) goReady(ctx, s, value);
  }

  function maybeDeliver(ctx: NodeContext, s: BrbState, value: Value): void {
    const f = faultBudget(ctx.all.length);
    if (s.delivered == null && (s.readies[value]?.length ?? 0) >= readyDeliver(f)) {
      s.delivered = value;
      s.note = `DELIVERED ${value}`;
      ctx.log('commit', `delivered ${value}`);
    }
  }

  return {
    name: 'Bracha-RB',

    init(ctx) {
      const s: BrbState = {
        self: ctx.self,
        sender: ctx.all[0],
        byzantine: false,
        byzActed: false,
        echoSent: null,
        readySent: null,
        delivered: null,
        sawSend: false,
        echoes: {},
        readies: {},
        note: 'idle',
      };
      return s;
    },

    onRestart(_ctx, s) {
      s.note = 'restarted';
    },

    onTimer() {
      /* no timers — reliable broadcast is message-driven */
    },

    onCommand(ctx, s, cmd) {
      if (cmd.type === 'byzantine') {
        s.byzantine = cmd.on;
        s.note = cmd.on ? 'Byzantine' : 'honest';
        return;
      }
      if (cmd.type === 'broadcast') {
        // Only the designated sender originates.
        if (ctx.self !== s.sender) return;
        if (s.byzantine) {
          // Equivocate: different value to different peers.
          s.note = 'Byzantine sender — equivocates SEND';
          ctx.log('state', 'Byzantine sender equivocates');
          ctx.broadcast('Send', (p) => ({ value: faction(ctx, p) } as BrbMsg));
        } else {
          s.note = `broadcasting ${cmd.value}`;
          ctx.log('state', `broadcasts ${cmd.value}`);
          ctx.broadcast('Send', () => ({ value: cmd.value } as BrbMsg));
        }
      }
    },

    onMessage(ctx, s, msg: Message) {
      const n = ctx.all.length;
      const f = faultBudget(n);
      const p = msg.payload as BrbMsg;

      if (s.byzantine) {
        byzantineAct(ctx, s); // any message tells a traitor the instance is live
        return;
      }

      switch (msg.type) {
        case 'Send': {
          if (msg.from !== s.sender || s.sawSend) return; // accept one SEND from the sender
          s.sawSend = true;
          if (s.echoSent == null) {
            s.echoSent = p.value;
            s.note = `ECHO(${p.value})`;
            ctx.broadcast('Echo', () => ({ value: p.value } as BrbMsg));
            addEcho(s, p.value, ctx.self); // count our own echo
            maybeReadyFromEchoes(ctx, s, p.value, n, f);
          }
          return;
        }
        case 'Echo': {
          addEcho(s, p.value, msg.from);
          maybeReadyFromEchoes(ctx, s, p.value, n, f);
          return;
        }
        case 'Ready': {
          addReady(s, p.value, msg.from);
          // Amplify: f+1 readies prove a correct node is ready.
          if (s.readySent == null && (s.readies[p.value]?.length ?? 0) >= readyAmplify(f)) goReady(ctx, s, p.value);
          maybeDeliver(ctx, s, p.value);
          return;
        }
      }
    },
  };
}
