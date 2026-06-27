import { useMemo } from 'react';
import type { TreeNode } from '../../engine/mcts';

interface Positioned {
  node: TreeNode;
  x: number; // column units
  y: number; // depth
}

// Lay the tree out tidily: every leaf gets its own column, every internal node sits above the mean
// of its children. A single DFS assigns columns left-to-right.
function layout(tree: TreeNode): { nodes: Positioned[]; cols: number; depth: number } {
  const nodes: Positioned[] = [];
  let col = 0;
  let maxDepth = 0;
  const place = (node: TreeNode, depth: number): number => {
    maxDepth = Math.max(maxDepth, depth);
    if (node.children.length === 0) {
      const x = col;
      col += 1;
      nodes.push({ node, x, y: depth });
      return x;
    }
    const xs = node.children.map((c) => place(c, depth + 1));
    const x = xs.reduce((a, b) => a + b, 0) / xs.length;
    nodes.push({ node, x, y: depth });
    return x;
  };
  place(tree, 0);
  return { nodes, cols: Math.max(1, col), depth: maxDepth };
}

export default function SearchTree({ tree, label }: { tree: TreeNode; label: (a: number) => string }) {
  const { nodes, cols, depth } = useMemo(() => layout(tree), [tree]);
  const rootN = tree.n || 1;

  const colW = 76;
  const rowH = 78;
  const padX = 44;
  const padY = 28;
  const W = (cols - 1) * colW + padX * 2;
  const H = depth * rowH + padY * 2;

  const px = (x: number) => padX + x * colW;
  const py = (y: number) => padY + y * rowH;

  const pos = new Map<TreeNode, Positioned>();
  for (const p of nodes) pos.set(p.node, p);

  const radius = (n: number) => 7 + 17 * Math.sqrt(n / rootN);
  const colorFor = (q: number) => {
    const g = Math.round(120 + 120 * Math.max(0, q));
    const r = Math.round(120 + 120 * Math.max(0, -q));
    return `rgb(${r}, ${g}, 90)`;
  };

  // Edges first (so nodes draw on top).
  const edges: React.ReactNode[] = [];
  for (const p of nodes) {
    for (const c of p.node.children) {
      const cp = pos.get(c)!;
      const share = c.n / Math.max(1, p.node.n);
      edges.push(
        <line
          key={`e${p.node.depth}-${p.x}-${cp.x}`}
          x1={px(p.x)}
          y1={py(p.y)}
          x2={px(cp.x)}
          y2={py(cp.y)}
          stroke="rgba(148,163,184,0.4)"
          strokeWidth={1 + 4 * share}
        />,
      );
    }
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', minWidth: Math.min(W, 520), height: 'auto' }}>
        {edges}
        {nodes.map((p) => {
          const isRoot = p.node.move < 0;
          const rr = isRoot ? 16 : radius(p.node.n);
          return (
            <g key={`n${p.node.depth}-${p.x}`}>
              <circle
                cx={px(p.x)}
                cy={py(p.y)}
                r={rr}
                fill={isRoot ? '#1e293b' : colorFor(p.node.q)}
                stroke={isRoot ? '#38bdf8' : 'rgba(226,232,240,0.45)'}
                strokeWidth={isRoot ? 2.5 : 1.2}
              />
              <text x={px(p.x)} y={py(p.y) + 3.5} textAnchor="middle" fontSize={10.5} fontWeight={600} fill="#0b1220">
                {isRoot ? 'now' : p.node.n}
              </text>
              {!isRoot && (
                <text x={px(p.x)} y={py(p.y) - rr - 4} textAnchor="middle" fontSize={10.5} fill="#cbd5e1">
                  {label(p.node.move)}
                </text>
              )}
              {!isRoot && (
                <text x={px(p.x)} y={py(p.y) + rr + 12} textAnchor="middle" fontSize={9.5} fill="#94a3b8">
                  {p.node.q >= 0 ? '+' : ''}
                  {p.node.q.toFixed(2)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
