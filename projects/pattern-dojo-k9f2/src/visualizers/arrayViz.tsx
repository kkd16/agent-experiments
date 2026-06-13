import { useMemo } from "react";
import { StepperControls } from "../components/Stepper";
import { useStepper } from "../lib/useStepper";

/* ---------------- Two Pointers (Two Sum II on sorted) ---------------- */

interface TPFrame {
  lo: number;
  hi: number;
  caption: string;
  done?: boolean;
}

function buildTwoPointerFrames(nums: number[], target: number): TPFrame[] {
  const frames: TPFrame[] = [];
  let lo = 0;
  let hi = nums.length - 1;
  frames.push({
    lo,
    hi,
    caption: `Start with pointers at both ends. Target sum = ${target}.`,
  });
  while (lo < hi) {
    const s = nums[lo] + nums[hi];
    if (s === target) {
      frames.push({
        lo,
        hi,
        done: true,
        caption: `nums[${lo}] + nums[${hi}] = ${nums[lo]} + ${nums[hi]} = ${s} ✓ Found the pair!`,
      });
      break;
    } else if (s < target) {
      frames.push({
        lo,
        hi,
        caption: `${nums[lo]} + ${nums[hi]} = ${s} < ${target}. Too small → move LEFT pointer up to grow the sum.`,
      });
      lo++;
    } else {
      frames.push({
        lo,
        hi,
        caption: `${nums[lo]} + ${nums[hi]} = ${s} > ${target}. Too big → move RIGHT pointer down to shrink the sum.`,
      });
      hi--;
    }
  }
  return frames;
}

export function TwoPointersViz() {
  const nums = useMemo(() => [1, 3, 4, 6, 8, 11, 15], []);
  const target = 14;
  const frames = useMemo(() => buildTwoPointerFrames(nums, target), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const cls = [
              "cell",
              idx === f.lo ? "lo" : "",
              idx === f.hi ? "hi" : "",
              f.done && (idx === f.lo || idx === f.hi) ? "match" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={idx} className={cls}>
                <span className="idx">{idx}</span>
                {v}
                {idx === f.lo && <span className="ptr" style={{ color: "var(--good)" }}>L</span>}
                {idx === f.hi && (
                  <span className="ptr" style={{ color: "var(--bad)", left: idx === f.lo ? undefined : 0 }}>
                    {idx === f.lo ? "L/R" : "R"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Sliding Window (longest substring no repeats) -------- */

interface SWFrame {
  left: number;
  right: number;
  best: number;
  caption: string;
}

function buildSlidingFrames(s: string): SWFrame[] {
  const frames: SWFrame[] = [];
  const seen = new Set<string>();
  let left = 0;
  let best = 0;
  for (let right = 0; right < s.length; right++) {
    const ch = s[right];
    while (seen.has(ch)) {
      frames.push({
        left,
        right,
        best,
        caption: `'${ch}' is already in the window → shrink from the left (drop '${s[left]}').`,
      });
      seen.delete(s[left]);
      left++;
    }
    seen.add(ch);
    const size = right - left + 1;
    best = Math.max(best, size);
    frames.push({
      left,
      right,
      best,
      caption: `Add '${ch}'. Window "${s.slice(left, right + 1)}" is valid, length ${size}. Best so far = ${best}.`,
    });
  }
  return frames;
}

export function SlidingWindowViz() {
  const s = "abcabcbb";
  const frames = useMemo(() => buildSlidingFrames(s), []);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {s.split("").map((ch, idx) => {
            const inWin = idx >= f.left && idx <= f.right;
            const cls = ["cell", inWin ? "in-window" : "", idx < f.left ? "done" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={idx} className={cls}>
                <span className="idx">{idx}</span>
                {ch}
                {idx === f.left && <span className="ptr" style={{ color: "var(--warn)" }}>L</span>}
                {idx === f.right && (
                  <span className="ptr" style={{ color: "var(--warn)", left: idx === f.left ? undefined : "auto", right: 0 }}>
                    {idx === f.left ? "" : "R"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className="viz-readout">
          <span>window = <b>{f.right - f.left + 1}</b></span>
          <span>best = <b>{f.best}</b></span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Binary Search ---------------- */

interface BSFrame {
  lo: number;
  hi: number;
  mid: number;
  caption: string;
  found?: boolean;
}

function buildBinaryFrames(nums: number[], target: number): BSFrame[] {
  const frames: BSFrame[] = [];
  let lo = 0;
  let hi = nums.length - 1;
  while (lo <= hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (nums[mid] === target) {
      frames.push({ lo, hi, mid, found: true, caption: `nums[${mid}] = ${nums[mid]} = target ✓ Found at index ${mid}.` });
      break;
    } else if (nums[mid] < target) {
      frames.push({ lo, hi, mid, caption: `nums[${mid}] = ${nums[mid]} < ${target}. Discard the left half → search right.` });
      lo = mid + 1;
    } else {
      frames.push({ lo, hi, mid, caption: `nums[${mid}] = ${nums[mid]} > ${target}. Discard the right half → search left.` });
      hi = mid - 1;
    }
  }
  if (frames.length === 0 || (!frames[frames.length - 1].found && lo > hi)) {
    // no entry if found already
  }
  return frames;
}

export function BinarySearchViz() {
  const nums = useMemo(() => [2, 5, 8, 12, 16, 23, 38, 56, 72, 91], []);
  const target = 23;
  const frames = useMemo(() => buildBinaryFrames(nums, target), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const inRange = idx >= f.lo && idx <= f.hi;
            const cls = [
              "cell",
              !inRange ? "done" : "",
              idx === f.mid ? "mid" : "",
              f.found && idx === f.mid ? "match" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={idx} className={cls}>
                <span className="idx">{idx}</span>
                {v}
                {idx === f.lo && idx !== f.mid && <span className="ptr" style={{ color: "var(--good)" }}>lo</span>}
                {idx === f.hi && idx !== f.mid && <span className="ptr" style={{ color: "var(--bad)" }}>hi</span>}
                {idx === f.mid && <span className="ptr" style={{ color: "var(--accent)" }}>mid</span>}
              </div>
            );
          })}
        </div>
        <div className="viz-readout">
          <span>searching for <b>{target}</b></span>
          <span>range size = <b>{Math.max(0, f.hi - f.lo + 1)}</b></span>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}

/* ---------------- Hash Map (Two Sum) ---------------- */

interface HMFrame {
  active: number;
  map: { k: number; v: number }[];
  fresh?: number;
  caption: string;
  matchIdx?: number[];
}

function buildHashFrames(nums: number[], target: number): HMFrame[] {
  const frames: HMFrame[] = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    const snap = () => [...seen.entries()].map(([k, v]) => ({ k, v }));
    if (seen.has(need)) {
      frames.push({
        active: i,
        map: snap(),
        matchIdx: [seen.get(need)!, i],
        caption: `Need ${need} (= ${target} − ${nums[i]}). It's in the map at index ${seen.get(need)}! Answer = [${seen.get(need)}, ${i}].`,
      });
      break;
    }
    frames.push({
      active: i,
      map: snap(),
      caption: `At index ${i}, value ${nums[i]}. Need ${need} — not in map yet. Store ${nums[i]} → ${i} and continue.`,
    });
    seen.set(nums[i], i);
    frames[frames.length - 1] = { ...frames[frames.length - 1], map: snap(), fresh: nums[i] };
  }
  return frames;
}

export function HashMapViz() {
  const nums = useMemo(() => [3, 8, 2, 11, 7], []);
  const target = 10;
  const frames = useMemo(() => buildHashFrames(nums, target), [nums]);
  const stepper = useStepper(frames.length);
  const f = frames[stepper.i];

  return (
    <div className="viz">
      <div className="viz-stage">
        <div className="cells">
          {nums.map((v, idx) => {
            const cls = [
              "cell",
              idx === f.active ? "active" : "",
              f.matchIdx?.includes(idx) ? "match" : "",
            ]
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
        <div className="viz-readout"><span>target = <b>{target}</b></span></div>
        <div>
          <div className="faint" style={{ fontSize: "0.74rem", textAlign: "center", marginBottom: 6 }}>
            hash map (value → index)
          </div>
          <div className="kvmap">
            {f.map.length === 0 && <span className="faint">empty</span>}
            {f.map.map((e) => (
              <div key={e.k} className={`kv ${f.fresh === e.k ? "fresh" : ""}`}>
                <span className="k">{e.k}</span>
                <span className="v"> → {e.v}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <StepperControls stepper={stepper} caption={f.caption} />
    </div>
  );
}
