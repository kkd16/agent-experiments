// A canvas view of the cluster: nodes on a ring, links (cut links dashed red),
// and every in-flight message animated along its edge from sender to receiver.
// Clicking a node selects it; clicking the midpoint of a link cuts/heals it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NodeId, NodeRuntime, SimSnapshot } from '../sim/types';
import { linkKey } from '../sim/network';
import { clamp } from '../lib/format';

export interface NodeVisual {
  fill: string;
  ring?: string;
  label: string;
  sub?: string;
  badge?: string;
  glow?: boolean;
  down?: boolean;
}

interface Props<S> {
  snapshot: SimSnapshot<S>;
  nodeOrder: NodeId[];
  visual: (node: NodeRuntime<S>, index: number) => NodeVisual;
  messageColor?: (type: string) => string;
  messageGlyph?: (type: string) => string;
  selected?: NodeId | null;
  onSelect?: (id: NodeId) => void;
  onToggleLink?: (a: NodeId, b: NodeId) => void;
  height?: number;
}

function msgColorDefault(type: string): string {
  if (type.startsWith('RequestVote')) return '#b08bff';
  if (type.startsWith('AppendEntries')) return '#7c9cff';
  if (type.includes('Resp') || type.includes('Ack') || type.includes('Vote')) return '#8be9c0';
  if (type.includes('ping') || type.includes('Ping')) return '#ffd479';
  return '#9aa2b1';
}

export function NetworkCanvas<S>({
  snapshot,
  nodeOrder,
  visual,
  messageColor = msgColorDefault,
  messageGlyph,
  selected,
  onSelect,
  onToggleLink,
  height = 420,
}: Props<S>) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(280, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Geometry shared between drawing and hit-testing.
  const layout = useCallback(() => {
    const n = nodeOrder.length;
    const cx = width / 2;
    const cy = height / 2;
    const R = Math.min(width, height) / 2 - 64;
    const pos = new Map<NodeId, { x: number; y: number }>();
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      pos.set(nodeOrder[i], { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
    }
    return pos;
  }, [nodeOrder, width, height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const pos = layout();
    const blocked = new Set(snapshot.blockedLinks);
    const nodeIndex = new Map(nodeOrder.map((id, i) => [id, i] as const));

    // links
    for (let i = 0; i < nodeOrder.length; i++) {
      for (let j = i + 1; j < nodeOrder.length; j++) {
        const a = pos.get(nodeOrder[i])!;
        const b = pos.get(nodeOrder[j])!;
        const cut = blocked.has(linkKey(nodeOrder[i], nodeOrder[j]));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        if (cut) {
          ctx.strokeStyle = 'rgba(255,90,108,0.55)';
          ctx.setLineDash([5, 6]);
          ctx.lineWidth = 1.5;
        } else {
          ctx.strokeStyle = 'rgba(120,130,150,0.13)';
          ctx.setLineDash([]);
          ctx.lineWidth = 1;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // in-flight messages
    for (const m of snapshot.inFlight) {
      const a = pos.get(m.from);
      const b = pos.get(m.to);
      if (!a || !b) continue;
      const span = m.deliverAt - m.sentAt || 1;
      const p = clamp((snapshot.time - m.sentAt) / span, 0, 1);
      // perpendicular offset so the two directions don't overlap
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const dir = m.from < m.to ? 1 : -1;
      const ox = (-dy / len) * 7 * dir;
      const oy = (dx / len) * 7 * dir;
      const x = a.x + dx * p + ox;
      const y = a.y + dy * p + oy;
      const col = messageColor(m.type);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      if (messageGlyph) {
        ctx.fillStyle = '#0b0c10';
        ctx.font = '700 7px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(messageGlyph(m.type), x, y + 0.5);
      }
    }

    // nodes
    for (const node of snapshot.nodes) {
      const p = pos.get(node.id);
      if (!p) continue;
      const i = nodeIndex.get(node.id) ?? 0;
      const v = visual(node, i);
      const r = 26;
      if (v.glow && !v.down) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
        ctx.fillStyle = v.fill;
        ctx.globalAlpha = 0.18;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = v.down ? '#23252e' : v.fill;
      ctx.fill();
      ctx.lineWidth = selected === node.id ? 3.5 : 2;
      ctx.strokeStyle = selected === node.id ? '#fff' : v.ring ?? 'rgba(0,0,0,0.35)';
      ctx.stroke();
      if (v.down) {
        ctx.strokeStyle = '#ff5d6c';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p.x - 11, p.y - 11);
        ctx.lineTo(p.x + 11, p.y + 11);
        ctx.moveTo(p.x + 11, p.y - 11);
        ctx.lineTo(p.x - 11, p.y + 11);
        ctx.stroke();
      }

      ctx.fillStyle = v.down ? '#9aa2b1' : '#0b0c10';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 13px ui-monospace, monospace';
      ctx.fillText(v.label, p.x, p.y - 4);
      if (v.sub) {
        ctx.font = '600 9px ui-monospace, monospace';
        ctx.fillText(v.sub, p.x, p.y + 9);
      }
      if (v.badge) {
        ctx.beginPath();
        ctx.arc(p.x + r - 2, p.y - r + 2, 9, 0, Math.PI * 2);
        ctx.fillStyle = '#0b0c10';
        ctx.fill();
        ctx.strokeStyle = v.fill;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#e8eaf0';
        ctx.font = '700 9px ui-monospace, monospace';
        ctx.fillText(v.badge, p.x + r - 2, p.y - r + 3);
      }
    }
  }, [snapshot, width, height, nodeOrder, visual, messageColor, messageGlyph, selected, layout]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pos = layout();
    // nodes first
    for (const id of nodeOrder) {
      const p = pos.get(id)!;
      if (Math.hypot(p.x - x, p.y - y) <= 28) {
        onSelect?.(id);
        return;
      }
    }
    // then link midpoints
    if (onToggleLink) {
      let best: { a: NodeId; b: NodeId; d: number } | null = null;
      for (let i = 0; i < nodeOrder.length; i++) {
        for (let j = i + 1; j < nodeOrder.length; j++) {
          const a = pos.get(nodeOrder[i])!;
          const b = pos.get(nodeOrder[j])!;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const d = Math.hypot(mx - x, my - y);
          if (d < 16 && (!best || d < best.d)) best = { a: nodeOrder[i], b: nodeOrder[j], d };
        }
      }
      if (best) onToggleLink(best.a, best.b);
    }
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
