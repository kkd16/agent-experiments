/**
 * 2D FDTD solver for Maxwell's equations, TMz polarization.
 *
 * Fields on a staggered Yee grid (Schneider's normalized formulation):
 *   Ez  at integer nodes (i, j)
 *   Hx  at (i,   j+1/2)
 *   Hy  at (i+1/2, j)
 *
 * Non-magnetic media (mu_r = 1) with relative permittivity `epsR` and an
 * electric/magnetic loss term used both for real absorbers and for the graded
 * "matched lossy layer" that soaks up outgoing waves at the domain edges.
 *
 * Units are normalized so that dx = dy = 1 and c = 1. The Courant number `Sc`
 * sets the timestep; the 2D stability limit is Sc <= 1/sqrt(2).
 */

/** Free-space impedance, used by Schneider's normalized update. */
const IMP0 = 377;

/** Courant number. Must satisfy Sc <= 1/sqrt(2) ~= 0.7071 in 2D. */
export const COURANT = 0.7;

export type SourceKind = 'sine' | 'gaussian' | 'ricker';

export interface Source {
  id: number;
  /** grid column */
  x: number;
  /** grid row */
  y: number;
  kind: SourceKind;
  /** spatial wavelength in grid cells (drives temporal frequency) */
  wavelength: number;
  amplitude: number;
  /** step at which the source became active */
  startStep: number;
  /** optional line source: injects across a vertical extent of +/- halfLen cells */
  halfLen?: number;
}

export interface Probe {
  id: number;
  x: number;
  y: number;
  /** ring buffer of recent Ez samples */
  history: Float32Array;
  head: number;
  filled: number;
}

/** A material stamp applied to a cell. */
export interface Material {
  /** relative permittivity (>= 1) */
  epsR: number;
  /** dimensionless loss coefficient in [0, ~0.5); 0 = lossless */
  loss: number;
  /** perfect electric conductor (metal) — forces Ez = 0 */
  pec: boolean;
}

export const VACUUM: Material = { epsR: 1, loss: 0, pec: false };

const PROBE_HISTORY = 512;

export class FDTD {
  readonly nx: number;
  readonly ny: number;

  // Fields (flat, idx = x + y*nx).
  readonly ez: Float32Array;
  readonly hx: Float32Array;
  readonly hy: Float32Array;

  // Time-averaged intensity ("long exposure"): running sum of Ez^2 and a
  // normalized buffer computed on demand. Only accumulated while `accumulate`
  // is on, so the field-only view pays no cost.
  private sumSq: Float32Array;
  private intensityBuf: Float32Array;
  private sampleCount = 0;
  accumulate = false;

  // Per-cell material description.
  readonly epsR: Float32Array;
  readonly loss: Float32Array;
  readonly pec: Uint8Array;

  // Precomputed update coefficients (rebuilt when materials change).
  private cezSelf: Float32Array;
  private cezCurl: Float32Array;
  private chSelf: Float32Array;
  private chCurl: Float32Array;
  private coeffsDirty = true;

  sources: Source[] = [];
  probes: Probe[] = [];
  private nextId = 1;

  step_ = 0;

  // Absorbing-boundary parameters.
  private spongeThickness = 22;
  private spongeMax = 0.32;

  constructor(nx: number, ny: number) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.ez = new Float32Array(n);
    this.hx = new Float32Array(n);
    this.hy = new Float32Array(n);
    this.sumSq = new Float32Array(n);
    this.intensityBuf = new Float32Array(n);
    this.epsR = new Float32Array(n);
    this.loss = new Float32Array(n);
    this.pec = new Uint8Array(n);
    this.cezSelf = new Float32Array(n);
    this.cezCurl = new Float32Array(n);
    this.chSelf = new Float32Array(n);
    this.chCurl = new Float32Array(n);
    this.clearMaterials();
  }

  idx(x: number, y: number): number {
    return x + y * this.nx;
  }

  /** Reset every material cell to vacuum and rebuild the absorbing boundary. */
  clearMaterials(): void {
    this.epsR.fill(1);
    this.loss.fill(0);
    this.pec.fill(0);
    this.applySponge();
    this.coeffsDirty = true;
  }

  /** Toggle whether each step accumulates into the intensity buffer. */
  setAccumulate(on: boolean): void {
    this.accumulate = on;
  }

  /** Reset the time-averaged intensity accumulation. */
  resetExposure(): void {
    this.sumSq.fill(0);
    this.sampleCount = 0;
  }

  /** Normalized time-averaged intensity ⟨Ez²⟩ into a reusable buffer. */
  normalizedIntensity(): Float32Array {
    const inv = this.sampleCount > 0 ? 1 / this.sampleCount : 0;
    const { sumSq, intensityBuf } = this;
    for (let i = 0; i < sumSq.length; i++) intensityBuf[i] = sumSq[i] * inv;
    return intensityBuf;
  }

  /** Zero all fields and probe traces; keep materials & sources. */
  resetFields(): void {
    this.ez.fill(0);
    this.hx.fill(0);
    this.hy.fill(0);
    this.resetExposure();
    this.step_ = 0;
    for (const p of this.probes) {
      p.history.fill(0);
      p.head = 0;
      p.filled = 0;
    }
  }

  /** Full reset: fields, sources, probes, materials. */
  reset(): void {
    this.resetFields();
    this.sources = [];
    this.probes = [];
    this.clearMaterials();
  }

  /**
   * Graded "matched lossy layer": loss ramps up cubically toward each edge,
   * with electric and magnetic loss equal (impedance matched at normal
   * incidence). Not a full PML but keeps edge reflections small and cheap.
   */
  private applySponge(): void {
    const { nx, ny, loss } = this;
    const T = this.spongeThickness;
    const lmax = this.spongeMax;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const d = Math.min(x, y, nx - 1 - x, ny - 1 - y);
        if (d < T) {
          const t = (T - d) / T; // 1 at the very edge, ->0 at inner boundary
          const l = lmax * t * t * t;
          const i = x + y * nx;
          // keep the strongest of sponge loss and any painted loss
          if (l > loss[i]) loss[i] = l;
        }
      }
    }
  }

  setSponge(thickness: number, max: number): void {
    this.spongeThickness = thickness;
    this.spongeMax = max;
    // rebuild loss field from materials + sponge
    this.rebuildLossFromScratch();
  }

  private rebuildLossFromScratch(): void {
    // Painted loss is stored implicitly in `loss`; to rebuild cleanly we would
    // need the painted component separately. For simplicity we only re-apply
    // the sponge on top of the current loss field (used on construction and
    // clearMaterials, where painted loss is already zero).
    this.applySponge();
    this.coeffsDirty = true;
  }

  /** Stamp a filled disc of material centered at (cx, cy). */
  paintDisc(cx: number, cy: number, radius: number, mat: Material): void {
    const { nx, ny } = this;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(nx - 1, Math.ceil(cx + radius));
    const y0 = Math.max(0, Math.floor(cy - radius));
    const y1 = Math.min(ny - 1, Math.ceil(cy + radius));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) {
          this.setCell(x, y, mat);
        }
      }
    }
    this.coeffsDirty = true;
  }

  /** Stamp an axis-aligned rectangle of material. */
  paintRect(x0: number, y0: number, x1: number, y1: number, mat: Material): void {
    const ax = Math.max(0, Math.min(x0, x1));
    const bx = Math.min(this.nx - 1, Math.max(x0, x1));
    const ay = Math.max(0, Math.min(y0, y1));
    const by = Math.min(this.ny - 1, Math.max(y0, y1));
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        this.setCell(x, y, mat);
      }
    }
    this.coeffsDirty = true;
  }

  private setCell(x: number, y: number, mat: Material): void {
    const i = x + y * this.nx;
    this.epsR[i] = mat.epsR;
    this.pec[i] = mat.pec ? 1 : 0;
    // combine painted loss with any sponge loss already there
    const d = Math.min(x, y, this.nx - 1 - x, this.ny - 1 - y);
    let spongeLoss = 0;
    if (d < this.spongeThickness) {
      const t = (this.spongeThickness - d) / this.spongeThickness;
      spongeLoss = this.spongeMax * t * t * t;
    }
    this.loss[i] = Math.max(mat.loss, spongeLoss);
  }

  private recomputeCoeffs(): void {
    const n = this.nx * this.ny;
    for (let i = 0; i < n; i++) {
      const l = this.loss[i];
      const denom = 1 + l;
      if (this.pec[i]) {
        this.cezSelf[i] = 0;
        this.cezCurl[i] = 0;
      } else {
        this.cezSelf[i] = (1 - l) / denom;
        this.cezCurl[i] = (COURANT * IMP0) / this.epsR[i] / denom;
      }
      this.chSelf[i] = (1 - l) / denom;
      this.chCurl[i] = COURANT / IMP0 / denom;
    }
    this.coeffsDirty = false;
  }

  addSource(s: Omit<Source, 'id' | 'startStep'>): Source {
    const src: Source = { ...s, id: this.nextId++, startStep: this.step_ };
    this.sources.push(src);
    return src;
  }

  clearSources(): void {
    this.sources = [];
  }

  addProbe(x: number, y: number): Probe {
    const p: Probe = {
      id: this.nextId++,
      x,
      y,
      history: new Float32Array(PROBE_HISTORY),
      head: 0,
      filled: 0,
    };
    this.probes.push(p);
    return p;
  }

  clearProbes(): void {
    this.probes = [];
  }

  removeNear(x: number, y: number, radius: number): void {
    const r2 = radius * radius;
    const near = (px: number, py: number) => (px - x) * (px - x) + (py - y) * (py - y) <= r2;
    this.sources = this.sources.filter((s) => !near(s.x, s.y));
    this.probes = this.probes.filter((p) => !near(p.x, p.y));
  }

  /** Value of a source waveform at absolute step `n`. */
  private waveform(s: Source, n: number): number {
    const local = n - s.startStep;
    if (local < 0) return 0;
    // temporal period in steps for a wave of `wavelength` cells: wave moves
    // COURANT cells per step, so period = wavelength / COURANT.
    switch (s.kind) {
      case 'sine': {
        const period = s.wavelength / COURANT;
        // brief ramp-in to avoid a hard turn-on transient
        const ramp = Math.min(1, local / (2 * period));
        return s.amplitude * ramp * Math.sin((2 * Math.PI * local) / period);
      }
      case 'gaussian': {
        const period = s.wavelength / COURANT;
        const t0 = 3 * period;
        const spread = period;
        const arg = (local - t0) / spread;
        return s.amplitude * Math.exp(-arg * arg);
      }
      case 'ricker': {
        // Ricker (Mexican-hat) wavelet, broadband pulse centered at t0.
        const period = s.wavelength / COURANT;
        const fp = 1 / period; // peak frequency in cycles/step
        const t0 = 1.2 * period;
        const a = Math.PI * fp * (local - t0);
        const a2 = a * a;
        return s.amplitude * (1 - 2 * a2) * Math.exp(-a2);
      }
    }
  }

  /** Advance the simulation by one timestep. */
  step(): void {
    if (this.coeffsDirty) this.recomputeCoeffs();
    const { nx, ny, ez, hx, hy, chSelf, chCurl, cezSelf, cezCurl } = this;

    // --- Magnetic field update (Hx, Hy) ---
    // Hx at (i, j+1/2): dEz/dy
    for (let j = 0; j < ny - 1; j++) {
      const row = j * nx;
      const rowUp = (j + 1) * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        hx[k] = chSelf[k] * hx[k] - chCurl[k] * (ez[rowUp + i] - ez[k]);
      }
    }
    // Hy at (i+1/2, j): dEz/dx
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx - 1; i++) {
        const k = row + i;
        hy[k] = chSelf[k] * hy[k] + chCurl[k] * (ez[k + 1] - ez[k]);
      }
    }

    // --- Electric field update (Ez) ---
    // Ez at (i,j): curl H = (dHy/dx - dHx/dy)
    for (let j = 1; j < ny; j++) {
      const row = j * nx;
      const rowDn = (j - 1) * nx;
      for (let i = 1; i < nx; i++) {
        const k = row + i;
        const curl = hy[k] - hy[k - 1] - (hx[k] - hx[rowDn + i]);
        ez[k] = cezSelf[k] * ez[k] + cezCurl[k] * curl;
      }
    }

    // --- Soft sources (additive into Ez) ---
    const n = this.step_;
    for (const s of this.sources) {
      const v = this.waveform(s, n);
      if (v === 0 && s.kind !== 'sine') continue;
      if (s.halfLen && s.halfLen > 0) {
        const y0 = Math.max(1, s.y - s.halfLen);
        const y1 = Math.min(ny - 1, s.y + s.halfLen);
        for (let y = y0; y <= y1; y++) {
          ez[s.x + y * nx] += v;
        }
      } else {
        const k = s.x + s.y * nx;
        if (k >= 0 && k < ez.length) ez[k] += v;
      }
    }

    // --- Accumulate time-averaged intensity (long exposure) ---
    if (this.accumulate) {
      const sumSq = this.sumSq;
      for (let k = 0; k < ez.length; k++) sumSq[k] += ez[k] * ez[k];
      this.sampleCount++;
    }

    // --- Sample probes ---
    for (const p of this.probes) {
      const val = ez[p.x + p.y * nx];
      p.history[p.head] = val;
      p.head = (p.head + 1) % p.history.length;
      if (p.filled < p.history.length) p.filled++;
    }

    this.step_++;
  }

  /** Total field energy proxy (sum of Ez^2 over the interior). */
  energy(): number {
    const { nx, ny, ez } = this;
    const T = this.spongeThickness;
    let e = 0;
    for (let j = T; j < ny - T; j++) {
      const row = j * nx;
      for (let i = T; i < nx - T; i++) {
        const v = ez[row + i];
        e += v * v;
      }
    }
    return e;
  }
}
