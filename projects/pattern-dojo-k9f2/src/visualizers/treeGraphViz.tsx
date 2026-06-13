import { useMemo, useState } from "react";
import { StepperControls } from "../components/Stepper";
import { useStepper } from "../lib/useStepper";

/* ---------------- Tree traversal (DFS orders + BFS) ---------------- */

// fixed complete tree of 7 nodes
const TREE_VALUES = [1, 2, 3, 4, 5, 6, 7];
const TREE_POS = [
  { x: 250, y: 30 },
  { x: 130, y: 100 },
  { x: 370, y: 100 },
  { x: 70, y: 170 },
  { x: 190, y: 170 },
  { x: 310, y: 170 },
  { x: 430, y: 170 },
];
const left = (i: number) => 2 * i + 1;
const right = (i: number) => 2 * i + 2;

type Order = "preorder" | "inorder" | "postorder" | "bfs";

function traversalOrder(order: Order): number[] {
  const out: number[] = [];
  if (order === "bfs") {
    const q = [0];
    while (q.length) {
      const i = q.shift()!;
      out.push(i);
      if (left(i) < 7) q.push(left(i));
      if (right(i) < 7) q.push(right(i));
    }
    return out;
  }
  const dfs = (i: number) => {
    if (i >= 7) return;
    if (order === "preorder") out.push(i);
    dfs(left(i));
    if (order === "inorder") out.push(i);
    dfs(right(i));
    if (order === "postorder") out.push(i);
  };
  dfs(0);
  return out;
}

const ORDER_LABEL: Record<Order, string> = {
  preorder: "Pre-order (node → L → R)",
  inorder: "In-order (L → node → R)",
  postorder: "Post-order (L → R → node)",
  bfs: "BFS / Level-order (queue)",
};

export function TreeTraversalViz() {
  const [order, setOrder] = useState<Order>("preorder");
  const sequence = useMemo(() => traversalOrder(order), [order]);
  const stepper = useStepper(sequence.length + 1, { speed: 700 });
  // visited = first stepper.i nodes of sequence
  const visitedCount = stepper.i;
  const visited = sequence.slice(0, visitedCount);
  const active = visitedCount > 0 && visitedCount <= sequence.length ? sequence[visitedCount - 1] : -1;

  const caption =
    visitedCount === 0
      ? `${ORDER_LABEL[order]}. Press play to watch the visiting order.`
      : `Visited ${visitedCount}/${sequence.length}: [${visited.map((i) => TREE_VALUES[i]).join(", ")}]`;

  return (
    <div className="viz">
      <div className="viz-toggle">
        {(["preorder", "inorder", "postorder", "bfs"] as Order[]).map((o) => (
          <button
            key={o}
            className={order === o ? "active" : ""}
            onClick={() => {
              setOrder(o);
              stepper.reset();
            }}
          >
            {o}
          </button>
        ))}
      </div>
      <div className="viz-stage">
        <svg className="viz-svg" viewBox="0 0 500 210">
          {TREE_VALUES.map((_, i) => (
            <g key={`e${i}`}>
              {left(i) < 7 && <line className="edge-line tree" x1={TREE_POS[i].x} y1={TREE_POS[i].y} x2={TREE_POS[left(i)].x} y2={TREE_POS[left(i)].y} />}
              {right(i) < 7 && <line className="edge-line tree" x1={TREE_POS[i].x} y1={TREE_POS[i].y} x2={TREE_POS[right(i)].x} y2={TREE_POS[right(i)].y} />}
            </g>
          ))}
          {TREE_VALUES.map((v, i) => {
            const cls = ["node-circle", active === i ? "active" : visited.includes(i) ? "visited" : ""].filter(Boolean).join(" ");
            const orderInSeq = visited.indexOf(i);
            return (
              <g key={`n${i}`}>
                <circle className={cls} cx={TREE_POS[i].x} cy={TREE_POS[i].y} r={19} />
                <text className="node-text" x={TREE_POS[i].x} y={TREE_POS[i].y}>{v}</text>
                {orderInSeq >= 0 && (
                  <text x={TREE_POS[i].x + 17} y={TREE_POS[i].y - 15} fill="var(--accent)" fontSize="11" fontWeight="700">
                    {orderInSeq + 1}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <StepperControls stepper={stepper} caption={caption} />
    </div>
  );
}

/* ---------------- Graph BFS on a grid ---------------- */

// 0 = open, 1 = wall
const GRID = [
  [0, 0, 0, 1, 0],
  [1, 1, 0, 1, 0],
  [0, 0, 0, 0, 0],
  [0, 1, 1, 1, 0],
  [0, 0, 0, 0, 0],
];
const SRC: [number, number] = [0, 0];

interface GridFrame {
  dist: Map<string, number>;
  frontier: Set<string>;
  caption: string;
}

function key(r: number, c: number) {
  return `${r},${c}`;
}

function buildGridFrames(): GridFrame[] {
  const R = GRID.length;
  const C = GRID[0].length;
  const frames: GridFrame[] = [];
  const dist = new Map<string, number>();
  let level = [SRC];
  dist.set(key(...SRC), 0);
  let d = 0;
  frames.push({ dist: new Map(dist), frontier: new Set([key(...SRC)]), caption: `Start BFS from the source (top-left). Distance 0.` });
  while (level.length) {
    const next: [number, number][] = [];
    for (const [r, c] of level) {
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < R && nc >= 0 && nc < C && GRID[nr][nc] === 0 && !dist.has(key(nr, nc))) {
          dist.set(key(nr, nc), d + 1);
          next.push([nr, nc]);
        }
      }
    }
    if (next.length) {
      d++;
      frames.push({
        dist: new Map(dist),
        frontier: new Set(next.map(([r, c]) => key(r, c))),
        caption: `Ring ${d}: every newly reached cell is exactly ${d} step(s) from the source. BFS reaches each cell by the shortest path first.`,
      });
    }
    level = next;
  }
  frames.push({ dist: new Map(dist), frontier: new Set(), caption: `Done. Every reachable cell is labelled with its shortest hop-distance from the source.` });
  return frames;
}

export function GraphViz() {
  const frames = useMemo(() => buildGridFrames(), []);
  const stepper = useStepper(frames.length, { speed: 800 });
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="grid-board" style={{ gridTemplateColumns: `repeat(${GRID[0].length}, 1fr)` }}>
          {GRID.map((row, r) =>
            row.map((cell, c) => {
              const k = key(r, c);
              const isSrc = r === SRC[0] && c === SRC[1];
              const cls = [
                "grid-cell",
                cell === 1 ? "wall" : "",
                isSrc ? "src" : "",
                f.frontier.has(k) ? "frontier" : f.dist.has(k) ? "visited" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div key={k} className={cls}>
                  {cell === 1 ? "" : f.dist.has(k) ? f.dist.get(k) : ""}
                </div>
              );
            }),
          )}
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Trie insertion ---------------- */

interface TrieNode {
  ch: string;
  children: Record<string, TrieNode>;
  end: boolean;
  id: number;
}

const WORDS = ["cat", "car", "card", "dog"];

interface TrieFrame {
  // set of node ids that exist
  nodes: { id: number; ch: string; depth: number; parent: number; end: boolean }[];
  activeId: number;
  caption: string;
}

function buildTrieFrames(): TrieFrame[] {
  const frames: TrieFrame[] = [];
  let counter = 1;
  const root: TrieNode = { ch: "·", children: {}, end: false, id: 0 };

  const snapshot = (activeId: number, caption: string) => {
    const nodes: TrieFrame["nodes"] = [];
    const walk = (node: TrieNode, depth: number, parent: number) => {
      nodes.push({ id: node.id, ch: node.ch, depth, parent, end: node.end });
      for (const k of Object.keys(node.children).sort()) walk(node.children[k], depth + 1, node.id);
    };
    walk(root, 0, -1);
    frames.push({ nodes, activeId, caption });
  };

  snapshot(0, "Start with an empty root. Each word will branch off character by character.");
  for (const word of WORDS) {
    let node = root;
    for (const ch of word) {
      if (!node.children[ch]) {
        node.children[ch] = { ch, children: {}, end: false, id: counter++ };
        node = node.children[ch];
        snapshot(node.id, `Insert "${word}": '${ch}' is new → create a node.`);
      } else {
        node = node.children[ch];
        snapshot(node.id, `Insert "${word}": '${ch}' already exists → reuse the shared path (this is the prefix saving!).`);
      }
    }
    node.end = true;
    snapshot(node.id, `Mark end-of-word at "${word}". Searching "${word}" will now succeed.`);
  }
  return frames;
}

// layout: assign x by in-order leaf position, y by depth
function trieLayout(nodes: TrieFrame["nodes"]) {
  const W = 480;
  const maxDepth = Math.max(...nodes.map((n) => n.depth), 1);
  const H = 40 + maxDepth * 64;
  // group by depth and spread evenly within their parent ordering
  const byDepth: Record<number, typeof nodes> = {};
  for (const n of nodes) (byDepth[n.depth] ||= []).push(n);
  const pos: Record<number, { x: number; y: number }> = {};
  for (const dStr of Object.keys(byDepth)) {
    const d = Number(dStr);
    const row = byDepth[d];
    row.forEach((n, i) => {
      pos[n.id] = { x: (W * (i + 1)) / (row.length + 1), y: 26 + d * 64 };
    });
  }
  return { pos, W, H };
}

export function TrieViz() {
  const frames = useMemo(() => buildTrieFrames(), []);
  const stepper = useStepper(frames.length, { speed: 650 });
  const f = frames[stepper.i];
  const { pos, W, H } = trieLayout(f.nodes);

  return (
    <div className="viz">
      <div className="viz-stage">
        <svg className="viz-svg" viewBox={`0 0 ${W} ${H}`}>
          {f.nodes.map((n) =>
            n.parent >= 0 && pos[n.parent] ? (
              <line key={`e${n.id}`} className="edge-line tree" x1={pos[n.parent].x} y1={pos[n.parent].y} x2={pos[n.id].x} y2={pos[n.id].y} />
            ) : null,
          )}
          {f.nodes.map((n) => {
            const cls = ["node-circle", n.id === f.activeId ? "active" : n.id === 0 ? "" : "visited"].filter(Boolean).join(" ");
            return (
              <g key={`n${n.id}`}>
                <circle className={cls} cx={pos[n.id].x} cy={pos[n.id].y} r={16} />
                <text className="node-text" x={pos[n.id].x} y={pos[n.id].y} fontSize="13">{n.ch}</text>
                {n.end && <circle cx={pos[n.id].x} cy={pos[n.id].y} r={20} fill="none" stroke="var(--good)" strokeWidth={2} />}
              </g>
            );
          })}
        </svg>
        <div className="faint" style={{ fontSize: "0.74rem" }}>
          green ring = end of a word · words: {WORDS.join(", ")}
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}
