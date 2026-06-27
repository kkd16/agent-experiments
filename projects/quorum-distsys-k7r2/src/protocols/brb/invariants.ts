// Bracha reliable-broadcast invariants — the live Byzantine-safety proof.
//
//   1. Agreement — no two correct nodes deliver different values. This is the
//      defining property of reliable broadcast and the thing an equivocating
//      sender tries to break; it holds because the echo quorum > (N+f)/2 can be
//      met by at most one value. Push the traitors past f = ⌊(N-1)/3⌋ and it can
//      fail — exactly the 3f+1 bound, made visible.
//   2. Justified delivery — a correct node that delivered v has actually collected
//      2f+1 READY(v) messages. The quorum witness behind every delivery.
import type { InvariantResult, NodeView } from '../../sim/types';
import { faultBudget, readyDeliver, type BrbState, type Value } from './types';

type View = NodeView<BrbState>;

const correct = (views: ReadonlyArray<View>) => views.filter((v) => !v.state.byzantine);

export function brbInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];
  const n = views.length;
  const f = faultBudget(n);
  const byz = views.filter((v) => v.state.byzantine).length;

  // 1. AGREEMENT
  {
    const delivered = correct(views).filter((v) => v.state.delivered != null).map((v) => v.state.delivered as Value);
    const distinct = new Set(delivered);
    const ok = distinct.size <= 1;
    out.push({
      name: 'Agreement',
      ok,
      detail: ok
        ? delivered.length === 0
          ? `no correct node has delivered yet (tolerating f=${f}, ${byz} Byzantine)`
          : `all ${delivered.length} delivering correct nodes agree on “${[...distinct][0]}”`
        : `correct nodes delivered DIFFERENT values {${[...distinct].join(', ')}} — broadcast split (${byz} Byzantine > f=${f})`,
    });
  }

  // 2. JUSTIFIED DELIVERY
  {
    let bad = '';
    for (const v of correct(views)) {
      const d = v.state.delivered;
      if (d == null) continue;
      const readies = v.state.readies[d]?.length ?? 0;
      if (readies < readyDeliver(f)) {
        bad = `${v.id} delivered “${d}” with only ${readies} READY (need ${readyDeliver(f)} = 2f+1)`;
        break;
      }
    }
    out.push({
      name: 'Justified delivery',
      ok: !bad,
      detail: bad || `every delivery is backed by 2f+1 = ${readyDeliver(f)} READY messages`,
    });
  }

  return out;
}

export interface BrbGauge {
  n: number;
  f: number;
  byzantine: number;
  delivered: number;
  correctTotal: number;
  value: Value | null;
  /** Totality reached: every correct node delivered the same value. */
  totality: boolean;
  withinBudget: boolean;
}

export function brbGauge(views: ReadonlyArray<View>): BrbGauge {
  const n = views.length;
  const f = faultBudget(n);
  const byz = views.filter((v) => v.state.byzantine).length;
  const cor = correct(views);
  const delivered = cor.filter((v) => v.state.delivered != null);
  const distinct = new Set(delivered.map((v) => v.state.delivered));
  return {
    n,
    f,
    byzantine: byz,
    delivered: delivered.length,
    correctTotal: cor.length,
    value: distinct.size === 1 ? (delivered[0].state.delivered as Value) : null,
    totality: delivered.length === cor.length && distinct.size === 1,
    withinBudget: byz <= f,
  };
}
