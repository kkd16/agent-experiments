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
 *
 * Beyond the plain solver this engine also carries three research-grade
 * extensions, each toggle-able and each verified against closed-form theory in
 * the Measurement lab:
 *   • a convolutional PML (CFS-CPML) absorbing boundary  — see cpml.ts
 *   • frequency-dispersive Drude/Lorentz materials (ADE) — see dispersion.ts
 *   • a time-averaged Poynting energy-flux field ⟨S⟩ = ⟨E×H⟩
 */

import { buildCpmlAxis, DEFAULT_CPML, type CpmlAxis, type CpmlParams } from './cpml';
import { buildDispEntry, type DispEntry, type DispersionModel } from './dispersion';

/** Free-space impedance, used by Schneider's normalized update. */
const IMP0 = 377;
const EPS0 = 1 / IMP0;
const MU0 = IMP0;

/** Courant number. Must satisfy Sc <= 1/sqrt(2) ~= 0.7071 in 2D. */
export const COURANT = 0.7;

export type SourceKind = 'sine' | 'gaussian' | 'ricker';
export type BoundaryMode = 'cpml' | 'sponge';

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
  /** relative permittivity (>= 1); acts as ε∞ for a dispersive cell */
  epsR: number;
  /** dimensionless loss coefficient in [0, ~0.5); 0 = lossless */
  loss: number;
  /** perfect electric conductor (metal) — forces Ez = 0 */
  pec: boolean;
  /** optional frequency-dispersive pole model (real metals / resonant media) */
  disp?: DispersionModel;
  /** stable small integer id (1..255) identifying the dispersion model */
  dispId?: number;
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

  // Time-averaged Poynting flux ⟨S⟩ = ⟨E×H⟩ (energy-flux vector field).
  private sumSx: Float32Array;
  private sumSy: Float32Array;
  private fluxBufX: Float32Array;
  private fluxBufY: Float32Array;
  private fluxCount = 0;
  accumulateFlux = false;

  // Per-cell material description.
  readonly epsR: Float32Array;
  readonly loss: Float32Array;
  readonly pec: Uint8Array;

  // Dispersive-material bookkeeping (ADE).
  readonly dispId: Uint8Array;
  private jz: Float32Array; // Drude polarization current J / Lorentz polarization P
  private pPrev: Float32Array; // Lorentz P^{n-1}
  private dispTable: (DispEntry | null)[] = [];
  private dispCells: number[] = [];
  private dispDirty = true;

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

  // Absorbing boundary.
  boundaryMode: BoundaryMode = 'cpml';
  private spongeThickness = 22;
  private spongeMax = 0.32;

  // Exactly-conserved energy tracking (for the verification lab). The leapfrog
  // invariant uses E at integer steps and H as the product of the two
  // surrounding half-steps, which is conserved to machine precision in a
  // lossless region — unlike the naive ½(εE²+μH²), which ripples at 2ω.
  trackEnergy = false;
  lastConservedEnergy = 0;
  private energyMargin = 2;
  private hxPrev: Float32Array | null = null;
  private hyPrev: Float32Array | null = null;

  // CPML state.
  private cpmlParams: CpmlParams = { ...DEFAULT_CPML };
  private cpmlX: CpmlAxis;
  private cpmlY: CpmlAxis;
  // Convolutional memory (ψ) for each stretched derivative.
  private psiEzx: Float32Array;
  private psiEzy: Float32Array;
  private psiHyx: Float32Array;
  private psiHxy: Float32Array;

  constructor(nx: number, ny: number) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.ez = new Float32Array(n);
    this.hx = new Float32Array(n);
    this.hy = new Float32Array(n);
    this.sumSq = new Float32Array(n);
    this.intensityBuf = new Float32Array(n);
    this.sumSx = new Float32Array(n);
    this.sumSy = new Float32Array(n);
    this.fluxBufX = new Float32Array(n);
    this.fluxBufY = new Float32Array(n);
    this.epsR = new Float32Array(n);
    this.loss = new Float32Array(n);
    this.pec = new Uint8Array(n);
    this.dispId = new Uint8Array(n);
    this.jz = new Float32Array(n);
    this.pPrev = new Float32Array(n);
    this.cezSelf = new Float32Array(n);
    this.cezCurl = new Float32Array(n);
    this.chSelf = new Float32Array(n);
    this.chCurl = new Float32Array(n);
    this.psiEzx = new Float32Array(n);
    this.psiEzy = new Float32Array(n);
    this.psiHyx = new Float32Array(n);
    this.psiHxy = new Float32Array(n);
    this.cpmlX = buildCpmlAxis(nx, COURANT, this.cpmlParams);
    this.cpmlY = buildCpmlAxis(ny, COURANT, this.cpmlParams);
    this.clearMaterials();
  }

  idx(x: number, y: number): number {
    return x + y * this.nx;
  }

  /** Thickness of the absorbing boundary for interior crops / readouts. */
  boundaryThickness(): number {
    return this.boundaryMode === 'cpml'
      ? Math.min(this.cpmlParams.thickness, Math.floor((Math.min(this.nx, this.ny) - 2) / 2))
      : this.spongeThickness;
  }

  /** Reset every material cell to vacuum and rebuild the absorbing boundary. */
  clearMaterials(): void {
    this.epsR.fill(1);
    this.loss.fill(0);
    this.pec.fill(0);
    this.dispId.fill(0);
    if (this.boundaryMode === 'sponge') this.applySponge();
    this.coeffsDirty = true;
    this.dispDirty = true;
  }

  setBoundaryMode(mode: BoundaryMode): void {
    if (mode === this.boundaryMode) return;
    this.boundaryMode = mode;
    // Rebuild the loss field: the sponge writes into `loss`, CPML does not.
    this.loss.fill(0);
    // Re-apply painted loss from absorber cells is not tracked separately; a
    // clean rebuild is only needed for the sponge overlay, which we add here.
    if (mode === 'sponge') this.applySponge();
    this.resetPml();
    this.coeffsDirty = true;
  }

  setCpmlParams(p: Partial<CpmlParams>): void {
    this.cpmlParams = { ...this.cpmlParams, ...p };
    this.cpmlX = buildCpmlAxis(this.nx, COURANT, this.cpmlParams);
    this.cpmlY = buildCpmlAxis(this.ny, COURANT, this.cpmlParams);
    this.resetPml();
  }

  private resetPml(): void {
    this.psiEzx.fill(0);
    this.psiEzy.fill(0);
    this.psiHyx.fill(0);
    this.psiHxy.fill(0);
  }

  /** Toggle whether each step accumulates into the intensity buffer. */
  setAccumulate(on: boolean): void {
    this.accumulate = on;
  }

  /** Toggle whether each step accumulates into the Poynting-flux buffers. */
  setAccumulateFlux(on: boolean): void {
    this.accumulateFlux = on;
  }

  /** Reset the time-averaged intensity accumulation. */
  resetExposure(): void {
    this.sumSq.fill(0);
    this.sampleCount = 0;
    this.sumSx.fill(0);
    this.sumSy.fill(0);
    this.fluxCount = 0;
  }

  /** Normalized time-averaged intensity ⟨Ez²⟩ into a reusable buffer. */
  normalizedIntensity(): Float32Array {
    const inv = this.sampleCount > 0 ? 1 / this.sampleCount : 0;
    const { sumSq, intensityBuf } = this;
    for (let i = 0; i < sumSq.length; i++) intensityBuf[i] = sumSq[i] * inv;
    return intensityBuf;
  }

  /** Time-averaged Poynting vector components ⟨Sx⟩, ⟨Sy⟩ and its magnitude. */
  normalizedFlux(): { sx: Float32Array; sy: Float32Array; count: number } {
    const inv = this.fluxCount > 0 ? 1 / this.fluxCount : 0;
    const { sumSx, sumSy, fluxBufX, fluxBufY } = this;
    for (let i = 0; i < sumSx.length; i++) {
      fluxBufX[i] = sumSx[i] * inv;
      fluxBufY[i] = sumSy[i] * inv;
    }
    return { sx: fluxBufX, sy: fluxBufY, count: this.fluxCount };
  }

  /** Zero all fields and probe traces; keep materials & sources. */
  resetFields(): void {
    this.ez.fill(0);
    this.hx.fill(0);
    this.hy.fill(0);
    this.jz.fill(0);
    this.pPrev.fill(0);
    this.resetPml();
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
    this.dispTable = [];
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
    if (this.boundaryMode === 'sponge') this.applySponge();
    this.coeffsDirty = true;
  }

  /** Sponge loss contribution at (x, y), or 0 under CPML. */
  private spongeLossAt(x: number, y: number): number {
    if (this.boundaryMode !== 'sponge') return 0;
    const d = Math.min(x, y, this.nx - 1 - x, this.ny - 1 - y);
    if (d >= this.spongeThickness) return 0;
    const t = (this.spongeThickness - d) / this.spongeThickness;
    return this.spongeMax * t * t * t;
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
    this.dispDirty = true;
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
    this.dispDirty = true;
  }

  private setCell(x: number, y: number, mat: Material): void {
    const i = x + y * this.nx;
    this.epsR[i] = mat.epsR;
    this.pec[i] = mat.pec ? 1 : 0;
    this.loss[i] = Math.max(mat.loss, this.spongeLossAt(x, y));
    if (mat.disp && mat.dispId) {
      this.dispId[i] = mat.dispId;
      if (!this.dispTable[mat.dispId]) {
        this.dispTable[mat.dispId] = buildDispEntry(mat.disp, mat.epsR, COURANT);
      }
      // reset the auxiliary state on (re)assignment so an old J doesn't linger
      this.jz[i] = 0;
      this.pPrev[i] = 0;
    } else {
      this.dispId[i] = 0;
    }
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

  private rebuildDispCells(): void {
    const cells: number[] = [];
    const { dispId } = this;
    for (let i = 0; i < dispId.length; i++) if (dispId[i]) cells.push(i);
    this.dispCells = cells;
    this.dispDirty = false;
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

  /** Enable/disable the exactly-conserved energy diagnostic. */
  setTrackEnergy(on: boolean, margin = 2): void {
    this.trackEnergy = on;
    this.energyMargin = margin;
    if (on && !this.hxPrev) {
      this.hxPrev = new Float32Array(this.nx * this.ny);
      this.hyPrev = new Float32Array(this.nx * this.ny);
    }
  }

  /** Time-centered leapfrog energy: ½Σ(ε0εr Eⁿ² + μ0 Hⁿ⁻½·Hⁿ⁺½). */
  private computeConservedEnergy(): void {
    const { nx, ny, ez, hx, hy, epsR, hxPrev, hyPrev } = this;
    if (!hxPrev || !hyPrev) return;
    const m = this.energyMargin;
    let u = 0;
    for (let j = m; j < ny - m; j++) {
      const row = j * nx;
      for (let i = m; i < nx - m; i++) {
        const k = row + i;
        u +=
          0.5 *
          (EPS0 * epsR[k] * ez[k] * ez[k] +
            MU0 * (hxPrev[k] * hx[k] + hyPrev[k] * hy[k]));
      }
    }
    this.lastConservedEnergy = u;
  }

  /** Advance the simulation by one timestep. */
  step(): void {
    if (this.coeffsDirty) this.recomputeCoeffs();
    if (this.dispDirty) this.rebuildDispCells();

    // Snapshot Hⁿ⁻½ before the magnetic update for the conserved-energy diagnostic.
    if (this.trackEnergy && this.hxPrev && this.hyPrev) {
      this.hxPrev.set(this.hx);
      this.hyPrev.set(this.hy);
    }

    if (this.boundaryMode === 'cpml') this.updateMagneticCpml();
    else this.updateMagneticPlain();

    // Now hx,hy hold Hⁿ⁺½ and ez still holds Eⁿ — evaluate the invariant here.
    if (this.trackEnergy) this.computeConservedEnergy();

    // Snapshot Ez at dispersive cells before the E-update overwrites them.
    const disp = this.dispCells;
    const ezOld = disp.length ? this.snapshotDisp(disp) : null;

    if (this.boundaryMode === 'cpml') this.updateElectricCpml();
    else this.updateElectricPlain();

    if (ezOld) this.applyDispersion(disp, ezOld);

    this.injectSources();
    this.accumulateFields();
    this.sampleProbes();
    this.step_++;
  }

  // ── Plain (sponge / open) Yee updates ──────────────────────────────────────

  private updateMagneticPlain(): void {
    const { nx, ny, ez, hx, hy, chSelf, chCurl } = this;
    for (let j = 0; j < ny - 1; j++) {
      const row = j * nx;
      const rowUp = (j + 1) * nx;
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        hx[k] = chSelf[k] * hx[k] - chCurl[k] * (ez[rowUp + i] - ez[k]);
      }
    }
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx - 1; i++) {
        const k = row + i;
        hy[k] = chSelf[k] * hy[k] + chCurl[k] * (ez[k + 1] - ez[k]);
      }
    }
  }

  private updateElectricPlain(): void {
    const { nx, ny, ez, hx, hy, cezSelf, cezCurl } = this;
    for (let j = 1; j < ny; j++) {
      const row = j * nx;
      const rowDn = (j - 1) * nx;
      for (let i = 1; i < nx; i++) {
        const k = row + i;
        const curl = hy[k] - hy[k - 1] - (hx[k] - hx[rowDn + i]);
        ez[k] = cezSelf[k] * ez[k] + cezCurl[k] * curl;
      }
    }
  }

  // ── CPML (stretched-coordinate) Yee updates ────────────────────────────────

  private updateMagneticCpml(): void {
    const { nx, ny, ez, hx, hy, chSelf, chCurl } = this;
    const { bH: bHy, aH: aHy, invKH: invKx } = this.cpmlX;
    const { bH: bHx, aH: aHx, invKH: invKy } = this.cpmlY;
    const psiHxy = this.psiHxy;
    const psiHyx = this.psiHyx;
    // Hx uses ∂Ez/∂y (y-stretch).
    for (let j = 0; j < ny - 1; j++) {
      const row = j * nx;
      const rowUp = (j + 1) * nx;
      const by = bHx[j];
      const ay = aHx[j];
      const ik = invKy[j];
      for (let i = 0; i < nx; i++) {
        const k = row + i;
        const diff = ez[rowUp + i] - ez[k];
        const psi = by * psiHxy[k] + ay * diff;
        psiHxy[k] = psi;
        hx[k] = chSelf[k] * hx[k] - chCurl[k] * (diff * ik + psi);
      }
    }
    // Hy uses ∂Ez/∂x (x-stretch).
    for (let j = 0; j < ny; j++) {
      const row = j * nx;
      for (let i = 0; i < nx - 1; i++) {
        const k = row + i;
        const diff = ez[k + 1] - ez[k];
        const psi = bHy[i] * psiHyx[k] + aHy[i] * diff;
        psiHyx[k] = psi;
        hy[k] = chSelf[k] * hy[k] + chCurl[k] * (diff * invKx[i] + psi);
      }
    }
  }

  private updateElectricCpml(): void {
    const { nx, ny, ez, hx, hy, cezSelf, cezCurl } = this;
    const { bE: bEx, aE: aEx, invKE: invKx } = this.cpmlX;
    const { bE: bEy, aE: aEy, invKE: invKy } = this.cpmlY;
    const psiEzx = this.psiEzx;
    const psiEzy = this.psiEzy;
    for (let j = 1; j < ny; j++) {
      const row = j * nx;
      const rowDn = (j - 1) * nx;
      const by = bEy[j];
      const ay = aEy[j];
      const iky = invKy[j];
      for (let i = 1; i < nx; i++) {
        const k = row + i;
        const dHy = hy[k] - hy[k - 1];
        const dHx = hx[k] - hx[rowDn + i];
        const px = bEx[i] * psiEzx[k] + aEx[i] * dHy;
        const py = by * psiEzy[k] + ay * dHx;
        psiEzx[k] = px;
        psiEzy[k] = py;
        const curl = dHy * invKx[i] + px - (dHx * iky + py);
        ez[k] = cezSelf[k] * ez[k] + cezCurl[k] * curl;
      }
    }
  }

  // ── Dispersion (ADE) correction over the dispersive cells ──────────────────

  private snapshotDisp(cells: number[]): Float32Array {
    const buf = new Float32Array(cells.length);
    const ez = this.ez;
    for (let c = 0; c < cells.length; c++) buf[c] = ez[cells[c]];
    return buf;
  }

  private applyDispersion(cells: number[], ezOld: Float32Array): void {
    const { nx, ez, hx, hy, jz, pPrev, dispId, dispTable } = this;
    for (let c = 0; c < cells.length; c++) {
      const k = cells[c];
      const i = k % nx;
      const j = (k - i) / nx;
      if (i < 1 || j < 1) continue; // skip the un-updatable first row/column
      const entry = dispTable[dispId[k]];
      if (!entry) continue;
      const curl = hy[k] - hy[k - 1] - (hx[k] - hx[k - nx]);
      const e0 = ezOld[c];
      if (!entry.lorentz) {
        // Drude: E-update with the polarization current, then advance J.
        const eNew = entry.eA * e0 + entry.eB * curl - entry.eC * jz[k];
        jz[k] = entry.jA * jz[k] + entry.jB * (eNew + e0);
        ez[k] = eNew;
      } else {
        // Lorentz: advance the 2nd-order polarization, then correct E.
        const P = jz[k];
        const Pnew = entry.pA * P + entry.pB * pPrev[k] + entry.pC * e0;
        pPrev[k] = P;
        jz[k] = Pnew;
        ez[k] = e0 + entry.eB * curl - (Pnew - P) * entry.invEps0EpsInf;
      }
    }
  }

  private injectSources(): void {
    const { nx, ny, ez } = this;
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
  }

  private accumulateFields(): void {
    const { ez } = this;
    if (this.accumulate) {
      const sumSq = this.sumSq;
      for (let k = 0; k < ez.length; k++) sumSq[k] += ez[k] * ez[k];
      this.sampleCount++;
    }
    if (this.accumulateFlux) {
      // Poynting S = E×H; for TMz, Sx = −Ez·Hy, Sy = Ez·Hx, with H averaged to
      // the Ez node to co-locate the product.
      const { nx, ny, hx, hy, sumSx, sumSy } = this;
      for (let j = 1; j < ny; j++) {
        const row = j * nx;
        const rowDn = (j - 1) * nx;
        for (let i = 1; i < nx; i++) {
          const k = row + i;
          const e = ez[k];
          const hyAvg = 0.5 * (hy[k] + hy[k - 1]);
          const hxAvg = 0.5 * (hx[k] + hx[rowDn + i]);
          sumSx[k] += -e * hyAvg;
          sumSy[k] += e * hxAvg;
        }
      }
      this.fluxCount++;
    }
  }

  private sampleProbes(): void {
    const { nx, ez } = this;
    for (const p of this.probes) {
      const val = ez[p.x + p.y * nx];
      p.history[p.head] = val;
      p.head = (p.head + 1) % p.history.length;
      if (p.filled < p.history.length) p.filled++;
    }
  }

  /** Total field energy proxy (sum of Ez^2 over the interior). */
  energy(): number {
    const { nx, ny, ez } = this;
    const T = this.boundaryThickness();
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

  /**
   * Physically-scaled total electromagnetic energy over the interior:
   * U = ½ Σ (ε0 εr Ez² + μ0 (Hx² + Hy²)). In a lossless closed region this is
   * conserved by the leapfrog scheme (up to O(dt) staggering ripple), which the
   * Measurement lab uses to certify the solver is non-dissipative.
   */
  totalEMEnergy(margin = 0): number {
    const { nx, ny, ez, hx, hy, epsR } = this;
    let u = 0;
    for (let j = margin; j < ny - margin; j++) {
      const row = j * nx;
      for (let i = margin; i < nx - margin; i++) {
        const k = row + i;
        u += 0.5 * (EPS0 * epsR[k] * ez[k] * ez[k] + MU0 * (hx[k] * hx[k] + hy[k] * hy[k]));
      }
    }
    return u;
  }
}
