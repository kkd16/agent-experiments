import { useMemo } from 'react';
import type { IRFunc } from '../compiler/ir/ir';
import { cfgModel } from '../compiler/pipeline';
import { fmtInst, fmtPhi, fmtTerm } from '../compiler/irdump';

// An SVG control-flow graph. Blocks are stacked in reverse-postorder; edges are
// colored by kind (true / false / back) and curved through side gutters. Each
// block header shows its immediate dominator and flags loop headers.

const BOX_W = 360;
const GUT_L = 70;
const GUT_R = 90;
const LH = 15;
const PAD = 8;
const HEADER = 20;
const GAP = 26;
const MAXCH = 48;

const clip = (s: string) => (s.length > MAXCH ? s.slice(0, MAXCH - 1) + '…' : s);

export default function CfgView({ fn }: { fn: IRFunc }) {
  const model = useMemo(() => cfgModel(fn), [fn]);
  const byId = useMemo(() => new Map(fn.blocks.map((b) => [b.id, b])), [fn]);

  const layout = useMemo(() => {
    const boxes = new Map<number, { x: number; y: number; h: number; lines: { t: string; c: string }[] }>();
    let y = 20;
    for (const id of model.blocks) {
      const b = byId.get(id);
      if (!b) continue;
      const lines: { t: string; c: string }[] = [];
      for (const p of b.phis) lines.push({ t: clip(fmtPhi(p)), c: 'phi' });
      for (const ins of b.insts) lines.push({ t: clip(fmtInst(ins)), c: 'ins' });
      lines.push({ t: clip(fmtTerm(b.term)), c: 'term' });
      const h = HEADER + lines.length * LH + PAD;
      boxes.set(id, { x: GUT_L, y, h, lines });
      y += h + GAP;
    }
    return { boxes, height: y };
  }, [model, byId]);

  const color = (k: string) => (k === 'true' ? '#46c46a' : k === 'false' ? '#e0654f' : k === 'back' ? '#b07bdc' : '#6b7785');

  const edges = model.edges.map((e, i) => {
    const a = layout.boxes.get(e.from);
    const b = layout.boxes.get(e.to);
    if (!a || !b) return null;
    const sx = a.x + (e.kind === 'true' ? BOX_W * 0.32 : e.kind === 'false' ? BOX_W * 0.68 : BOX_W * 0.5);
    const sy = a.y + a.h;
    const back = e.kind === 'back';
    const tx = back ? b.x + BOX_W : b.x + BOX_W * 0.5;
    const ty = back ? b.y + b.h / 2 : b.y;
    const bow = back ? GUT_R - 10 : -(GUT_L - 18);
    const path = back
      ? `M ${a.x + BOX_W} ${a.y + a.h / 2} C ${a.x + BOX_W + bow} ${a.y + a.h / 2} ${tx + bow} ${ty} ${tx} ${ty}`
      : `M ${sx} ${sy} C ${sx + bow} ${sy + 30} ${tx + bow} ${ty - 30} ${tx} ${ty}`;
    return (
      <path key={i} d={path} fill="none" stroke={color(e.kind)} strokeWidth={1.6}
        strokeDasharray={back ? '5 3' : undefined} markerEnd={`url(#arrow-${e.kind})`} opacity={0.9} />
    );
  });

  const width = GUT_L + BOX_W + GUT_R;
  return (
    <div className="cfg-scroll">
      <svg width={width} height={layout.height} className="cfg-svg">
        <defs>
          {['normal', 'true', 'false', 'back'].map((k) => (
            <marker key={k} id={`arrow-${k}`} markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill={color(k)} />
            </marker>
          ))}
        </defs>
        {edges}
        {model.blocks.map((id) => {
          const box = layout.boxes.get(id);
          const b = byId.get(id);
          if (!box || !b) return null;
          const isHeader = model.loopHeaders.has(id);
          const idom = model.idom.get(id);
          return (
            <g key={id}>
              <rect x={box.x} y={box.y} width={BOX_W} height={box.h} rx={6}
                className={'cfg-box' + (isHeader ? ' cfg-loop' : '')} />
              <text x={box.x + 10} y={box.y + 14} className="cfg-bid">
                b{id}
                {isHeader ? '  ⟲ loop header' : ''}
                {idom !== undefined ? `   idom=b${idom}` : '   entry'}
              </text>
              {box.lines.map((ln, j) => (
                <text key={j} x={box.x + 12} y={box.y + HEADER + 12 + j * LH} className={'cfg-line cfg-' + ln.c}>
                  {ln.t}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
