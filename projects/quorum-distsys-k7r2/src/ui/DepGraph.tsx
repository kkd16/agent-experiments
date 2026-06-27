// The signature EPaxos picture: one replica's **dependency graph**.
//
// Each command lives at a node placed by its owner (column) and instance index
// (row). An arrow γ→δ means "γ depends on δ" (δ ∈ γ.deps) — δ must execute
// first. Nodes are tinted by how far agreement has carried them
// (pre-accepted → accepted → committed → executed), executed nodes carry their
// execution-order number, and any **dependency cycle** (a strongly-connected
// component, which EPaxos breaks by sequence number) is boxed in gold. Watching
// commands fill in and the cycles resolve *is* the protocol.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Instance, Status } from '../protocols/epaxos/types';
import { cmdStr } from '../protocols/epaxos/types';

interface Props {
  inst: Record<string, Instance>;
  owners: string[];
  executedOrder: string[];
  selected: string | null;
  onSelect: (key: string) => void;
  height?: number;
  /** How many recent instances per owner to show. */
  window?: number;
}

const STATUS_COLOR: Record<Status, string> = {
  preaccepted: '#6b7488',
  accepted: '#b08bff',
  committed: '#7c9cff',
  executed: '#73e08a',
};

/** Tarjan SCCs over the committed/executed sub-graph (for drawing cycle boxes). */
function sccs(inst: Record<string, Instance>, keys: Set<string>): string[][] {
  let counter = 0;
  const idx: Record<string, number> = {};
  const low: Record<string, number> = {};
  const onStack: Record<string, boolean> = {};
  const stack: string[] = [];
  const out: string[][] = [];
  const decided = (k: string) => keys.has(k);
  const connect = (v: string): void => {
    idx[v] = low[v] = counter++;
    stack.push(v);
    onStack[v] = true;
    for (const w of inst[v]?.deps ?? []) {
      if (!decided(w)) continue;
      if (idx[w] === undefined) {
        connect(w);
        low[v] = Math.min(low[v], low[w]);
      } else if (onStack[w]) {
        low[v] = Math.min(low[v], idx[w]);
      }
    }
    if (low[v] === idx[v]) {
      const comp: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack[w] = false;
        comp.push(w);
        if (w === v) break;
      }
      out.push(comp);
    }
  };
  for (const k of keys) if (idx[k] === undefined) connect(k);
  return out;
}

export function DepGraph({ inst, owners, executedOrder, selected, onSelect, height = 360, window: win = 7 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(640);
  const posRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(320, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const execPos = useCallback(
    (key: string) => {
      const i = executedOrder.indexOf(key);
      return i < 0 ? null : i + 1;
    },
    [executedOrder],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Window: the last `win` instances per owner.
    const byOwner = new Map<string, Instance[]>();
    for (const k of Object.keys(inst)) {
      const it = inst[k];
      if (!byOwner.has(it.owner)) byOwner.set(it.owner, []);
      byOwner.get(it.owner)!.push(it);
    }
    const visible = new Set<string>();
    const rowOf = new Map<string, number>();
    for (const o of owners) {
      const list = (byOwner.get(o) ?? []).sort((a, b) => a.index - b.index);
      const tail = list.slice(Math.max(0, list.length - win));
      tail.forEach((it, r) => {
        const key = `${it.owner}.${it.index}`;
        visible.add(key);
        rowOf.set(key, r);
      });
    }

    const colW = owners.length > 0 ? Math.min(150, (width - 40) / owners.length) : 100;
    const x0 = (width - colW * owners.length) / 2 + colW / 2;
    const rowH = Math.min(46, (height - 56) / Math.max(win, 1));
    const y0 = 40;
    const pos = new Map<string, { x: number; y: number }>();
    for (const key of visible) {
      const it = inst[key];
      const col = owners.indexOf(it.owner);
      const row = rowOf.get(key)!;
      pos.set(key, { x: x0 + col * colW, y: y0 + row * rowH });
    }
    posRef.current = pos;
    const R = Math.min(17, rowH / 2 - 3);

    // owner column headers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px ui-monospace, monospace';
    owners.forEach((o, c) => {
      ctx.fillStyle = '#8b94a7';
      ctx.fillText(o, x0 + c * colW, 18);
    });

    // dependency edges (only when both endpoints are visible)
    for (const key of visible) {
      const a = pos.get(key)!;
      for (const d of inst[key].deps) {
        const b = pos.get(d);
        if (!b) continue;
        ctx.strokeStyle = 'rgba(150,160,180,0.28)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        // gentle curve so multiple edges are distinguishable
        const mx = (a.x + b.x) / 2 + (a.y < b.y ? 10 : -10);
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(mx, (a.y + b.y) / 2, b.x, b.y);
        ctx.stroke();
        // arrowhead at b
        const ang = Math.atan2(b.y - (a.y + b.y) / 2, b.x - mx);
        ctx.fillStyle = 'rgba(150,160,180,0.5)';
        ctx.beginPath();
        ctx.moveTo(b.x - Math.cos(ang) * (R + 1), b.y - Math.sin(ang) * (R + 1));
        ctx.lineTo(b.x - Math.cos(ang) * (R + 8) - Math.sin(ang) * 4, b.y - Math.sin(ang) * (R + 8) + Math.cos(ang) * 4);
        ctx.lineTo(b.x - Math.cos(ang) * (R + 8) + Math.sin(ang) * 4, b.y - Math.sin(ang) * (R + 8) - Math.cos(ang) * 4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // SCC cycle boxes (over committed/executed visible nodes)
    const decidedVisible = new Set<string>();
    for (const key of visible) {
      const st = inst[key].status;
      if (st === 'committed' || st === 'executed') decidedVisible.add(key);
    }
    for (const comp of sccs(inst, decidedVisible)) {
      if (comp.length < 2) continue;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const k of comp) {
        const p = pos.get(k);
        if (!p) continue;
        minx = Math.min(minx, p.x);
        miny = Math.min(miny, p.y);
        maxx = Math.max(maxx, p.x);
        maxy = Math.max(maxy, p.y);
      }
      if (!isFinite(minx)) continue;
      ctx.strokeStyle = 'rgba(255,196,84,0.8)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(minx - R - 6, miny - R - 6, maxx - minx + 2 * R + 12, maxy - miny + 2 * R + 12);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,196,84,0.9)';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'left';
      ctx.fillText('cycle → seq order', minx - R - 4, miny - R - 11);
    }

    // nodes
    for (const key of visible) {
      const p = pos.get(key)!;
      const it = inst[key];
      const col = STATUS_COLOR[it.status];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = it.status === 'preaccepted' ? '#262a34' : col;
      ctx.fill();
      ctx.lineWidth = selected === key ? 3 : 1.5;
      ctx.strokeStyle = selected === key ? '#fff' : col;
      ctx.stroke();

      ctx.fillStyle = it.status === 'preaccepted' ? '#aab2c2' : '#0b0c10';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 9px ui-monospace, monospace';
      ctx.fillText(String(it.index), p.x, p.y);

      // command label under the node
      ctx.fillStyle = '#8b94a7';
      ctx.font = '600 8px ui-monospace, monospace';
      ctx.fillText(cmdStr(it.cmd).slice(0, 9), p.x, p.y + R + 7);

      // execution-order badge
      const ep = execPos(key);
      if (ep !== null) {
        ctx.beginPath();
        ctx.arc(p.x + R - 1, p.y - R + 1, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#0b0c10';
        ctx.fill();
        ctx.strokeStyle = '#73e08a';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.fillStyle = '#9ff0b6';
        ctx.font = '700 8px ui-monospace, monospace';
        ctx.fillText(String(ep), p.x + R - 1, p.y - R + 1.5);
      }
    }
  }, [inst, owners, width, height, win, selected, execPos]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: { k: string; d: number } | null = null;
    for (const [k, p] of posRef.current) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 20 && (!best || d < best.d)) best = { k, d };
    }
    if (best) onSelect(best.k);
  };

  return (
    <div ref={wrapRef} className="netcanvas-wrap" style={{ height }}>
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        style={{ width: '100%', height: '100%', cursor: 'pointer', display: 'block' }}
      />
    </div>
  );
}
