// Snow* invariants — the *probabilistic*-safety panel.
//
// Unlike the quorum protocols, Snow* does not reach absolute safety: with sane
// k/α/β and an honest majority, two honest nodes finalise different colours only
// with vanishing probability. So the panel watches the properties that must hold
// every single time the protocol is *correct*, and would flip red the instant
// random subsampling ever betrayed us:
//
//   1. Agreement — no two finalised *honest* nodes hold different colours. This is
//      the headline metastable-safety property (it holds w.h.p., and is exactly
//      what would break if α/β were set too weak or Byzantine power too high).
//   2. Finality is irrevocable — a finalised honest node's preference still equals
//      its decision; it has stopped moving. (Catches any bug that let a decided
//      node drift.)
//   3. Validity — every colour in the system is a legal one, and no node finalised
//      ⊥. A colour can only ever enter the cluster through a client `seed`
//      (bootstrapping merely *copies* an existing colour, and a round only adopts
//      a colour it actually *saw*), so a real palette colour everywhere is exactly
//      "nothing was conjured from nowhere".
//
// Liveness (does the network actually converge?) is *not* safety — it needs a
// connected, mostly-honest network — so it is surfaced separately as a gauge.
import type { InvariantResult, NodeView } from '../../sim/types';
import { COLOURS, colourStr, type Colour, type SnowState } from './types';

type View = NodeView<SnowState>;

/** Honest nodes only — a Byzantine node is, by definition, allowed to lie. */
function honest(views: ReadonlyArray<View>): View[] {
  return views.filter((v) => !v.state.byzantine);
}

export function snowInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];
  const hon = honest(views);
  const palette = new Set<Colour>(COLOURS);

  // 1. AGREEMENT — no two finalised honest nodes disagree.
  {
    const decided = hon.filter((v) => v.state.decided != null);
    const colours = new Set(decided.map((v) => v.state.decided as Colour));
    const ok = colours.size <= 1;
    out.push({
      name: 'Agreement (w.h.p.)',
      ok,
      detail: ok
        ? decided.length === 0
          ? 'no node has finalised yet — nothing to disagree on'
          : `all ${decided.length} finalised node${decided.length === 1 ? '' : 's'} agree on ${colourStr([...colours][0])}`
        : `two honest nodes finalised different colours: {${[...colours].map(colourStr).join(', ')}} — random sampling produced a split decision`,
    });
  }

  // 2. FINALITY IS IRREVOCABLE — a decided honest node's pref == its decision.
  {
    let bad = '';
    for (const v of hon) {
      const s = v.state;
      if (s.decided != null && s.pref !== s.decided) {
        bad = `${v.id} finalised ${colourStr(s.decided)} but now prefers ${colourStr(s.pref)}`;
        break;
      }
    }
    out.push({
      name: 'Finality is irrevocable',
      ok: !bad,
      detail: bad || 'every finalised node still holds exactly the colour it decided — a decision never reverts',
    });
  }

  // 3. VALIDITY — only legal colours exist; no ⊥ was finalised.
  {
    let bad = '';
    for (const v of hon) {
      const s = v.state;
      if (s.pref != null && !palette.has(s.pref)) {
        bad = `${v.id} prefers an unknown colour "${s.pref}"`;
        break;
      }
      if (s.decided === null) continue;
      if (!palette.has(s.decided)) {
        bad = `${v.id} finalised an unknown colour "${s.decided}"`;
        break;
      }
    }
    out.push({
      name: 'Validity',
      ok: !bad,
      detail: bad || 'every colour traces back to a client seed — nothing was conjured (no node finalised ⊥)',
    });
  }

  return out;
}

export interface SnowGauge {
  finalised: number;
  liveHonest: number;
  /** The plurality colour among live honest preferences, and how many back it. */
  plurality: Colour | null;
  pluralityCount: number;
  /** Whether every live honest node shares one (non-⊥) preference. */
  unanimous: boolean;
}

/** Liveness/convergence at a glance (NOT a safety invariant). */
export function snowGauge(views: ReadonlyArray<View>): SnowGauge {
  const live = views.filter((v) => v.up && !v.state.byzantine);
  const counts = new Map<Colour, number>();
  for (const v of live) {
    const c = v.state.pref;
    if (c == null) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let plurality: Colour | null = null;
  let pluralityCount = 0;
  for (const [c, n] of counts) {
    if (n > pluralityCount) {
      plurality = c;
      pluralityCount = n;
    }
  }
  const finalised = live.filter((v) => v.state.decided != null).length;
  const unanimous = live.length > 0 && pluralityCount === live.length;
  return { finalised, liveHonest: live.length, plurality, pluralityCount, unanimous };
}
