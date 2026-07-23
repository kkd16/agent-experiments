// A purpose-built visualisation of a Kademlia routing table as the binary trie
// of the id space — the canonical picture from the 2002 paper (Figure 1). Live
// node ids are the leaves of a compressed binary trie (each internal node splits
// on one bit, most-significant at the top). For the selected node, the trie is
// read as its routing table: the k-buckets are exactly the subtrees that branch
// *off* the path from the root down to the node — one bucket per bit. Each such
// subtree is shaded and labelled with its bucket index and how many of its nodes
// the selected node actually keeps as contacts (a bucket holds at most k of
// them). The current lookup's target is dropped into the trie along its own bit
// path, the probed contacts glow, and the resulting k-closest wear a ring — so
// you watch the search walk *down the tree toward the target*.
import { useMemo } from 'react';
import { toBits } from '../protocols/kademlia/xor';

export interface TrieNodeView {
  name: string;
  id: number;
  up: boolean;
  joined: boolean;
}

interface Props {
  m: number;
  nodes: TrieNodeView[];
  selected: string | null;
  onSelect: (name: string) => void;
  /** ids the selected node currently keeps as contacts (highlighted). */
  contacts: Set<number>;
  /** the current lookup, if any, for the animated overlay. */
  target: number | null;
  probed: Set<number>;
  result: Set<number>;
  height?: number;
}

type Trie =
  | { kind: 'leaf'; id: number }
  | { kind: 'internal'; bit: number; zero: Trie; one: Trie };

function buildTrie(ids: number[], hi: number): Trie {
  if (ids.length === 1) return { kind: 'leaf', id: ids[0] };
  for (let b = hi; b >= 0; b--) {
    const zero = ids.filter((id) => !((id >> b) & 1));
    const one = ids.filter((id) => (id >> b) & 1);
    if (zero.length && one.length) {
      return { kind: 'internal', bit: b, zero: buildTrie(zero, b - 1), one: buildTrie(one, b - 1) };
    }
  }
  return { kind: 'leaf', id: ids[0] };
}

const NODE_FILL = '#7c9cff';
const NODE_SEL = '#73e08a';
const NODE_DOWN = '#3a3f4b';
const CONTACT_RING = '#ffcf5d';

export function KademliaTree({ m, nodes, selected, onSelect, contacts, target, probed, result, height = 460 }: Props) {
  const W = 640;
  const marginX = 34;
  const topY = 40;
  const rowH = 46;

  const live = nodes.filter((n) => n.up && n.joined);

  const layout = useMemo(() => {
    const ids = live.map((n) => n.id).sort((a, b) => a - b);
    if (ids.length === 0) return null;
    const root = buildTrie(ids, m - 1);

    // In-order leaf order + structural depth of every node.
    const leafOrder: number[] = [];
    let maxDepth = 0;
    const depthOf = new Map<Trie, number>();
    const walk = (t: Trie, d: number) => {
      depthOf.set(t, d);
      maxDepth = Math.max(maxDepth, d);
      if (t.kind === 'leaf') leafOrder.push(t.id);
      else {
        walk(t.zero, d + 1);
        walk(t.one, d + 1);
      }
    };
    walk(root, 0);

    const n = leafOrder.length;
    const bottomY = topY + (maxDepth + 1) * rowH;
    const leafX = new Map<number, number>();
    leafOrder.forEach((id, i) => {
      const x = n === 1 ? W / 2 : marginX + ((W - 2 * marginX) * i) / (n - 1);
      leafX.set(id, x);
    });

    const xOf = (t: Trie): number => {
      if (t.kind === 'leaf') return leafX.get(t.id)!;
      return (xOf(t.zero) + xOf(t.one)) / 2;
    };
    const yOf = (t: Trie): number => (t.kind === 'leaf' ? bottomY : topY + depthOf.get(t)! * rowH);

    // leaf id → its full extent (for bucket shading)
    const extent = (t: Trie): { lo: number; hi: number } => {
      if (t.kind === 'leaf') {
        const x = leafX.get(t.id)!;
        return { lo: x, hi: x };
      }
      const a = extent(t.zero);
      const b = extent(t.one);
      return { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };
    };

    // Edges to draw.
    const edges: { x1: number; y1: number; x2: number; y2: number; bit: number }[] = [];
    const collectEdges = (t: Trie) => {
      if (t.kind === 'internal') {
        for (const child of [t.zero, t.one]) {
          edges.push({ x1: xOf(t), y1: yOf(t), x2: xOf(child), y2: yOf(child), bit: t.bit });
          collectEdges(child);
        }
      }
    };
    collectEdges(root);

    // Bucket subtrees for the selected node: walk root→selected leaf, each
    // sibling subtree is one bucket (index = the split bit at that node).
    const selId = selected ? nodes.find((x) => x.name === selected)?.id ?? null : null;
    const buckets: { bit: number; lo: number; hi: number; yTop: number; ids: number[] }[] = [];
    if (selId !== null && leafX.has(selId)) {
      const collectIds = (t: Trie): number[] => (t.kind === 'leaf' ? [t.id] : [...collectIds(t.zero), ...collectIds(t.one)]);
      let cur: Trie = root;
      while (cur.kind === 'internal') {
        const goOne = (selId >> cur.bit) & 1;
        const sib = goOne ? cur.zero : cur.one;
        const ex = extent(sib);
        buckets.push({ bit: cur.bit, lo: ex.lo, hi: ex.hi, yTop: topY + depthOf.get(cur)! * rowH, ids: collectIds(sib) });
        cur = goOne ? cur.one : cur.zero;
      }
    }

    // Target marker: descend the trie along the target's bits until we fall off.
    let targetX: number | null = null;
    let targetY: number | null = null;
    if (target !== null) {
      let cur: Trie = root;
      while (cur.kind === 'internal') {
        const one = (target >> cur.bit) & 1;
        const next = one ? cur.one : cur.zero;
        // does `next` still match the target's bits down to its split? we just follow.
        cur = next;
      }
      targetX = leafX.get(cur.id)!;
      targetY = bottomY;
    }

    const leaves = leafOrder.map((id) => ({ id, x: leafX.get(id)!, y: bottomY }));
    return { edges, leaves, buckets, bottomY, targetX, targetY, selId };
  }, [live, m, nodes, selected, target]);

  const H = layout ? Math.max(height, layout.bottomY + 44) : height;

  return (
    <svg className="kad-tree" viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxHeight: H }}>
      <rect x={0} y={0} width={W} height={H} fill="transparent" />
      {!layout && (
        <text x={W / 2} y={H / 2} textAnchor="middle" fill="#5b6472" fontSize={13}>
          waiting for nodes to join the DHT…
        </text>
      )}
      {layout && (
        <>
          {/* bucket subtrees (shaded regions) for the selected node */}
          {layout.buckets.map((b, i) => {
            const hue = (b.bit * 40 + 200) % 360;
            const pad = 15;
            const known = b.ids.filter((id) => contacts.has(id)).length;
            return (
              <g key={`bk${i}`}>
                <rect
                  x={b.lo - pad}
                  y={b.yTop - 6}
                  width={b.hi - b.lo + pad * 2}
                  height={layout.bottomY - b.yTop + 24}
                  rx={9}
                  fill={`hsl(${hue} 70% 60% / 0.10)`}
                  stroke={`hsl(${hue} 70% 65% / 0.45)`}
                  strokeDasharray="3 3"
                />
                <text x={(b.lo + b.hi) / 2} y={b.yTop - 11} textAnchor="middle" fontSize={10.5} fill={`hsl(${hue} 70% 72%)`}>
                  bucket {b.bit} · {known}/{b.ids.length}
                </text>
              </g>
            );
          })}

          {/* trie edges */}
          {layout.edges.map((e, i) => (
            <line key={`e${i}`} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} stroke="#2f3540" strokeWidth={1.6} />
          ))}

          {/* target marker */}
          {layout.targetX !== null && layout.targetY !== null && (
            <g>
              <line x1={layout.targetX} y1={topY - 22} x2={layout.targetX} y2={layout.targetY} stroke="#ff6b8b" strokeWidth={1.2} strokeDasharray="2 3" />
              <polygon
                points={`${layout.targetX},${topY - 26} ${layout.targetX - 6},${topY - 34} ${layout.targetX + 6},${topY - 34}`}
                fill="#ff6b8b"
              />
              <text x={layout.targetX} y={topY - 38} textAnchor="middle" fontSize={10.5} fill="#ff8fa6">
                target {target}
              </text>
            </g>
          )}

          {/* leaves = nodes */}
          {layout.leaves.map((lf) => {
            const nd = nodes.find((x) => x.id === lf.id)!;
            const isSel = layout.selId === lf.id;
            const isContact = contacts.has(lf.id);
            const isProbed = probed.has(lf.id);
            const isResult = result.has(lf.id);
            const fill = !nd.up || !nd.joined ? NODE_DOWN : isSel ? NODE_SEL : NODE_FILL;
            return (
              <g key={`lf${lf.id}`} className="kad-leaf" onClick={() => onSelect(nd.name)} style={{ cursor: 'pointer' }}>
                {isResult && <circle cx={lf.x} cy={lf.y} r={17} fill="none" stroke="#73e08a" strokeWidth={2} />}
                {isProbed && <circle cx={lf.x} cy={lf.y} r={20} fill="none" stroke="#ff8fa6" strokeWidth={1} strokeDasharray="2 2" />}
                <circle cx={lf.x} cy={lf.y} r={12} fill={fill} stroke={isContact ? CONTACT_RING : '#11151c'} strokeWidth={isContact ? 2.5 : 1.5} />
                <text x={lf.x} y={lf.y + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={!nd.up ? '#6b7280' : '#0d1117'}>
                  {nd.name}
                </text>
                <text x={lf.x} y={lf.y + 28} textAnchor="middle" fontSize={9} fill="#7b8494" fontFamily="ui-monospace, monospace">
                  {toBits(lf.id, m)}
                </text>
                <text x={lf.x} y={lf.y + 39} textAnchor="middle" fontSize={8.5} fill="#5b6472">
                  {lf.id}
                </text>
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}
