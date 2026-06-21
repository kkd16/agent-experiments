// Learning-rate schedules. The trainer asks `lrAt(step)` each optimization step and writes
// the result into the optimizer, so the live learning rate follows whatever shape is picked.

export type ScheduleKind = 'constant' | 'step' | 'cosine' | 'warmup-cosine';

export interface ScheduleConfig {
  kind: ScheduleKind;
  baseLr: number;
  period: number; // cosine cycle length / step-decay interval, in optimization steps
  warmup: number; // linear warmup length, in steps (warmup-cosine)
  gamma: number; // multiplicative decay per period (step)
  minFrac: number; // cosine floor as a fraction of baseLr
}

export function defaultSchedule(baseLr: number): ScheduleConfig {
  return { kind: 'constant', baseLr, period: 400, warmup: 100, gamma: 0.5, minFrac: 0.05 };
}

export function lrAt(cfg: ScheduleConfig, step: number): number {
  const { kind, baseLr, period, warmup, gamma, minFrac } = cfg;
  switch (kind) {
    case 'constant':
      return baseLr;
    case 'step': {
      const k = Math.floor(step / Math.max(1, period));
      return baseLr * Math.pow(gamma, k);
    }
    case 'cosine': {
      const p = Math.max(1, period);
      const phase = (step % p) / p;
      const minLr = baseLr * minFrac;
      return minLr + 0.5 * (baseLr - minLr) * (1 + Math.cos(Math.PI * phase));
    }
    case 'warmup-cosine': {
      if (step < warmup) return baseLr * ((step + 1) / Math.max(1, warmup));
      const p = Math.max(1, period);
      const phase = Math.min(1, (step - warmup) / p);
      const minLr = baseLr * minFrac;
      return minLr + 0.5 * (baseLr - minLr) * (1 + Math.cos(Math.PI * phase));
    }
  }
}

// A short preview of the schedule's shape (for the control-panel sparkline).
export function previewSchedule(cfg: ScheduleConfig, steps: number, samples = 80): number[] {
  const out: number[] = [];
  for (let i = 0; i < samples; i++) out.push(lrAt(cfg, Math.floor((i / (samples - 1)) * steps)));
  return out;
}
