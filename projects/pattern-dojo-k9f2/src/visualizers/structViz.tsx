import { useMemo } from "react";
import { StepperControls } from "../components/Stepper";
import { useStepper } from "../lib/useStepper";

/* ---------------- Stack: Next Greater Element (monotonic) ---------------- */

interface StackFrame {
  active: number;
  stack: number[]; // indices
  result: (number | null)[];
  caption: string;
}

function buildStackFrames(nums: number[]): StackFrame[] {
  const frames: StackFrame[] = [];
  const stack: number[] = [];
  const result: (number | null)[] = nums.map(() => null);
  for (let i = 0; i < nums.length; i++) {
    while (stack.length && nums[stack[stack.length - 1]] < nums[i]) {
      const idx = stack.pop()!;
      result[idx] = nums[i];
      frames.push({
        active: i,
        stack: [...stack],
        result: [...result],
        caption: `${nums[i]} > ${nums[idx]} (waiting at index ${idx}) → ${nums[i]} is its next-greater. Pop it.`,
      });
    }
    stack.push(i);
    frames.push({
      active: i,
      stack: [...stack],
      result: [...result],
      caption: `${nums[i]} has no bigger element to resolve right now → push index ${i} and wait.`,
    });
  }
  if (stack.length) {
    frames.push({
      active: -1,
      stack: [...stack],
      result: [...result],
      caption: `Loop ends. Indices still on the stack never found a greater element → they stay -1.`,
    });
  }
  return frames;
}

export function StackViz() {
  const nums = useMemo(() => [2, 1, 5, 6, 2, 3], []);
  const frames = useMemo(() => buildStackFrames(nums), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const cls = ["cell", idx === f.active ? "active" : "", f.stack.includes(idx) ? "in-window" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={idx} className={cls}>
                <span className="idx">{idx}</span>
                {v}
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 30, alignItems: "flex-end", flexWrap: "wrap", justifyContent: "center" }}>
          <div style={{ textAlign: "center" }}>
            <div className="faint" style={{ fontSize: "0.74rem", marginBottom: 6 }}>stack (indices)</div>
            <div className="stack-col">
              {f.stack.length === 0 && <span className="faint">empty</span>}
              {f.stack.map((idx, k) => (
                <div key={idx} className={`stack-item ${k === f.stack.length - 1 ? "top" : ""}`}>
                  {idx}:{nums[idx]}
                </div>
              ))}
            </div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div className="faint" style={{ fontSize: "0.74rem", marginBottom: 6 }}>next-greater result</div>
            <div className="cells">
              {f.result.map((r, idx) => (
                <div key={idx} className="cell" style={{ width: 38, height: 38, fontSize: "0.85rem" }}>
                  {r === null ? "-1" : r}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Linked List reversal ---------------- */

interface LLFrame {
  values: number[];
  // next[i] = index of next node, or -1
  next: number[];
  prev: number; // index
  curr: number;
  nxt: number;
  caption: string;
  head: number;
}

function buildReverseFrames(values: number[]): LLFrame[] {
  const n = values.length;
  const next = values.map((_, i) => (i + 1 < n ? i + 1 : -1));
  const frames: LLFrame[] = [];
  let prev = -1;
  let curr = 0;
  frames.push({
    values,
    next: [...next],
    prev,
    curr,
    nxt: -1,
    head: 0,
    caption: "prev = null, curr = head. We'll flip each arrow to point backward.",
  });
  while (curr !== -1) {
    const nxt = next[curr];
    frames.push({
      values,
      next: [...next],
      prev,
      curr,
      nxt,
      head: prev === -1 ? 0 : prev,
      caption: `Save nxt = node ${nxt === -1 ? "null" : values[nxt]}. (Don't lose the rest of the list.)`,
    });
    next[curr] = prev; // flip
    frames.push({
      values,
      next: [...next],
      prev,
      curr,
      nxt,
      head: curr,
      caption: `Flip: node ${values[curr]}.next now points to ${prev === -1 ? "null" : values[prev]}.`,
    });
    prev = curr;
    curr = nxt;
    frames.push({
      values,
      next: [...next],
      prev,
      curr,
      nxt: -1,
      head: prev,
      caption: curr === -1 ? `curr is null → done. New head is ${values[prev]}.` : `Advance: prev → ${values[prev]}, curr → ${values[curr]}.`,
    });
  }
  return frames;
}

export function LinkedListViz() {
  const values = useMemo(() => [1, 2, 3, 4], []);
  const frames = useMemo(() => buildReverseFrames(values), [values]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  // render nodes in original left-to-right layout, draw arrows per f.next
  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="ll">
          {values.map((v, idx) => {
            const role = idx === f.prev ? "prev" : idx === f.curr ? "curr" : idx === f.nxt ? "nxt" : "";
            const target = f.next[idx];
            const reversed = target !== -1 && target < idx;
            return (
              <div key={idx} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div className={`ll-node ${role}`}>
                  {v}
                  {role && (
                    <span
                      className="ptr"
                      style={{ color: role === "prev" ? "var(--good)" : role === "curr" ? "var(--accent)" : "var(--warn)" }}
                    >
                      {role}
                    </span>
                  )}
                </div>
                {idx < values.length - 1 && (
                  <span className={`ll-arrow ${reversed ? "rev" : ""}`}>{reversed ? "←" : "→"}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="viz-readout">
          <span>prev = <b>{f.prev === -1 ? "null" : values[f.prev]}</b></span>
          <span>curr = <b>{f.curr === -1 ? "null" : values[f.curr]}</b></span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Heap: insertion with sift-up ---------------- */

interface HeapFrame {
  heap: number[];
  active: number; // index being sifted
  swapWith?: number;
  caption: string;
}

function buildHeapFrames(values: number[]): HeapFrame[] {
  const frames: HeapFrame[] = [];
  const heap: number[] = [];
  for (const v of values) {
    heap.push(v);
    let i = heap.length - 1;
    frames.push({ heap: [...heap], active: i, caption: `Insert ${v} at the end (index ${i}). Now bubble it up while it's smaller than its parent.` });
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[parent] <= heap[i]) {
        frames.push({ heap: [...heap], active: i, caption: `${heap[i]} ≥ parent ${heap[parent]} → heap property holds. Stop.` });
        break;
      }
      frames.push({ heap: [...heap], active: i, swapWith: parent, caption: `${heap[i]} < parent ${heap[parent]} → swap them.` });
      [heap[i], heap[parent]] = [heap[parent], heap[i]];
      i = parent;
    }
    if (i === 0) frames.push({ heap: [...heap], active: 0, caption: `${heap[0]} reached the root — it's the new minimum.` });
  }
  return frames;
}

// position nodes for a binary heap drawn as a tree
function heapLayout(n: number) {
  const positions: { x: number; y: number }[] = [];
  const levels = Math.floor(Math.log2(Math.max(1, n))) + 1;
  const W = 480;
  const H = 60 + (levels - 1) * 70;
  for (let i = 0; i < n; i++) {
    const level = Math.floor(Math.log2(i + 1));
    const levelStart = Math.pow(2, level) - 1;
    const idxInLevel = i - levelStart;
    const nodesInLevel = Math.pow(2, level);
    const x = (W * (idxInLevel + 1)) / (nodesInLevel + 1);
    const y = 30 + level * 70;
    positions.push({ x, y });
  }
  return { positions, W, H };
}

export function HeapViz() {
  const values = useMemo(() => [5, 3, 8, 1, 9, 2], []);
  const frames = useMemo(() => buildHeapFrames(values), [values]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];
  const { positions, W, H } = heapLayout(f.heap.length);

  return (
    <div className="viz">
      <div className="viz-stage">
        <svg className="viz-svg" viewBox={`0 0 ${W} ${H}`}>
          {f.heap.map((_, i) => {
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            return (
              <g key={`e${i}`}>
                {left < f.heap.length && (
                  <line className="edge-line tree" x1={positions[i].x} y1={positions[i].y} x2={positions[left].x} y2={positions[left].y} />
                )}
                {right < f.heap.length && (
                  <line className="edge-line tree" x1={positions[i].x} y1={positions[i].y} x2={positions[right].x} y2={positions[right].y} />
                )}
              </g>
            );
          })}
          {f.heap.map((v, i) => {
            const cls = ["node-circle", i === f.active ? "active" : "", i === f.swapWith ? "visited" : ""].filter(Boolean).join(" ");
            return (
              <g key={`n${i}`}>
                <circle className={cls} cx={positions[i].x} cy={positions[i].y} r={18} />
                <text className="node-text" x={positions[i].x} y={positions[i].y}>{v}</text>
              </g>
            );
          })}
        </svg>
        <div className="viz-readout">
          <span>array: <b>[{f.heap.join(", ")}]</b></span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}
