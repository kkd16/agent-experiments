import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  solveFrame,
  type FrameModel,
  type FrameResult,
  type SupportKind,
} from './engine/frame'
import { solveContinuum, type ContinuumInput, type ContinuumResult } from './engine/continuum'
import {
  solveQuad,
  solveQuadModal,
  type QuadInput,
  type QuadResult,
  type QuadModalResult,
} from './engine/quadsolve'
import {
  solveModal,
  solveBuckling,
  solveTransient,
  evalTransient,
  type ModalResult,
  type BucklingResult,
  type TransientResult,
} from './engine/dynamics'
import {
  prepareHarmonic,
  frfSweep,
  harmonicShape,
  frfAt,
  type HarmonicPrep,
  type FrfCurve,
  type DriveType,
} from './engine/harmonic'
import { solvePushover, pushoverAt, memberMp, type PushoverResult } from './engine/plastic'
import {
  solveSeismic,
  seismicShape,
  makeGround,
  type SeismicResult,
  type GroundRecord,
} from './engine/seismic'
import {
  solveInelasticSeismic,
  inelasticShape,
  inelasticHinges,
  type InelasticResult,
} from './engine/inelastic'
import { SECTIONS, findSection } from './engine/sections'
import type { NodeDisp } from './engine/frame'
import { PRESETS, type ContinuumPreset, type FramePreset } from './engine/presets'
import { drawFrame, drawContinuum, drawQuadContinuum, type Picked } from './ui/draw'
import { fitView, screenToWorld, worldToScreen, zoomAt, pan, type View, type Bounds } from './ui/viewport'
import { CapacityCurvePlot, FrfPlot, HysteresisPlot, Legend, Segmented, Slider, SpectrumPlot, StatTile, TimeSeriesPlot, Toggle, VerifyBadge } from './ui/components'
import { fmtEng } from './ui/format'
import { TopOptStudio } from './ui/TopOptStudio'
import { ThermalStudio } from './ui/ThermalStudio'
import { FractureStudio } from './ui/FractureStudio'
import {
  addMember,
  addNode,
  cycleSupport,
  deleteMember,
  deleteNode,
  getLoad,
  moveNode,
  pickMember,
  pickNode,
  setLoad,
  setSupport,
} from './edit'
import {
  cloneFrame,
  downloadJSON,
  loadLocal,
  readHash,
  saveLocal,
  writeHash,
  type Display,
  type FrameAnalysis,
  type ElemOrder,
  type Scene,
} from './state'

type Tab = 'frame' | 'continuum' | 'topopt' | 'thermal' | 'fracture'
type Tool = 'select' | 'node' | 'member' | 'support' | 'load' | 'delete'

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'select', label: '⤢ Select', hint: 'Select & drag nodes; pan on empty space' },
  { id: 'node', label: '• Node', hint: 'Click to place a new joint' },
  { id: 'member', label: '／ Member', hint: 'Click two joints to connect them' },
  { id: 'support', label: '⊿ Support', hint: 'Click a joint to cycle its support' },
  { id: 'load', label: '↓ Load', hint: 'Click a joint to add −10 kN (edit exact value at right)' },
  { id: 'delete', label: '✕ Delete', hint: 'Click a joint or member to remove it' },
]

const SUPPORTS: SupportKind[] = ['free', 'pin', 'roller-x', 'roller-y', 'fixed']

const DEFAULT_DISPLAY: Display = {
  deformScale: 1,
  autoDeform: true,
  colorBy: 'force',
  field: 'vm',
  colormap: 'turbo',
  showUndeformed: true,
  showLoads: true,
  showReactions: true,
  showLabels: false,
  showMesh: true,
  analysis: 'static',
  respZeta: 0.03,
  harmZeta: 0.03,
}

function frameBounds(m: FrameModel): Bounds {
  const xs = m.nodes.map((n) => n.x)
  const ys = m.nodes.map((n) => n.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
function meshBounds(inp: ContinuumInput): Bounds {
  return { minX: inp.mesh.minX, maxX: inp.mesh.maxX, minY: inp.mesh.minY, maxY: inp.mesh.maxY }
}
function quadBounds(inp: QuadInput): Bounds {
  return { minX: inp.mesh.minX, maxX: inp.mesh.maxX, minY: inp.mesh.minY, maxY: inp.mesh.maxY }
}
function boundsDiag(b: Bounds): number {
  return Math.hypot(b.maxX - b.minX, b.maxY - b.minY) || 1
}
const snap = (v: number, g = 0.5) => Math.round(v / g) * g

function safeSolveFrame(m: FrameModel): FrameResult | null {
  try {
    return solveFrame(m)
  } catch {
    return null
  }
}
function safeSolveContinuum(inp: ContinuumInput): ContinuumResult | null {
  try {
    return solveContinuum(inp)
  } catch {
    return null
  }
}
function safeSolveQuad(inp: QuadInput): QuadResult | null {
  try {
    return solveQuad(inp)
  } catch {
    return null
  }
}
function safeSolveQuadModal(inp: QuadInput): QuadModalResult | null {
  try {
    return solveQuadModal(inp, 6)
  } catch {
    return null
  }
}
function safeSolveModal(m: FrameModel): ModalResult | null {
  try {
    return solveModal(m)
  } catch {
    return null
  }
}
function safeSolveBuckling(m: FrameModel): BucklingResult | null {
  try {
    return solveBuckling(m)
  } catch {
    return null
  }
}
function safeSolveTransient(m: FrameModel): TransientResult | null {
  try {
    return solveTransient(m)
  } catch {
    return null
  }
}
function safeSolveHarmonic(m: FrameModel): HarmonicPrep | null {
  try {
    return prepareHarmonic(m)
  } catch {
    return null
  }
}
function safeSolvePushover(m: FrameModel, secondOrder: boolean): PushoverResult | null {
  try {
    return solvePushover(m, { secondOrder })
  } catch {
    return null
  }
}
function safeSolveSeismic(m: FrameModel, record: GroundRecord, pga: number, zeta: number): SeismicResult | null {
  try {
    return solveSeismic(m, makeGround(record, pga), zeta)
  } catch {
    return null
  }
}
function safeSolveInelastic(
  m: FrameModel,
  record: GroundRecord,
  pga: number,
  zeta: number,
  alpha: number,
  strengthFactor: number,
): InelasticResult | null {
  try {
    return solveInelasticSeismic(m, makeGround(record, pga), { zeta, alpha, strengthFactor })
  } catch {
    return null
  }
}

const WARREN = (PRESETS.find((p) => p.id === 'warren') as FramePreset).model

export default function App() {
  const initial = useMemo<Scene | null>(() => readHash() ?? loadLocal(), [])
  const [tab, setTab] = useState<Tab>(initial?.tab ?? 'frame')
  const [frame, setFrame] = useState<FrameModel>(() => cloneFrame(initial?.frame ?? WARREN))
  const [contId, setContId] = useState(initial?.continuum.presetId ?? 'c-hole')
  const [density, setDensity] = useState(initial?.continuum.density ?? 1)
  const [elemOrder, setElemOrder] = useState<ElemOrder>(initial?.continuum.elemOrder ?? 'q8')
  const [display, setDisplay] = useState<Display>(initial?.display ?? DEFAULT_DISPLAY)
  const contAnalysis = display.contAnalysis ?? 'static'
  const [contModeIdx, setContModeIdx] = useState(0)
  const [contModeT, setContModeT] = useState(0)
  const [contModePlaying, setContModePlaying] = useState(true)

  const analysis: FrameAnalysis = display.analysis ?? 'static'
  const [modeIndex, setModeIndex] = useState(0)
  const [modeT, setModeT] = useState(0)
  const [respPlaying, setRespPlaying] = useState(true)
  const [respShape, setRespShape] = useState<NodeDisp[] | null>(null)
  const [respElapsed, setRespElapsed] = useState(0)
  const respTimeRef = useRef(0)
  const respZeta = display.respZeta ?? 0.03

  // Forced-harmonic (FRF) state.
  const harmZeta = display.harmZeta ?? 0.03
  const driveType: DriveType = display.driveType ?? 'force'
  const [driveHz, setDriveHz] = useState(1)
  const [harmPlaying, setHarmPlaying] = useState(true)
  const [harmShape, setHarmShape] = useState<NodeDisp[] | null>(null)

  // Pushover (nonlinear plastic-collapse) state.
  const pushSecondOrder = display.pushSecondOrder ?? false
  const [pushS, setPushS] = useState(0) // pseudo-time along the capacity curve
  const [pushPlaying, setPushPlaying] = useState(true)

  // Seismic (time-history) state.
  const seisRecord: GroundRecord = display.seisRecord ?? 'synthetic'
  const seisPga = display.seisPga ?? 0.4
  const seisZeta = display.seisZeta ?? 0.05
  const [seisPlaying, setSeisPlaying] = useState(true)
  const [seisShape, setSeisShape] = useState<NodeDisp[] | null>(null)
  const [seisElapsed, setSeisElapsed] = useState(0)
  const seisTimeRef = useRef(0)

  // Inelastic (nonlinear hysteretic time-history) state.
  const inelAlpha = display.inelAlpha ?? 0.03
  const inelStrength = display.inelStrength ?? 0.5
  const [inelPlaying, setInelPlaying] = useState(true)
  const [inelShape, setInelShape] = useState<NodeDisp[] | null>(null)
  const [inelHinges, setInelHinges] = useState<{ node: number; sign: number }[]>([])
  const [inelElapsed, setInelElapsed] = useState(0)
  const inelTimeRef = useRef(0)

  const [tool, setTool] = useState<Tool>('select')
  const [sel, setSel] = useState<Picked | null>(null)
  const [hover, setHover] = useState<Picked | null>(null)
  const [pendingNode, setPendingNode] = useState<number | null>(null)
  const [loadFactor, setLoadFactor] = useState(1)
  const [view, setView] = useState<View | null>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // --- solved results -------------------------------------------------------
  const frameResult = useMemo(() => (tab === 'frame' ? safeSolveFrame(frame) : null), [tab, frame])
  const contPreset = useMemo(
    () => PRESETS.find((p) => p.id === contId) as ContinuumPreset,
    [contId],
  )
  const useQuad = elemOrder === 'q4' || elemOrder === 'q8'
  const contInput = useMemo(
    () => (tab === 'continuum' && !useQuad ? contPreset.make(density) : null),
    [tab, contPreset, density, useQuad],
  )
  const contResult = useMemo(
    () => (contInput ? safeSolveContinuum(contInput) : null),
    [contInput],
  )
  const quadInput = useMemo(
    () =>
      tab === 'continuum' && useQuad
        ? contPreset.makeQuad(elemOrder === 'q8' ? 8 : 4, density)
        : null,
    [tab, contPreset, density, useQuad, elemOrder],
  )
  const quadResult = useMemo(
    () => (quadInput ? safeSolveQuad(quadInput) : null),
    [quadInput],
  )
  const quadModal = useMemo(
    () =>
      quadInput && contAnalysis === 'modal' ? safeSolveQuadModal(quadInput) : null,
    [quadInput, contAnalysis],
  )
  const activeContBounds = useMemo<Bounds | null>(
    () => (quadInput ? quadBounds(quadInput) : contInput ? meshBounds(contInput) : null),
    [quadInput, contInput],
  )
  // Clamp the selected continuum mode to the available range.
  const contModeCount = quadModal?.modes.length ?? 0
  const contModeSel = contModeCount > 0 ? Math.min(contModeIdx, contModeCount - 1) : 0
  const contMode = quadModal?.modes[contModeSel] ?? null

  // --- eigen-analysis results (modal / buckling) ---------------------------
  const modalResult = useMemo(
    () => (tab === 'frame' && analysis === 'modal' ? safeSolveModal(frame) : null),
    [tab, analysis, frame],
  )
  const bucklingResult = useMemo(
    () => (tab === 'frame' && analysis === 'buckling' ? safeSolveBuckling(frame) : null),
    [tab, analysis, frame],
  )
  const transientResult = useMemo(
    () => (tab === 'frame' && analysis === 'response' ? safeSolveTransient(frame) : null),
    [tab, analysis, frame],
  )
  const harmPrep = useMemo(
    () => (tab === 'frame' && analysis === 'harmonic' ? safeSolveHarmonic(frame) : null),
    [tab, analysis, frame],
  )
  const pushResult = useMemo(
    () => (tab === 'frame' && analysis === 'pushover' ? safeSolvePushover(frame, pushSecondOrder) : null),
    [tab, analysis, frame, pushSecondOrder],
  )
  const seismicResult = useMemo(
    () =>
      tab === 'frame' && analysis === 'seismic'
        ? safeSolveSeismic(frame, seisRecord, seisPga, seisZeta)
        : null,
    [tab, analysis, frame, seisRecord, seisPga, seisZeta],
  )
  const inelasticResult = useMemo(
    () =>
      tab === 'frame' && analysis === 'inelastic'
        ? safeSolveInelastic(frame, seisRecord, seisPga, seisZeta, inelAlpha, inelStrength)
        : null,
    [tab, analysis, frame, seisRecord, seisPga, seisZeta, inelAlpha, inelStrength],
  )
  const frf = useMemo<FrfCurve | null>(
    () => (harmPrep?.ok ? frfSweep(harmPrep, harmZeta, driveType) : null),
    [harmPrep, harmZeta, driveType],
  )
  const harmInfo = useMemo(
    () => (harmPrep?.ok ? frfAt(harmPrep, harmZeta, driveHz * 2 * Math.PI, driveType) : null),
    [harmPrep, harmZeta, driveHz, driveType],
  )
  const activeEigen = analysis === 'modal' ? modalResult : analysis === 'buckling' ? bucklingResult : null
  const modeCount = activeEigen?.modes.length ?? 0
  const effModeIndex = modeCount > 0 ? Math.min(modeIndex, modeCount - 1) : 0
  const selMode = activeEigen?.modes[effModeIndex] ?? null
  const modeScale = useMemo(() => 0.16 * boundsDiag(frameBounds(frame)), [frame])

  // Pushover: sample the capacity curve at the current pseudo-time, and scale the
  // deflection so the (real, growing) plastic mechanism stays on screen.
  const pushInfo = useMemo(
    () => (pushResult?.ok ? pushoverAt(pushResult, pushS) : null),
    [pushResult, pushS],
  )
  const pushScale = useMemo(() => {
    if (!pushResult?.ok) return 1
    let peak = 1e-30
    for (const st of pushResult.states) for (const d of st) peak = Math.max(peak, Math.hypot(d.ux, d.uy))
    return (0.16 * boundsDiag(frameBounds(frame))) / peak
  }, [pushResult, frame])
  const pushHinges = useMemo(
    () =>
      analysis === 'pushover' && pushResult?.ok && pushInfo
        ? pushResult.events.slice(0, pushInfo.hinges).map((e) => ({ node: e.node, sign: e.sign }))
        : null,
    [analysis, pushResult, pushInfo],
  )

  // The shape drawn on the canvas: a swinging eigenmode (modal/buckling), the
  // live transient/harmonic response, or the pushover mechanism.
  const isSwing = tab === 'frame' && (analysis === 'modal' || analysis === 'buckling') && !!selMode
  const drawShape: NodeDisp[] | null =
    analysis === 'response'
      ? respShape
      : analysis === 'harmonic'
        ? harmShape
        : analysis === 'pushover'
          ? pushInfo?.shape ?? null
          : analysis === 'seismic'
            ? seisShape
            : analysis === 'inelastic'
              ? inelShape
              : isSwing
                ? selMode!.shape
                : null
  const drawFactor =
    analysis === 'response' ||
    analysis === 'harmonic' ||
    analysis === 'pushover' ||
    analysis === 'seismic' ||
    analysis === 'inelastic'
      ? 1
      : modeT
  const shapeScale = analysis === 'pushover' ? pushScale : modeScale
  // Amber plastic-hinge glyphs: the pushover mechanism, or the hinges that have
  // yielded so far in the inelastic time-history at the current instant.
  const drawHinges = analysis === 'pushover' ? pushHinges : analysis === 'inelastic' ? inelHinges : null
  const isMode = tab === 'frame' && analysis !== 'static' && !!drawShape

  // Sinusoidally swing a mode shape (modal/buckling views).
  useEffect(() => {
    if (!isSwing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModeT(0)
      return
    }
    let raf = 0
    let t0 = 0
    const loop = (t: number) => {
      if (!t0) t0 = t
      setModeT(Math.sin(((t - t0) / 1000) * 2 * Math.PI * 0.5))
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isSwing, analysis, effModeIndex])

  // Continuum modal: swing the selected mode shape (phase fraction in [0,1)).
  useEffect(() => {
    const active = tab === 'continuum' && contAnalysis === 'modal' && contModePlaying
    if (!active) return
    let raf = 0
    let t0 = 0
    const loop = (t: number) => {
      if (!t0) t0 = t
      setContModeT((((t - t0) / 1000) * 0.6) % 1) // 0.6 Hz visual swing
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, contAnalysis, contModePlaying, contModeSel])

  // Seed the transient shape at t=0 whenever the model / result changes.
  useEffect(() => {
    respTimeRef.current = 0
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRespElapsed(0)
    setRespShape(transientResult?.ok ? evalTransient(transientResult, respZeta, 0) : null)
    // respZeta intentionally excluded — at t=0 the shape is damping-independent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transientResult])

  // Advance the modal-superposition response in real (scaled) time.
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'response' && transientResult?.ok && respPlaying)) return
    const timeScale = Math.max(0.05, Math.min(2, 1.5 / Math.max(transientResult.dominantHz, 0.5)))
    let raf = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      respTimeRef.current += dt * timeScale
      const t = respTimeRef.current
      setRespShape(evalTransient(transientResult, respZeta, t))
      setRespElapsed(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, transientResult, respPlaying, respZeta])

  const restartResponse = useCallback(() => {
    respTimeRef.current = 0
    setRespElapsed(0)
    if (transientResult?.ok) setRespShape(evalTransient(transientResult, respZeta, 0))
  }, [transientResult, respZeta])

  // Reset the drive frequency to the fundamental resonance whenever the model /
  // analysis changes, so switching to Harmonic lands on a dramatic peak.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (harmPrep?.ok) setDriveHz(harmPrep.fundamentalHz)
  }, [harmPrep])

  // Seed a static harmonic shape at phase 0 when the model / drive / damping
  // changes, so a shape is drawn even while paused.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHarmShape(harmPrep?.ok ? harmonicShape(harmPrep, harmZeta, driveHz * 2 * Math.PI, 0, driveType).shape : null)
  }, [harmPrep, driveHz, harmZeta, driveType])

  // Animate the steady-state oscillation by sweeping the phase θ at a fixed,
  // watchable visual rate (the true drive frequency is arbitrary here — the
  // complex amplitude U at ω is fixed; θ just cycles it through a period).
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'harmonic' && harmPrep?.ok && harmPlaying)) return
    const driveOmega = driveHz * 2 * Math.PI
    let raf = 0
    let last = 0
    let theta = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      theta += dt * 2 * Math.PI * 0.4 // ~0.4 Hz visual cycle
      setHarmShape(harmonicShape(harmPrep, harmZeta, driveOmega, theta, driveType).shape)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, harmPrep, harmPlaying, harmZeta, driveHz, driveType])

  // Seed the pushover scrub at the start (unloaded) when the model / result changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPushS(0)
  }, [pushResult])

  // Advance the pushover load-scrub in pseudo-time: sweep 0 → collapse, hold
  // briefly at the mechanism, then loop.
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'pushover' && pushResult?.ok && pushPlaying)) return
    const n = pushResult.curve.length - 1
    if (n <= 0) return
    let raf = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      setPushS((s) => {
        const ns = s + dt * (n / 3.5) // full sweep in ~3.5 s
        return ns >= n + 0.7 ? 0 : ns // brief hold at collapse, then restart
      })
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, pushResult, pushPlaying])

  // Seed the seismic shape at t=0 whenever the model / record / damping changes.
  useEffect(() => {
    seisTimeRef.current = 0
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSeisElapsed(0)
    setSeisShape(seismicResult?.ok ? seismicShape(seismicResult, 0) : null)
  }, [seismicResult])

  // Play the earthquake in real time: march the stored time-history, expanding
  // the relative shape + ground sway at each instant, looping at the record end.
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'seismic' && seismicResult?.ok && seisPlaying)) return
    const dur = seismicResult.nSteps * seismicResult.dt
    let raf = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      seisTimeRef.current += dt
      if (seisTimeRef.current >= dur) seisTimeRef.current = 0
      const t = seisTimeRef.current
      const idx = Math.min(seismicResult.nSteps - 1, Math.round(t / seismicResult.dt))
      setSeisShape(seismicShape(seismicResult, idx))
      setSeisElapsed(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, seismicResult, seisPlaying])

  const scrubSeismic = useCallback(
    (t: number) => {
      if (!seismicResult?.ok) return
      setSeisPlaying(false)
      seisTimeRef.current = t
      setSeisElapsed(t)
      const idx = Math.min(seismicResult.nSteps - 1, Math.max(0, Math.round(t / seismicResult.dt)))
      setSeisShape(seismicShape(seismicResult, idx))
    },
    [seismicResult],
  )
  const restartSeismic = useCallback(() => {
    seisTimeRef.current = 0
    setSeisElapsed(0)
    if (seismicResult?.ok) setSeisShape(seismicShape(seismicResult, 0))
  }, [seismicResult])

  // Set both the deflected shape and the yielded-hinge glyphs at a stored step.
  const setInelFrame = useCallback((res: InelasticResult, idx: number) => {
    setInelShape(inelasticShape(res, idx))
    setInelHinges(inelasticHinges(res, idx))
  }, [])

  // Seed the inelastic shape at t=0 whenever the model / record / knobs change.
  useEffect(() => {
    inelTimeRef.current = 0
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInelElapsed(0)
    if (inelasticResult?.ok) setInelFrame(inelasticResult, 0)
    else {
      setInelShape(null)
      setInelHinges([])
    }
  }, [inelasticResult, setInelFrame])

  // Play the inelastic time-history: the frame rides the quake carrying its
  // permanent (residual) drift, and amber hinges pop in as sections yield.
  useEffect(() => {
    if (!(tab === 'frame' && analysis === 'inelastic' && inelasticResult?.ok && inelPlaying)) return
    const dur = inelasticResult.nSteps * inelasticResult.dt
    let raf = 0
    let last = 0
    const loop = (ts: number) => {
      if (!last) last = ts
      const dt = Math.min(0.05, (ts - last) / 1000)
      last = ts
      inelTimeRef.current += dt
      if (inelTimeRef.current >= dur) inelTimeRef.current = 0
      const t = inelTimeRef.current
      const idx = Math.min(inelasticResult.nSteps - 1, Math.round(t / inelasticResult.dt))
      setInelFrame(inelasticResult, idx)
      setInelElapsed(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [tab, analysis, inelasticResult, inelPlaying, setInelFrame])

  const scrubInelastic = useCallback(
    (t: number) => {
      if (!inelasticResult?.ok) return
      setInelPlaying(false)
      inelTimeRef.current = t
      setInelElapsed(t)
      const idx = Math.min(inelasticResult.nSteps - 1, Math.max(0, Math.round(t / inelasticResult.dt)))
      setInelFrame(inelasticResult, idx)
    },
    [inelasticResult, setInelFrame],
  )
  const restartInelastic = useCallback(() => {
    inelTimeRef.current = 0
    setInelElapsed(0)
    if (inelasticResult?.ok) setInelFrame(inelasticResult, 0)
  }, [inelasticResult, setInelFrame])

  // --- auto deformation scale ----------------------------------------------
  const autoScale = useMemo(() => {
    if (tab === 'frame' && frameResult && frameResult.maxDisp > 0) {
      return (0.12 * boundsDiag(frameBounds(frame))) / frameResult.maxDisp
    }
    if (tab === 'continuum' && activeContBounds) {
      const md = quadResult?.maxDisp ?? contResult?.maxDisp ?? 0
      if (md > 0) return (0.1 * boundsDiag(activeContBounds)) / md
    }
    return 1
  }, [tab, frameResult, contResult, quadResult, frame, activeContBounds])
  const effectiveDeform = (display.autoDeform ? autoScale : 1) * display.deformScale

  // --- fit view when the model changes -------------------------------------
  const currentBounds = useMemo<Bounds>(() => {
    if (tab === 'frame') return frameBounds(frame)
    return activeContBounds ?? { minX: 0, maxX: 1, minY: 0, maxY: 1 }
  }, [tab, frame, activeContBounds])

  const fitToModel = useCallback(() => {
    setView(fitView(currentBounds, size.w, size.h))
  }, [currentBounds, size])

  // Re-fit on tab / preset switch and first sizing.
  const fitKey = tab === 'frame' ? 'frame' : `cont:${contId}:${elemOrder}`
  const lastFitKey = useRef('')
  useEffect(() => {
    if (view === null || lastFitKey.current !== fitKey) {
      if (size.w > 0) {
        // Syncing the camera to the canvas/model size — a legitimate external sync.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setView(fitView(currentBounds, size.w, size.h))
        lastFitKey.current = fitKey
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, size.w, size.h])

  // --- canvas sizing --------------------------------------------------------
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // --- persistence ----------------------------------------------------------
  useEffect(() => {
    const scene: Scene = {
      version: 1,
      tab,
      frame,
      continuum: { presetId: contId, density, elemOrder },
      display,
    }
    saveLocal(scene)
    writeHash(scene)
  }, [tab, frame, contId, density, elemOrder, display])

  // --- draw -----------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !view) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = size.w * dpr
    canvas.height = size.h * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (tab === 'frame') {
      drawFrame(ctx, size.w, size.h, frame, isMode ? null : frameResult, {
        view,
        deformScale: isMode ? shapeScale : effectiveDeform,
        loadFactor: isMode ? drawFactor : loadFactor,
        showUndeformed: display.showUndeformed,
        colorBy: display.colorBy,
        colormap: display.colormap,
        showLoads: display.showLoads,
        showReactions: display.showReactions,
        showLabels: display.showLabels,
        hover,
        selected: sel,
        editing: tool !== 'select',
        pendingNode,
        modeShape: isMode ? drawShape : null,
        hinges: drawHinges,
      })
    } else if (quadInput) {
      const modalActive = contAnalysis === 'modal' && contMode !== null
      // Mode animation: scale the (unit-peak) shape by a smooth sinusoid.
      const modeAmp = modalActive
        ? 0.12 * boundsDiag(quadBounds(quadInput)) * Math.sin(2 * Math.PI * contModeT)
        : 0
      drawQuadContinuum(ctx, size.w, size.h, quadInput.mesh, modalActive ? null : quadResult, {
        view,
        deformScale: modalActive ? modeAmp : effectiveDeform,
        loadFactor: modalActive ? 1 : loadFactor,
        showMesh: display.showMesh,
        showUndeformed: display.showUndeformed,
        colormap: display.colormap,
        field: display.field,
        overrideDisp: modalActive ? contMode : null,
        colorByDisp: modalActive,
        tractionEdge: modalActive ? undefined : quadInput.traction?.edge,
        tractionDir: quadInput.traction,
        fixedEdges: quadInput.fix.map((f) => f.edge).filter((e): e is NonNullable<typeof e> => !!e),
      })
    } else if (contInput) {
      drawContinuum(ctx, size.w, size.h, contInput.mesh, contResult, {
        view,
        deformScale: effectiveDeform,
        loadFactor,
        showMesh: display.showMesh,
        showUndeformed: display.showUndeformed,
        colormap: display.colormap,
        field: display.field,
        tractionEdge: contInput.traction?.edge,
        tractionDir: contInput.traction,
        fixedEdges: contInput.fix.map((f) => f.edge).filter((e): e is NonNullable<typeof e> => !!e),
      })
    }
  }, [
    view, size, tab, frame, frameResult, contInput, contResult, quadInput, quadResult,
    contAnalysis, contMode, contModeT, display, hover, sel, tool,
    pendingNode, loadFactor, effectiveDeform, isMode, shapeScale, drawShape, drawFactor, drawHinges,
  ])

  // --- pointer interaction --------------------------------------------------
  const drag = useRef<{ mode: 'pan' | 'node'; nodeIdx?: number; lastX: number; lastY: number } | null>(
    null,
  )
  const toScreen = useCallback(
    (x: number, y: number): [number, number] => (view ? worldToScreen(view, x, y) : [0, 0]),
    [view],
  )

  const localXY = (e: React.PointerEvent | React.WheelEvent): [number, number] => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!view) return
    canvasRef.current?.setPointerCapture(e.pointerId)
    const [sx, sy] = localXY(e)
    if (tab === 'continuum') {
      drag.current = { mode: 'pan', lastX: sx, lastY: sy }
      return
    }
    const [wx, wy] = screenToWorld(view, sx, sy)
    const nHit = pickNode(frame, toScreen, sx, sy)
    const mHit = nHit === null ? pickMember(frame, toScreen, sx, sy) : null

    // In modal/buckling view the model is read-only — select for inspection, pan.
    if (analysis !== 'static') {
      setSel(nHit !== null ? { type: 'node', index: nHit } : mHit !== null ? { type: 'member', index: mHit } : null)
      drag.current = { mode: 'pan', lastX: sx, lastY: sy }
      return
    }

    switch (tool) {
      case 'select':
        if (nHit !== null) {
          setSel({ type: 'node', index: nHit })
          drag.current = { mode: 'node', nodeIdx: nHit, lastX: sx, lastY: sy }
        } else {
          setSel(mHit !== null ? { type: 'member', index: mHit } : null)
          drag.current = { mode: 'pan', lastX: sx, lastY: sy }
        }
        break
      case 'node': {
        const nm = addNode(frame, snap(wx), snap(wy))
        setFrame(nm)
        setSel({ type: 'node', index: nm.nodes.length - 1 })
        break
      }
      case 'member':
        if (nHit !== null) {
          if (pendingNode === null) setPendingNode(nHit)
          else {
            setFrame(addMember(frame, pendingNode, nHit))
            setPendingNode(null)
          }
        }
        break
      case 'support':
        if (nHit !== null) setFrame(cycleSupport(frame, nHit))
        break
      case 'load':
        if (nHit !== null) {
          const l = getLoad(frame, nHit)
          setFrame(setLoad(frame, nHit, l.fx, l.fy - 10000, l.mz))
          setSel({ type: 'node', index: nHit })
        }
        break
      case 'delete':
        if (nHit !== null) {
          setFrame(deleteNode(frame, nHit))
          setSel(null)
        } else if (mHit !== null) {
          setFrame(deleteMember(frame, mHit))
          setSel(null)
        }
        break
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!view) return
    const [sx, sy] = localXY(e)
    const d = drag.current
    if (d) {
      if (d.mode === 'pan') {
        setView((v) => (v ? pan(v, sx - d.lastX, sy - d.lastY) : v))
      } else if (d.mode === 'node' && d.nodeIdx !== undefined) {
        const [wx, wy] = screenToWorld(view, sx, sy)
        setFrame((f) => moveNode(f, d.nodeIdx!, snap(wx, 0.25), snap(wy, 0.25)))
      }
      d.lastX = sx
      d.lastY = sy
      return
    }
    if (tab === 'frame') {
      const nHit = pickNode(frame, toScreen, sx, sy)
      const mHit = nHit === null ? pickMember(frame, toScreen, sx, sy) : null
      setHover(nHit !== null ? { type: 'node', index: nHit } : mHit !== null ? { type: 'member', index: mHit } : null)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    canvasRef.current?.releasePointerCapture(e.pointerId)
    drag.current = null
  }

  const onWheel = (e: React.WheelEvent) => {
    if (!view) return
    const [sx, sy] = localXY(e)
    const factor = Math.exp(-e.deltaY * 0.0015)
    setView(zoomAt(view, sx, sy, factor))
  }

  // --- load-factor animation ------------------------------------------------
  const animate = () => {
    setLoadFactor(0)
    const t0 = performance.now()
    const dur = 1100
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      setLoadFactor(eased)
      if (k < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }

  const loadPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)
    if (!p) return
    setSel(null)
    setPendingNode(null)
    setHover(null)
    if (p.kind === 'frame') {
      setTab('frame')
      setFrame(cloneFrame(p.model))
      lastFitKey.current = '' // force refit
    } else {
      setTab('continuum')
      setContId(id)
    }
    setLoadFactor(1)
  }

  const patchDisplay = (patch: Partial<Display>) => setDisplay((d) => ({ ...d, ...patch }))

  // --- selected-element editors --------------------------------------------
  const updateMember = (i: number, patch: Partial<FrameModel['members'][number]>) => {
    setFrame((f) => {
      const next = cloneFrame(f)
      next.members[i] = { ...next.members[i], ...patch }
      return next
    })
  }

  const framePresets = PRESETS.filter((p): p is FramePreset => p.kind === 'frame')
  const contPresets = PRESETS.filter((p): p is ContinuumPreset => p.kind === 'continuum')

  const activeTool = TOOLS.find((t) => t.id === tool)!

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▚</span>
          <div>
            <div className="title">Keystone</div>
            <div className="subtitle">structural finite-element studio</div>
          </div>
        </div>
        <div className="tabs">
          <Segmented<Tab>
            options={[
              { value: 'frame', label: 'Trusses & Frames' },
              { value: 'continuum', label: '2-D Continuum' },
              { value: 'topopt', label: 'Topology Optimization' },
              { value: 'thermal', label: 'Thermal & Multiphysics' },
              { value: 'fracture', label: 'Fracture Mechanics' },
            ]}
            value={tab}
            onChange={(v) => {
              setTab(v)
              setSel(null)
            }}
          />
        </div>
        <VerifyBadge />
      </header>

      <div className="body">
        {tab === 'topopt' ? (
          <TopOptStudio />
        ) : tab === 'thermal' ? (
          <ThermalStudio />
        ) : tab === 'fracture' ? (
          <FractureStudio />
        ) : (
          <>
        {/* ---------------- left rail: presets ---------------- */}
        <aside className="rail left">
          <div className="panel">
            <div className="panel-title">Model library</div>
            <div className="preset-group">Trusses &amp; frames</div>
            {framePresets.map((p) => (
              <button key={p.id} className="preset" onClick={() => loadPreset(p.id)}>
                <div className="preset-name">{p.name}</div>
                <div className="preset-blurb">{p.blurb}</div>
              </button>
            ))}
            <div className="preset-group">2-D continuum parts</div>
            {contPresets.map((p) => (
              <button
                key={p.id}
                className={`preset ${tab === 'continuum' && contId === p.id ? 'active' : ''}`}
                onClick={() => loadPreset(p.id)}
              >
                <div className="preset-name">{p.name}</div>
                <div className="preset-blurb">{p.blurb}</div>
              </button>
            ))}
          </div>
        </aside>

        {/* ---------------- center: canvas ---------------- */}
        <main className="stage">
          {tab === 'frame' && analysis === 'static' && (
            <div className="toolbar">
              {TOOLS.map((t) => (
                <button
                  key={t.id}
                  className={`tool ${tool === t.id ? 'active' : ''}`}
                  title={t.hint}
                  onClick={() => {
                    setTool(t.id)
                    setPendingNode(null)
                  }}
                >
                  {t.label}
                </button>
              ))}
              <div className="tool-hint">{pendingNode !== null ? 'Pick the second joint…' : activeTool.hint}</div>
            </div>
          )}
          <div className="canvas-wrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              style={{ width: size.w, height: size.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => setHover(null)}
              onWheel={onWheel}
            />
            <div className="overlay-legend">
              {tab === 'frame' && isMode ? (
                <div className="legend force-legend">
                  <span className="chip" style={{ color: '#cfe0ff' }}>
                    {analysis === 'modal'
                      ? `mode ${effModeIndex + 1} · ${fmtEng(selMode!.hz, 'Hz')}`
                      : analysis === 'buckling'
                        ? `buckling mode ${effModeIndex + 1} · λ = ${selMode!.loadFactor.toFixed(2)}`
                        : analysis === 'harmonic'
                          ? `${driveType} · f = ${fmtEng(driveHz, 'Hz')} · ${
                              driveType === 'base'
                                ? `TR = ${(harmInfo?.mag ?? 0).toFixed(2)}`
                                : `${(harmInfo?.amplification ?? 1).toFixed(1)}× ${driveType === 'unbalance' ? 'high-speed' : 'static'}`
                            }`
                          : analysis === 'pushover'
                            ? `pushover · λ = ${(pushInfo?.lambda ?? 0).toFixed(2)} · ${pushInfo?.hinges ?? 0}/${pushResult?.events.length ?? 0} hinges${
                                (pushInfo?.hinges ?? 0) >= (pushResult?.events.length ?? -1) && pushResult?.collapse ? ' · collapse' : ''
                              }`
                            : analysis === 'seismic'
                              ? `earthquake · ${fmtEng(seisPga * 9.80665, 'm/s²')} PGA · roof ${fmtEng(seismicResult?.peakRoof ?? 0, 'm')} · t = ${seisElapsed.toFixed(1)} s`
                              : analysis === 'inelastic'
                                ? `inelastic · μ = ${(inelasticResult?.ductility ?? 0).toFixed(1)} · ${inelHinges.length}/${inelasticResult?.nHingesYielded ?? 0} hinges · t = ${inelElapsed.toFixed(1)} s`
                                : `response · ζ = ${(respZeta * 100).toFixed(0)}% · t = ${respElapsed.toFixed(2)} s`}
                  </span>
                </div>
              ) : tab === 'frame' ? (
                display.colorBy === 'force' ? (
                  <div className="legend force-legend">
                    <span className="chip comp">■ compression</span>
                    <span className="chip tens">■ tension</span>
                  </div>
                ) : (
                  frameResult && (
                    <Legend colormap={display.colormap} min={0} max={frameResult.maxStress} unit="Pa" label="fibre stress" />
                  )
                )
              ) : (
                contResult && (
                  <Legend
                    colormap={display.colormap}
                    min={display.field === 'vm' ? contResult.minVonMises : 0}
                    max={display.field === 'vm' ? contResult.maxVonMises : contResult.maxDisp}
                    unit={display.field === 'vm' ? 'Pa' : 'm'}
                    label={display.field === 'vm' ? 'von Mises stress' : 'displacement'}
                  />
                )
              )}
            </div>
            <div className="overlay-controls">
              <button className="ghost-btn" onClick={fitToModel} title="Fit model to view">
                ⤢ Fit
              </button>
              {!isMode && (
                <button className="ghost-btn" onClick={animate} title="Ramp the load from zero">
                  ▶ Animate
                </button>
              )}
            </div>
            <HoverTip
              tab={tab}
              hover={hover}
              frame={frame}
              frameResult={frameResult}
              toScreen={toScreen}
            />
          </div>
        </main>

        {/* ---------------- right rail: controls + results ---------------- */}
        <aside className="rail right">
          {tab === 'frame' && (
            <div className="panel">
              <div className="panel-title">Analysis</div>
              <Segmented<FrameAnalysis>
                options={[
                  { value: 'static', label: 'Static' },
                  { value: 'modal', label: 'Modal' },
                  { value: 'buckling', label: 'Buckling' },
                  { value: 'response', label: 'Response' },
                  { value: 'harmonic', label: 'Harmonic' },
                  { value: 'pushover', label: 'Pushover' },
                  { value: 'seismic', label: 'Seismic' },
                  { value: 'inelastic', label: 'Inelastic' },
                ]}
                value={analysis}
                onChange={(v) => {
                  patchDisplay({ analysis: v })
                  setModeIndex(0)
                  setSel(null)
                  setTool('select')
                  setRespPlaying(true)
                  setHarmPlaying(true)
                  setPushPlaying(true)
                  setPushS(0)
                  setSeisPlaying(true)
                  setInelPlaying(true)
                }}
              />
              <p className="hint-text">
                {analysis === 'static'
                  ? 'Deflections, member forces and reactions under the applied load.'
                  : analysis === 'modal'
                    ? 'Free-vibration natural frequencies and mode shapes: K φ = ω² M φ.'
                    : analysis === 'buckling'
                      ? 'Linearized (Euler) buckling load factors and modes: (K + λ K_g) φ = 0.'
                      : analysis === 'response'
                        ? 'Transient response: the structure released from its static deflection, rung down by modal superposition Σ φᵢ qᵢ(t).'
                        : analysis === 'harmonic'
                          ? 'Forced harmonic response: drive with F·cos ωt and sweep ω to trace the frequency-response function u(ω) = Σ φᵢ(φᵢᵀF)/(ωᵢ²−ω²+2iζωᵢω).'
                          : analysis === 'seismic'
                            ? 'Seismic time-history: shake the base with a ground motion and integrate M ü + C u̇ + K u = −M ι a_g(t) by Newmark-β, plus the elastic response spectrum.'
                            : analysis === 'inelastic'
                              ? 'Inelastic time-history: members yield at bilinear plastic hinges and M ü + C u̇ + f_s(u) = −M ι a_g(t) is solved by Newmark-β with Newton–Raphson — hysteresis loops, ductility, residual drift and the R factor.'
                              : 'Nonlinear pushover: increase the load, forming plastic hinges (Mₚ = Z·Fᵧ) until the frame becomes a mechanism. The collapse load factor is exact plastic limit analysis.'}
              </p>
            </div>
          )}
          <div className="panel">
            <div className="panel-title">Display</div>
            <Slider
              label="Deformation ×"
              min={0}
              max={3}
              step={0.05}
              value={display.deformScale}
              onChange={(v) => patchDisplay({ deformScale: v })}
              format={(v) => `${v.toFixed(2)}×`}
            />
            <Toggle
              label="Auto-scale deflection"
              checked={display.autoDeform}
              onChange={(v) => patchDisplay({ autoDeform: v })}
            />
            <Toggle
              label="Show undeformed ghost"
              checked={display.showUndeformed}
              onChange={(v) => patchDisplay({ showUndeformed: v })}
            />
            {tab === 'frame' ? (
              <>
                <div className="field-label">Colour members by</div>
                <Segmented
                  options={[
                    { value: 'force', label: 'Tension / Compression' },
                    { value: 'stress', label: 'Fibre stress' },
                  ]}
                  value={display.colorBy}
                  onChange={(v) => patchDisplay({ colorBy: v })}
                />
                <Toggle label="Load arrows" checked={display.showLoads} onChange={(v) => patchDisplay({ showLoads: v })} />
                <Toggle
                  label="Reaction arrows"
                  checked={display.showReactions}
                  onChange={(v) => patchDisplay({ showReactions: v })}
                />
                <Toggle label="Force labels" checked={display.showLabels} onChange={(v) => patchDisplay({ showLabels: v })} />
              </>
            ) : (
              <>
                <div className="field-label">Element formulation</div>
                <Segmented
                  options={[
                    { value: 'cst', label: 'CST' },
                    { value: 'q4', label: 'Q4' },
                    { value: 'q8', label: 'Q8' },
                  ]}
                  value={elemOrder}
                  onChange={(v) => setElemOrder(v as ElemOrder)}
                />
                {useQuad && (
                  <>
                    <div className="field-label">Continuum analysis</div>
                    <Segmented
                      options={[
                        { value: 'static', label: 'Static' },
                        { value: 'modal', label: 'Modes' },
                      ]}
                      value={contAnalysis}
                      onChange={(v) => patchDisplay({ contAnalysis: v as 'static' | 'modal' })}
                    />
                  </>
                )}
                {useQuad && contAnalysis === 'modal' && contModeCount > 0 && (
                  <>
                    <div className="field-label">Mode</div>
                    <Segmented
                      options={quadModal!.modes.map((_, i) => ({
                        value: String(i),
                        label: `${i + 1}`,
                      }))}
                      value={String(contModeSel)}
                      onChange={(v) => setContModeIdx(Number(v))}
                    />
                    <Toggle
                      label="Animate mode"
                      checked={contModePlaying}
                      onChange={setContModePlaying}
                    />
                  </>
                )}
                <div className="field-label">Field</div>
                <Segmented
                  options={[
                    { value: 'vm', label: 'von Mises' },
                    { value: 'disp', label: 'Displacement' },
                  ]}
                  value={display.field}
                  onChange={(v) => patchDisplay({ field: v })}
                />
                <div className="field-label">Colour map</div>
                <Segmented
                  options={[
                    { value: 'turbo', label: 'Turbo' },
                    { value: 'viridis', label: 'Viridis' },
                    { value: 'grayscale', label: 'Gray' },
                  ]}
                  value={display.colormap}
                  onChange={(v) => patchDisplay({ colormap: v })}
                />
                <Toggle label="Mesh edges" checked={display.showMesh} onChange={(v) => patchDisplay({ showMesh: v })} />
                <Slider
                  label="Mesh density"
                  min={0.5}
                  max={2}
                  step={0.1}
                  value={density}
                  onChange={setDensity}
                  format={(v) => `${v.toFixed(1)}×`}
                />
              </>
            )}
          </div>

          {tab === 'frame' ? (
            analysis === 'static' ? (
              <FrameResults result={frameResult} model={frame} />
            ) : analysis === 'modal' ? (
              <ModalPanel
                result={modalResult}
                model={frame}
                selected={effModeIndex}
                onSelect={setModeIndex}
              />
            ) : analysis === 'buckling' ? (
              <BucklingPanel
                result={bucklingResult}
                selected={effModeIndex}
                onSelect={setModeIndex}
              />
            ) : analysis === 'response' ? (
              <ResponsePanel
                result={transientResult}
                zeta={respZeta}
                onZeta={(v) => patchDisplay({ respZeta: v })}
                playing={respPlaying}
                onPlay={setRespPlaying}
                onRestart={restartResponse}
                elapsed={respElapsed}
              />
            ) : analysis === 'pushover' ? (
              <PushoverPanel
                result={pushResult}
                info={pushInfo}
                playing={pushPlaying}
                onPlay={setPushPlaying}
                onScrub={(s) => {
                  setPushPlaying(false)
                  setPushS(s)
                }}
                secondOrder={pushSecondOrder}
                onSecondOrder={(v) => patchDisplay({ pushSecondOrder: v })}
              />
            ) : analysis === 'seismic' ? (
              <SeismicPanel
                result={seismicResult}
                record={seisRecord}
                onRecord={(v) => patchDisplay({ seisRecord: v })}
                pga={seisPga}
                onPga={(v) => patchDisplay({ seisPga: v })}
                zeta={seisZeta}
                onZeta={(v) => patchDisplay({ seisZeta: v })}
                playing={seisPlaying}
                onPlay={setSeisPlaying}
                onRestart={restartSeismic}
                onScrub={scrubSeismic}
                elapsed={seisElapsed}
              />
            ) : analysis === 'inelastic' ? (
              <InelasticPanel
                result={inelasticResult}
                record={seisRecord}
                onRecord={(v) => patchDisplay({ seisRecord: v })}
                pga={seisPga}
                onPga={(v) => patchDisplay({ seisPga: v })}
                zeta={seisZeta}
                onZeta={(v) => patchDisplay({ seisZeta: v })}
                alpha={inelAlpha}
                onAlpha={(v) => patchDisplay({ inelAlpha: v })}
                strength={inelStrength}
                onStrength={(v) => patchDisplay({ inelStrength: v })}
                playing={inelPlaying}
                onPlay={setInelPlaying}
                onRestart={restartInelastic}
                onScrub={scrubInelastic}
                elapsed={inelElapsed}
              />
            ) : (
              <HarmonicPanel
                prep={harmPrep}
                curve={frf}
                driveHz={driveHz}
                onDriveHz={setDriveHz}
                zeta={harmZeta}
                onZeta={(v) => patchDisplay({ harmZeta: v })}
                playing={harmPlaying}
                onPlay={setHarmPlaying}
                info={harmInfo}
                driveType={driveType}
                onDriveType={(v) => patchDisplay({ driveType: v })}
              />
            )
          ) : quadInput ? (
            <QuadResults
              result={quadResult}
              input={quadInput}
              order={elemOrder === 'q8' ? 8 : 4}
              analysis={contAnalysis}
              modal={quadModal}
              selectedMode={contModeSel}
              onSelectMode={setContModeIdx}
            />
          ) : (
            <ContinuumResults result={contResult} input={contInput} />
          )}

          {tab === 'frame' && sel && (
            <SelectionEditor
              sel={sel}
              model={frame}
              result={frameResult}
              onSupport={(i, s) => setFrame(setSupport(frame, i, s))}
              onLoad={(i, fx, fy, mz) => setFrame(setLoad(frame, i, fx, fy, mz))}
              onMember={updateMember}
              onDeleteNode={(i) => {
                setFrame(deleteNode(frame, i))
                setSel(null)
              }}
              onDeleteMember={(i) => {
                setFrame(deleteMember(frame, i))
                setSel(null)
              }}
            />
          )}

          <div className="panel">
            <div className="panel-title">Scene</div>
            <div className="btn-row">
              <button className="ghost-btn" onClick={() => downloadJSON({ version: 1, tab, frame, continuum: { presetId: contId, density }, display })}>
                ⭳ Export JSON
              </button>
              <button
                className="ghost-btn"
                onClick={() => {
                  try {
                    navigator.clipboard?.writeText(location.href)
                  } catch {
                    /* ignore */
                  }
                }}
              >
                🔗 Copy link
              </button>
            </div>
            <p className="hint-text">Models autosave locally and encode into the URL — copy the link to share this exact structure.</p>
          </div>
        </aside>
          </>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ subpanels

function HoverTip({
  tab,
  hover,
  frame,
  frameResult,
  toScreen,
}: {
  tab: Tab
  hover: Picked | null
  frame: FrameModel
  frameResult: FrameResult | null
  toScreen: (x: number, y: number) => [number, number]
}) {
  if (tab !== 'frame' || !hover || !frameResult) return null
  let x: number
  let y: number
  let body: React.ReactNode
  if (hover.type === 'node') {
    const n = frame.nodes[hover.index]
    const d = frameResult.nodeDisp[hover.index]
    ;[x, y] = toScreen(n.x, n.y)
    body = (
      <>
        <div className="tip-title">Joint {hover.index}</div>
        <div>δ {fmtEng(Math.hypot(d.ux, d.uy), 'm')}</div>
        <div>support: {n.support}</div>
      </>
    )
  } else {
    const m = frame.members[hover.index]
    const r = frameResult.members[hover.index]
    const a = frame.nodes[m.a]
    const b = frame.nodes[m.b]
    ;[x, y] = toScreen((a.x + b.x) / 2, (a.y + b.y) / 2)
    body = (
      <>
        <div className="tip-title">Member {hover.index}</div>
        <div className={r.axial >= 0 ? 'tens' : 'comp'}>
          {r.axial >= 0 ? 'tension' : 'compression'} {fmtEng(Math.abs(r.axial), 'N')}
        </div>
        <div>σ {fmtEng(r.maxFiberStress, 'Pa')}</div>
        {frame.type === 'frame' && <div>M {fmtEng(Math.max(Math.abs(r.momentA), Math.abs(r.momentB)), 'N·m')}</div>}
      </>
    )
  }
  return (
    <div className="hovertip" style={{ left: x + 12, top: y + 12 }}>
      {body}
    </div>
  )
}

function FrameResults({ result, model }: { result: FrameResult | null; model: FrameModel }) {
  if (!result) return null
  const topMembers = model.members
    .map((_, i) => i)
    .sort((a, b) => Math.abs(result.members[b].axial) - Math.abs(result.members[a].axial))
    .slice(0, 6)
  return (
    <div className="panel">
      <div className="panel-title">
        Results
        <span className={result.stable ? 'badge good' : 'badge warn'}>
          {result.stable ? 'stable' : 'unstable / mechanism'}
        </span>
      </div>
      <div className="stat-grid">
        <StatTile label="Max deflection" value={fmtEng(result.maxDisp, 'm')} />
        <StatTile label="Max axial" value={fmtEng(result.maxAxial, 'N')} />
        <StatTile label="Max fibre stress" value={fmtEng(result.maxStress, 'Pa')} />
        <StatTile
          label="Max utilisation"
          value={`${(result.maxUtilization * 100).toFixed(0)}%`}
          sub={result.maxUtilization > 1 ? 'over-stressed' : 'σ/σ_yield'}
        />
        <StatTile label="Equilibrium" value={result.equilibriumResidual.toExponential(1)} sub="‖Ku−f‖/‖f‖" />
        <StatTile label="DOF" value={`${model.nodes.length * result.dofPerNode}`} sub={`${result.iterations} CG iters`} />
      </div>
      <div className="table-title">Reactions</div>
      <div className="mini-table">
        <div className="mt-head">
          <span>joint</span>
          <span>Rx</span>
          <span>Ry</span>
          {result.dofPerNode === 3 && <span>M</span>}
        </div>
        {result.reactions.map((r) => (
          <div className="mt-row" key={r.node}>
            <span>{r.node}</span>
            <span>{fmtEng(r.fx, 'N')}</span>
            <span>{fmtEng(r.fy, 'N')}</span>
            {result.dofPerNode === 3 && <span>{fmtEng(r.mz, 'N·m')}</span>}
          </div>
        ))}
      </div>
      <div className="table-title">Highest-force members</div>
      <div className="mini-table">
        {topMembers.map((i) => {
          const r = result.members[i]
          return (
            <div className="mt-row wide" key={i}>
              <span>#{i}</span>
              <span className={r.axial >= 0 ? 'tens' : 'comp'}>
                {r.axial >= 0 ? '＋' : '－'}
                {fmtEng(Math.abs(r.axial), 'N')}
              </span>
              <span>{fmtEng(r.maxFiberStress, 'Pa')}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ContinuumResults({
  result,
  input,
}: {
  result: ContinuumResult | null
  input: ContinuumInput | null
}) {
  if (!result || !input) return null
  return (
    <div className="panel">
      <div className="panel-title">
        Results
        <span className={result.stable ? 'badge good' : 'badge warn'}>{result.stable ? 'converged' : 'check'}</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Max von Mises" value={fmtEng(result.maxVonMises, 'Pa')} />
        <StatTile label="Max displacement" value={fmtEng(result.maxDisp, 'm')} />
        <StatTile label="Strain energy" value={fmtEng(result.strainEnergy, 'J')} />
        <StatTile label="Elements" value={`${input.mesh.triCount}`} sub={`${input.mesh.nodeCount} nodes`} />
        <StatTile label="Equilibrium" value={result.equilibriumResidual.toExponential(1)} sub="‖Ku−f‖/‖f‖" />
        <StatTile label="Solver" value={`${result.iterations}`} sub="PCG iters" />
      </div>
      <p className="hint-text">
        Constant-strain triangles ⇒ stress is uniform within each element (shown flat). Refine the
        mesh density to sharpen gradients near concentrations. Switch the element formulation to Q4
        or Q8 for higher-order accuracy and a smooth recovered stress field.
      </p>
    </div>
  )
}

function QuadResults({
  result,
  input,
  order,
  analysis,
  modal,
  selectedMode,
  onSelectMode,
}: {
  result: QuadResult | null
  input: QuadInput
  order: 4 | 8
  analysis: 'static' | 'modal'
  modal: QuadModalResult | null
  selectedMode: number
  onSelectMode: (i: number) => void
}) {
  const label = order === 8 ? 'Q8 (8-node serendipity)' : 'Q4 (bilinear)'
  if (analysis === 'modal') {
    const modes = modal?.modes ?? []
    return (
      <div className="panel">
        <div className="panel-title">
          Continuum modes
          <span className={modes.length > 0 ? 'badge good' : 'badge warn'}>
            {modes.length > 0 ? `${modes.length} found` : 'solving…'}
          </span>
        </div>
        {modes.length > 0 ? (
          <>
            <div className="stat-grid">
              <StatTile
                label="Fundamental"
                value={fmtEng(modes[0].frequency, 'Hz')}
                sub={`ω = ${fmtEng(modes[0].omega, 'rad/s')}`}
              />
              <StatTile label="Period" value={fmtEng(1 / modes[0].frequency, 's')} />
              <StatTile label="Free DOF" value={`${modal?.freeDofCount ?? 0}`} sub={label} />
              <StatTile label="Elements" value={`${input.mesh.elemCount}`} sub={`${input.mesh.nodeCount} nodes`} />
            </div>
            <div className="table-title">Modes — click to animate</div>
            <div className="mode-list">
              {modes.map((md, i) => (
                <button
                  key={i}
                  className={`mode-row ${i === selectedMode ? 'active' : ''}`}
                  onClick={() => onSelectMode(i)}
                >
                  <span className="mode-idx">#{i + 1}</span>
                  <span className="mode-freq">{fmtEng(md.frequency, 'Hz')}</span>
                  <span className="mode-part">T = {fmtEng(1 / md.frequency, 's')}</span>
                </button>
              ))}
            </div>
            <p className="hint-text">
              Natural frequencies of the 2-D part from the consistent-mass eigenproblem
              K φ = ω² M φ, solved on the isoparametric mesh. The selected mode oscillates live.
            </p>
          </>
        ) : (
          <p className="hint-text">No modes — check the supports leave the part free to vibrate.</p>
        )}
      </div>
    )
  }
  if (!result) return null
  return (
    <div className="panel">
      <div className="panel-title">
        Results
        <span className={result.stable ? 'badge good' : 'badge warn'}>
          {result.stable ? 'converged' : 'check'}
        </span>
      </div>
      <div className="stat-grid">
        <StatTile label="Max von Mises" value={fmtEng(result.maxVonMises, 'Pa')} sub="recovered nodal" />
        <StatTile label="Max displacement" value={fmtEng(result.maxDisp, 'm')} />
        <StatTile label="Strain energy" value={fmtEng(result.strainEnergy, 'J')} />
        <StatTile label="Elements" value={`${input.mesh.elemCount}`} sub={`${input.mesh.nodeCount} nodes · ${label}`} />
        <StatTile label="Equilibrium" value={result.equilibriumResidual.toExponential(1)} sub="‖Ku−f‖/‖f‖" />
        <StatTile label="Solver" value={`${result.iterations}`} sub="PCG iters" />
      </div>
      <p className="hint-text">
        {order === 8
          ? 'Quadratic serendipity elements (3×3 Gauss) capture bending and curved stress gradients a CST cannot — a coarse mesh already matches beam theory to a fraction of a percent.'
          : 'Bilinear quads (2×2 Gauss) with a smooth recovered nodal-stress field. Refine the mesh (or switch to Q8) to overcome shear locking in bending.'}{' '}
        Stress is extrapolated from the superconvergent Gauss points and averaged to nodes for a
        continuous field.
      </p>
    </div>
  )
}

function ModalPanel({
  result,
  model,
  selected,
  onSelect,
}: {
  result: ModalResult | null
  model: FrameModel
  selected: number
  onSelect: (i: number) => void
}) {
  if (!result) return null
  if (!result.ok || result.modes.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Vibration modes</div>
        <p className="hint-text">{result.note ?? 'No modes available.'}</p>
      </div>
    )
  }
  const m0 = result.modes[0]
  return (
    <div className="panel">
      <div className="panel-title">
        Vibration modes
        <span className="badge good">{result.modes.length} found</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Fundamental" value={fmtEng(m0.hz, 'Hz')} sub={`ω = ${fmtEng(m0.omega, 'rad/s')}`} />
        <StatTile label="Period" value={fmtEng(1 / m0.hz, 's')} />
        <StatTile label="DOF" value={`${model.nodes.length * result.dofPerNode}`} />
        <StatTile label="Modal mass" value={fmtEng(result.totalMassX, 'kg')} sub="total" />
      </div>
      <div className="table-title">Modes — click to animate</div>
      <div className="mode-list">
        {result.modes.map((md, i) => (
          <button
            key={i}
            className={`mode-row ${i === selected ? 'active' : ''}`}
            onClick={() => onSelect(i)}
          >
            <span className="mode-idx">#{i + 1}</span>
            <span className="mode-freq">{fmtEng(md.hz, 'Hz')}</span>
            <span className="mode-part">{Math.round(100 * Math.max(md.massX, md.massY))}% mass</span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        Frequencies from the consistent-mass eigenproblem K φ = ω² M φ. The selected mode
        oscillates live on the canvas.
      </p>
    </div>
  )
}

function BucklingPanel({
  result,
  selected,
  onSelect,
}: {
  result: BucklingResult | null
  selected: number
  onSelect: (i: number) => void
}) {
  if (!result) return null
  if (!result.ok || result.modes.length === 0) {
    return (
      <div className="panel">
        <div className="panel-title">Buckling modes</div>
        <p className="hint-text">{result.note ?? 'No buckling modes available.'}</p>
      </div>
    )
  }
  const m0 = result.modes[0]
  const safe = m0.loadFactor > 1
  return (
    <div className="panel">
      <div className="panel-title">
        Buckling modes
        <span className={safe ? 'badge good' : 'badge warn'}>λ₁ = {m0.loadFactor.toFixed(2)}</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Critical factor λ₁" value={m0.loadFactor.toFixed(3)} sub="× applied load" />
        <StatTile label="P_cr (peak member)" value={fmtEng(result.referenceMaxAxial * m0.loadFactor, 'N')} sub="|N|ᵣₑ𝒻·λ₁" />
        <StatTile label="Modes" value={`${result.modes.length}`} />
        <StatTile
          label="Stability"
          value={safe ? 'stable' : 'buckles'}
          sub={safe ? 'λ₁ > 1 under load' : 'λ₁ < 1 — unstable'}
        />
      </div>
      <div className="table-title">Load factors — click to animate</div>
      <div className="mode-list">
        {result.modes.map((md, i) => (
          <button
            key={i}
            className={`mode-row ${i === selected ? 'active' : ''}`}
            onClick={() => onSelect(i)}
          >
            <span className="mode-idx">#{i + 1}</span>
            <span className="mode-freq">λ = {md.loadFactor.toFixed(3)}</span>
            <span className="mode-part">{fmtEng(result.referenceMaxAxial * md.loadFactor, 'N')}</span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        Load factor λ multiplies the applied load to reach instability, from (K + λ K_g) φ = 0
        with K_g built from the static axial-force field.
      </p>
    </div>
  )
}

function ResponsePanel({
  result,
  zeta,
  onZeta,
  playing,
  onPlay,
  onRestart,
  elapsed,
}: {
  result: TransientResult | null
  zeta: number
  onZeta: (v: number) => void
  playing: boolean
  onPlay: (v: boolean) => void
  onRestart: () => void
  elapsed: number
}) {
  if (!result) return null
  if (!result.ok) {
    return (
      <div className="panel">
        <div className="panel-title">Dynamic response</div>
        <p className="hint-text">{result.note ?? 'No response available.'}</p>
      </div>
    )
  }
  const wd = result.modes[0].omega * Math.sqrt(1 - zeta * zeta)
  return (
    <div className="panel">
      <div className="panel-title">
        Dynamic response
        <span className="badge good">{result.modes.length} modes</span>
      </div>
      <div className="stat-grid">
        <StatTile label="Dominant freq" value={fmtEng(result.dominantHz, 'Hz')} />
        <StatTile label="Damped period" value={fmtEng((2 * Math.PI) / wd, 's')} />
        <StatTile label="Elapsed" value={fmtEng(elapsed, 's')} />
        <StatTile label="Damping ζ" value={`${(zeta * 100).toFixed(1)}%`} />
      </div>
      <div className="btn-row">
        <button className="ghost-btn" onClick={() => onPlay(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="ghost-btn" onClick={onRestart}>
          ↺ Restart
        </button>
      </div>
      <Slider
        label="Damping ratio ζ"
        min={0}
        max={0.2}
        step={0.005}
        value={zeta}
        onChange={onZeta}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />
      <p className="hint-text">
        Released from the static deflection with zero velocity; each mode decays as e^(−ζωt).
        The motion is the superposition Σ φᵢ qᵢ(t) of all vibration modes.
      </p>
    </div>
  )
}

function HarmonicPanel({
  prep,
  curve,
  driveHz,
  onDriveHz,
  zeta,
  onZeta,
  playing,
  onPlay,
  info,
  driveType,
  onDriveType,
}: {
  prep: HarmonicPrep | null
  curve: FrfCurve | null
  driveHz: number
  onDriveHz: (hz: number) => void
  zeta: number
  onZeta: (v: number) => void
  playing: boolean
  onPlay: (v: boolean) => void
  info: { mag: number; phase: number; amplification: number } | null
  driveType: DriveType
  onDriveType: (v: DriveType) => void
}) {
  if (!prep) return null
  if (!prep.ok || !curve) {
    return (
      <div className="panel">
        <div className="panel-title">Forced harmonic response</div>
        <p className="hint-text">{prep.note ?? 'No harmonic response available.'}</p>
      </div>
    )
  }
  const driveMax = curve.omegaMax / (2 * Math.PI)
  const amp = info?.amplification ?? 1
  const isBase = driveType === 'base'
  const refWord = driveType === 'unbalance' ? 'high-speed' : 'static'
  const outLabel = `joint ${prep.outNode} ${prep.outDir}`
  const ampBadge = isBase ? `TR ${(info?.mag ?? 0).toFixed(2)}` : `${amp.toFixed(1)}× ${refWord}`
  const near = isBase ? (info?.mag ?? 0) > 1.2 : amp > 3
  const ordinate = isBase ? 'transmissibility X/Y' : `|U| at ${outLabel}`
  return (
    <div className="panel">
      <div className="panel-title">
        Forced harmonic response
        <span className={near ? 'badge warn' : 'badge good'}>{ampBadge}</span>
      </div>
      <div className="field-label">Drive</div>
      <Segmented<DriveType>
        options={[
          { value: 'force', label: 'Force' },
          { value: 'unbalance', label: 'Unbalance' },
          { value: 'base', label: 'Base' },
        ]}
        value={driveType}
        onChange={onDriveType}
      />
      <div className="stat-grid">
        <StatTile label="Drive frequency" value={fmtEng(driveHz, 'Hz')} sub={`ω = ${fmtEng(driveHz * 2 * Math.PI, 'rad/s')}`} />
        {isBase ? (
          <StatTile label="Transmissibility" value={`${(info?.mag ?? 0).toFixed(2)}×`} sub="X / Y" />
        ) : (
          <StatTile label="Output amplitude" value={fmtEng(info?.mag ?? 0, 'm')} sub={outLabel} />
        )}
        <StatTile label={isBase ? 'Isolation' : 'Amplification'} value={isBase ? ((info?.mag ?? 0) < 1 ? 'isolated' : 'amplified') : `${amp.toFixed(2)}×`} sub={isBase ? 'X<Y ⇒ isolated' : `vs. ${refWord}`} />
        <StatTile label="Fundamental" value={fmtEng(prep.fundamentalHz, 'Hz')} sub="1st resonance" />
        <StatTile label="Phase lag" value={`${Math.round((-(info?.phase ?? 0) * 180) / Math.PI)}°`} />
        <StatTile label="Damping ζ" value={`${(zeta * 100).toFixed(1)}%`} />
      </div>
      <div className="frf-wrap">
        <FrfPlot curve={curve} driveHz={driveHz} onPick={onDriveHz} />
        <div className="frf-caption">
          {ordinate} vs drive frequency · <span className="frf-key res">— resonance</span>{' '}
          <span className="frf-key drive">— drive</span> · click to set drive
        </div>
      </div>
      <div className="btn-row">
        <button className="ghost-btn" onClick={() => onPlay(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="ghost-btn" onClick={() => onDriveHz(prep.fundamentalHz)}>
          ⇈ Resonance
        </button>
      </div>
      <Slider
        label="Drive frequency"
        min={0}
        max={driveMax}
        step={Math.max(driveMax / 500, 1e-4)}
        value={Math.min(driveHz, driveMax)}
        onChange={onDriveHz}
        format={(v) => `${fmtEng(v, 'Hz')}`}
      />
      <Slider
        label="Damping ratio ζ"
        min={0.005}
        max={0.15}
        step={0.005}
        value={zeta}
        onChange={onZeta}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />
      <div className="table-title">Resonances — click to drive at peak</div>
      <div className="mode-list">
        {curve.peaks.map((p) => (
          <button
            key={p.modeIndex}
            className={`mode-row ${Math.abs(p.hz - driveHz) / p.hz < 0.02 ? 'active' : ''}`}
            onClick={() => onDriveHz(p.hz)}
          >
            <span className="mode-idx">#{p.modeIndex + 1}</span>
            <span className="mode-freq">{fmtEng(p.hz, 'Hz')}</span>
            <span className="mode-part">
              {isBase ? `TR ${p.amplification.toFixed(1)}` : `${p.amplification.toFixed(0)}× ${refWord}`}
            </span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        {driveType === 'base'
          ? 'Support (base) excitation: the ground shakes with unit amplitude Y and the plot is the transmissibility X/Y. Below √2·ωₙ the structure amplifies the motion; above it, it isolates (X < Y) — every damping curve passes through TR = 1 at ω = √2·ωₙ.'
          : driveType === 'unbalance'
            ? 'Rotating-mass unbalance: the shaking force grows as ω², so the response climbs from zero, peaks just past resonance, and levels off at the high-speed limit — the classic rotor run-up curve.'
            : prep.syntheticDrive
              ? 'No nodal load placed — a unit probe force drives the most responsive joint. Add a load to shape the forcing.'
              : 'Steady-state amplitude of the placed load oscillating as F·cos ωt. Each resonance peak is a mode driven at its natural frequency; its height is capped by damping (≈ 1/2ζ).'}
      </p>
    </div>
  )
}

function SeismicPanel({
  result,
  record,
  onRecord,
  pga,
  onPga,
  zeta,
  onZeta,
  playing,
  onPlay,
  onRestart,
  onScrub,
  elapsed,
}: {
  result: SeismicResult | null
  record: GroundRecord
  onRecord: (v: GroundRecord) => void
  pga: number
  onPga: (v: number) => void
  zeta: number
  onZeta: (v: number) => void
  playing: boolean
  onPlay: (v: boolean) => void
  onRestart: () => void
  onScrub: (t: number) => void
  elapsed: number
}) {
  if (!result) return null
  const g = result.ground
  const GG = 9.80665
  const timeOk = result.ok
  const saG = result.SaT1 / GG
  return (
    <div className="panel">
      <div className="panel-title">
        Seismic response
        <span className={saG > 0.5 ? 'badge warn' : 'badge good'}>{saG.toFixed(2)} g @ T₁</span>
      </div>
      <div className="field-label">Ground motion</div>
      <Segmented<GroundRecord>
        options={[
          { value: 'synthetic', label: 'Quake' },
          { value: 'pulse', label: 'Pulse' },
          { value: 'harmonic', label: 'Shaker' },
        ]}
        value={record}
        onChange={onRecord}
      />
      {timeOk ? (
        <div className="stat-grid">
          <StatTile label="Fundamental T₁" value={fmtEng(result.T1, 's')} sub={fmtEng(1 / (result.T1 || 1), 'Hz')} />
          <StatTile label="Spectral accel" value={`${saG.toFixed(2)} g`} sub="Sa(T₁)" />
          <StatTile label="Peak roof" value={fmtEng(result.peakRoof, 'm')} sub={`joint ${result.outNode} ${result.outDir}`} />
          <StatTile label="Peak drift" value={fmtEng(result.peakDrift, 'm')} sub="inter-level" />
          <StatTile label="Peak base shear" value={fmtEng(result.peakBaseShear, 'N')} />
          <StatTile label="PGA" value={`${(g.pga / GG).toFixed(2)} g`} sub={fmtEng(g.pga, 'm/s²')} />
          <StatTile label="PGV" value={fmtEng(g.pgv, 'm/s')} />
          <StatTile label="Damping ζ" value={`${(zeta * 100).toFixed(0)}%`} />
        </div>
      ) : (
        <p className="hint-text">{result.note ?? 'Time-history unavailable — the response spectrum is still shown below.'}</p>
      )}

      <div className="frf-wrap">
        <TimeSeriesPlot
          data={g.ag}
          dt={g.dt}
          cursorTime={elapsed}
          color="#f5a742"
          unit="m/s²"
          label="ground a(t)"
          onPick={onScrub}
        />
        {timeOk && result.roof.length > 0 && (
          <TimeSeriesPlot
            data={result.roof}
            dt={result.dt}
            cursorTime={elapsed}
            color="#6ea8ff"
            unit="m"
            label="roof drift"
            onPick={onScrub}
          />
        )}
        <div className="frf-caption">
          {g.name} · {g.duration.toFixed(0)} s · click a trace to scrub
        </div>
      </div>

      {timeOk && (
        <div className="btn-row">
          <button className="ghost-btn" onClick={() => onPlay(!playing)}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="ghost-btn" onClick={onRestart}>
            ↺ Restart
          </button>
        </div>
      )}

      <Slider
        label="Peak ground accel."
        min={0.05}
        max={1}
        step={0.05}
        value={pga}
        onChange={onPga}
        format={(v) => `${v.toFixed(2)} g`}
      />
      <Slider
        label="Damping ratio ζ"
        min={0.02}
        max={0.15}
        step={0.005}
        value={zeta}
        onChange={onZeta}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />

      <div className="table-title">Elastic response spectrum</div>
      <div className="frf-wrap">
        <SpectrumPlot spec={result.spectrum} periods={result.periods} T1={result.T1} />
        <div className="frf-caption">
          Sa vs period · <span className="frf-key drive">— T₁</span>{' '}
          <span className="frf-key res">┆ higher modes</span> · peak SDOF response of every period under this record
        </div>
      </div>

      <p className="hint-text">
        {record === 'pulse'
          ? 'A near-fault velocity pulse (Ricker wavelet) — one dominant swing that hammers long-period structures far harder than a broadband record of equal PGA.'
          : record === 'harmonic'
            ? 'A steady harmonic shaker — its response spectrum spikes at the drive period. Tune the structure near it (or vice-versa) to watch resonance build.'
            : 'A seeded broadband accelerogram (Kanai–Tajimi soil spectrum × Jennings envelope), integrated by Newmark-β with Rayleigh damping. The spectrum reads the peak SDOF demand at every period.'}
      </p>
    </div>
  )
}

function InelasticPanel({
  result,
  record,
  onRecord,
  pga,
  onPga,
  zeta,
  onZeta,
  alpha,
  onAlpha,
  strength,
  onStrength,
  playing,
  onPlay,
  onRestart,
  onScrub,
  elapsed,
}: {
  result: InelasticResult | null
  record: GroundRecord
  onRecord: (v: GroundRecord) => void
  pga: number
  onPga: (v: number) => void
  zeta: number
  onZeta: (v: number) => void
  alpha: number
  onAlpha: (v: number) => void
  strength: number
  onStrength: (v: number) => void
  playing: boolean
  onPlay: (v: boolean) => void
  onRestart: () => void
  onScrub: (t: number) => void
  elapsed: number
}) {
  if (!result) return null
  const g = result.ground
  const ok = result.ok
  const cursorIdx = result.dt > 0 ? elapsed / result.dt : 0
  const yielded = result.nHingesYielded > 0
  return (
    <div className="panel">
      <div className="panel-title">
        Inelastic response
        {ok && (
          <span className={result.Rfactor >= 1.5 ? 'badge good' : 'badge warn'}>
            R ≈ {result.Rfactor.toFixed(1)}
          </span>
        )}
      </div>
      <div className="field-label">Ground motion</div>
      <Segmented<GroundRecord>
        options={[
          { value: 'synthetic', label: 'Quake' },
          { value: 'pulse', label: 'Pulse' },
          { value: 'harmonic', label: 'Shaker' },
        ]}
        value={record}
        onChange={onRecord}
      />
      {ok ? (
        <div className="stat-grid">
          <StatTile label="Ductility μ" value={yielded ? result.ductility.toFixed(1) : '1.0'} sub="peak / yield roof" />
          <StatTile label="Force reduction R" value={result.Rfactor.toFixed(1)} sub="elastic / inelastic V" />
          <StatTile label="Peak roof" value={fmtEng(result.peakRoof, 'm')} sub={`joint ${result.outNode} ${result.outDir}`} />
          <StatTile label="Residual drift" value={fmtEng(Math.abs(result.residualRoof), 'm')} sub="permanent" />
          <StatTile label="Hyst. energy" value={fmtEng(result.hystEnergy, 'J')} sub="dissipated" />
          <StatTile label="Hinges yielded" value={`${result.nHingesYielded}`} sub="plastic" />
          <StatTile label="Peak base shear" value={fmtEng(result.peakBaseShear, 'N')} sub={`elastic ${fmtEng(result.elasticPeakBaseShear, 'N')}`} />
          <StatTile label="Fundamental T₁" value={fmtEng(result.T1, 's')} />
        </div>
      ) : (
        <p className="hint-text">{result.note ?? 'Inelastic time-history unavailable for this model.'}</p>
      )}

      {ok && (
        <div className="frf-wrap">
          <TimeSeriesPlot
            data={g.ag}
            dt={g.dt}
            cursorTime={elapsed}
            color="#f5a742"
            unit="m/s²"
            label="ground a(t)"
            onPick={onScrub}
          />
          {result.roof.length > 0 && (
            <TimeSeriesPlot
              data={result.roof}
              dt={result.dt}
              cursorTime={elapsed}
              color="#6ea8ff"
              unit="m"
              label="roof drift"
              onPick={onScrub}
            />
          )}
          <div className="frf-caption">
            {g.name} · {g.duration.toFixed(0)} s · click a trace to scrub
          </div>
        </div>
      )}

      {ok && (
        <div className="btn-row">
          <button className="ghost-btn" onClick={() => onPlay(!playing)}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <button className="ghost-btn" onClick={onRestart}>
            ↺ Restart
          </button>
        </div>
      )}

      {ok && result.roof.length > 1 && (
        <>
          <div className="table-title">Hysteresis loop</div>
          <div className="frf-wrap">
            <HysteresisPlot roof={result.roof} baseShear={result.baseShear} cursorIndex={cursorIdx} />
            <div className="frf-caption">
              base shear vs roof drift · fat loops are dissipated energy · a straight line would be elastic
            </div>
          </div>
        </>
      )}

      <Slider
        label="Peak ground accel."
        min={0.05}
        max={1.2}
        step={0.05}
        value={pga}
        onChange={onPga}
        format={(v) => `${v.toFixed(2)} g`}
      />
      <Slider
        label="Yield strength ×"
        min={0.15}
        max={2}
        step={0.05}
        value={strength}
        onChange={onStrength}
        format={(v) => `${v.toFixed(2)}× Mₚ`}
      />
      <Slider
        label="Post-yield ratio α"
        min={0}
        max={0.2}
        step={0.01}
        value={alpha}
        onChange={onAlpha}
        format={(v) => (v === 0 ? 'EPP' : `${(v * 100).toFixed(0)}%`)}
      />
      <Slider
        label="Damping ratio ζ"
        min={0.02}
        max={0.15}
        step={0.005}
        value={zeta}
        onChange={onZeta}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />

      {ok && !result.converged && (
        <p className="hint-text">
          ⚠ {result.nonConverged} step(s) hit the Newton cap (worst residual{' '}
          {(result.worstResidual * 100).toFixed(1)}%) — try raising the yield strength or the post-yield ratio α.
        </p>
      )}
      <p className="hint-text">
        {yielded
          ? `The frame yields at ${result.nHingesYielded} plastic hinge${result.nHingesYielded === 1 ? '' : 's'}: the base shear saturates near capacity (an R ≈ ${result.Rfactor.toFixed(1)}× cut below the elastic demand), the loops dissipate ${fmtEng(result.hystEnergy, 'J')}, and it is left ${fmtEng(Math.abs(result.residualRoof), 'm')} off plumb. Lower the yield strength to yield harder.`
          : 'The frame rides this record elastically — no hinge forms. Raise the peak ground acceleration or lower the yield strength to drive it past yield and open the hysteresis loops.'}
      </p>
    </div>
  )
}

function PushoverPanel({
  result,
  info,
  playing,
  onPlay,
  onScrub,
  secondOrder,
  onSecondOrder,
}: {
  result: PushoverResult | null
  info: { lambda: number; disp: number; hinges: number } | null
  playing: boolean
  onPlay: (v: boolean) => void
  onScrub: (s: number) => void
  secondOrder: boolean
  onSecondOrder: (v: boolean) => void
}) {
  if (!result) return null
  if (!result.ok) {
    return (
      <div className="panel">
        <div className="panel-title">Pushover — plastic collapse</div>
        <p className="hint-text">{result.note ?? 'No pushover available.'}</p>
        <Toggle label="Second-order (P-Δ)" checked={secondOrder} onChange={onSecondOrder} />
      </div>
    )
  }
  const cur = info ?? { lambda: result.collapseLambda, disp: result.collapseDisp, hinges: result.events.length }
  const atCollapse = result.collapse && cur.hinges >= result.events.length
  return (
    <div className="panel">
      <div className="panel-title">
        Pushover — plastic collapse
        <span className={result.collapse ? 'badge good' : 'badge warn'}>
          {result.collapse ? `λc = ${result.collapseLambda.toFixed(2)}` : 'no mechanism'}
        </span>
      </div>
      <div className="stat-grid">
        <StatTile label="Collapse factor λc" value={result.collapseLambda.toFixed(3)} sub="× applied load" />
        <StatTile label="First yield λ₁" value={result.firstYieldLambda.toFixed(3)} sub="elastic limit" />
        <StatTile
          label="Plastic reserve"
          value={`${result.reserve.toFixed(2)}×`}
          sub="λc / λ₁ (redistribution)"
        />
        <StatTile label="Hinges at collapse" value={`${result.events.length}`} sub={result.collapse ? 'mechanism' : 'stable'} />
        <StatTile label="Control DOF" value={result.controlLabel} />
        <StatTile
          label="Live state"
          value={`λ = ${cur.lambda.toFixed(2)}`}
          sub={atCollapse ? 'collapsed' : `${cur.hinges} hinge${cur.hinges === 1 ? '' : 's'}`}
        />
      </div>
      <div className="frf-wrap">
        <CapacityCurvePlot res={result} cursor={{ disp: cur.disp, lambda: cur.lambda }} onScrub={onScrub} />
        <div className="frf-caption">
          load factor vs control deflection · <span className="frf-key res">● hinge</span>{' '}
          <span className="frf-key drive">— load state</span> · click to scrub
        </div>
      </div>
      <div className="btn-row">
        <button className="ghost-btn" onClick={() => onPlay(!playing)}>
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button className="ghost-btn" onClick={() => onScrub(0)}>
          ↺ Unload
        </button>
        <button className="ghost-btn" onClick={() => onScrub(result.curve.length - 1)}>
          ⤒ Collapse
        </button>
      </div>
      <Toggle label="Second-order (P-Δ)" checked={secondOrder} onChange={onSecondOrder} />
      <div className="table-title">Hinge sequence — click to jump</div>
      <div className="mode-list">
        {result.events.map((e) => (
          <button
            key={e.order}
            className={`mode-row ${cur.hinges >= e.order ? 'active' : ''}`}
            onClick={() => onScrub(e.order)}
          >
            <span className="mode-idx">#{e.order}</span>
            <span className="mode-freq">λ = {e.lambda.toFixed(2)}</span>
            <span className="mode-part">
              joint {e.node} · {e.end === 'a' ? 'i' : 'j'}-end
            </span>
          </button>
        ))}
      </div>
      <p className="hint-text">
        {result.collapse
          ? `Load redistributes through ${result.events.length} plastic hinge${result.events.length === 1 ? '' : 's'} until the frame becomes a mechanism — collapsing at ${result.reserve.toFixed(2)}× the first-yield load. Hinges appear as amber discs on the deflected shape.`
          : result.note ??
            'The load pattern shakes down: the hinges shown form, but the structure stabilises without a full collapse mechanism.'}
        {secondOrder && ' P-Δ softening from axial load is included in the tangent stiffness.'}
      </p>
    </div>
  )
}

function NumberField({
  label,
  value,
  onChange,
  step = 1,
  suffix,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  step?: number
  suffix?: string
}) {
  return (
    <label className="numfield">
      <span>{label}</span>
      <span className="numfield-input">
        <input
          type="number"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        />
        {suffix && <em>{suffix}</em>}
      </span>
    </label>
  )
}

function SelectionEditor({
  sel,
  model,
  result,
  onSupport,
  onLoad,
  onMember,
  onDeleteNode,
  onDeleteMember,
}: {
  sel: Picked
  model: FrameModel
  result: FrameResult | null
  onSupport: (i: number, s: SupportKind) => void
  onLoad: (i: number, fx: number, fy: number, mz: number) => void
  onMember: (i: number, patch: Partial<FrameModel['members'][number]>) => void
  onDeleteNode: (i: number) => void
  onDeleteMember: (i: number) => void
}) {
  if (sel.type === 'node') {
    const i = sel.index
    const n = model.nodes[i]
    if (!n) return null
    const l = getLoad(model, i)
    return (
      <div className="panel">
        <div className="panel-title">Joint {i}</div>
        <div className="field-label">Support</div>
        <select
          className="select"
          value={n.support}
          onChange={(e) => onSupport(i, e.target.value as SupportKind)}
        >
          {SUPPORTS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="field-label">Applied load</div>
        <NumberField label="Fx" value={l.fx / 1000} step={1} suffix="kN" onChange={(v) => onLoad(i, v * 1000, l.fy, l.mz)} />
        <NumberField label="Fy" value={l.fy / 1000} step={1} suffix="kN" onChange={(v) => onLoad(i, l.fx, v * 1000, l.mz)} />
        {model.type === 'frame' && (
          <NumberField label="M" value={l.mz / 1000} step={1} suffix="kN·m" onChange={(v) => onLoad(i, l.fx, l.fy, v * 1000)} />
        )}
        <button className="danger-btn" onClick={() => onDeleteNode(i)}>
          Delete joint
        </button>
      </div>
    )
  }
  const i = sel.index
  const m = model.members[i]
  if (!m) return null
  const r = result?.members[i]
  const curSection = m.section && findSection(m.section) ? m.section : 'custom'
  const applySection = (id: string) => {
    if (id === 'custom') {
      onMember(i, { section: undefined, c: undefined })
      return
    }
    const s = findSection(id)
    if (s) onMember(i, { section: s.id, A: s.A, I: s.I, c: s.c })
  }
  return (
    <div className="panel">
      <div className="panel-title">Member {i}</div>
      {r && (
        <div className="stat-grid">
          <StatTile label="Axial" value={`${r.axial >= 0 ? '+' : ''}${fmtEng(r.axial, 'N')}`} sub={r.axial >= 0 ? 'tension' : 'compression'} />
          <StatTile label="Fibre stress" value={fmtEng(r.maxFiberStress, 'Pa')} />
          {model.type === 'frame' && <StatTile label="Moment" value={fmtEng(Math.max(Math.abs(r.momentA), Math.abs(r.momentB)), 'N·m')} />}
          <StatTile
            label="Utilisation"
            value={`${(r.utilization * 100).toFixed(0)}%`}
            sub={r.utilization > 1 ? 'over-stressed' : 'σ/σ_yield'}
          />
        </div>
      )}
      <div className="field-label">Standard section</div>
      <select className="select" value={curSection} onChange={(e) => applySection(e.target.value)}>
        <option value="custom">Custom (enter A, I below)</option>
        {SECTIONS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label} — {s.blurb}
          </option>
        ))}
      </select>
      <div className="field-label">Section properties</div>
      <NumberField label="E" value={m.E / 1e9} step={1} suffix="GPa" onChange={(v) => onMember(i, { E: v * 1e9 })} />
      <NumberField
        label="A"
        value={m.A * 1e4}
        step={1}
        suffix="cm²"
        onChange={(v) => onMember(i, { A: v / 1e4, section: undefined, c: undefined })}
      />
      {model.type === 'frame' && (
        <>
          <NumberField
            label="I"
            value={m.I * 1e8}
            step={1}
            suffix="cm⁴"
            onChange={(v) => onMember(i, { I: v / 1e8, section: undefined, c: undefined })}
          />
          <NumberField
            label="w"
            value={(m.w ?? 0) / 1000}
            step={1}
            suffix="kN/m"
            onChange={(v) => onMember(i, { w: v * 1000 })}
          />
        </>
      )}
      <NumberField
        label="ρ"
        value={m.rho ?? 7850}
        step={100}
        suffix="kg/m³"
        onChange={(v) => onMember(i, { rho: v })}
      />
      <NumberField
        label="Fᵧ"
        value={(m.Fy ?? 345e6) / 1e6}
        step={5}
        suffix="MPa"
        onChange={(v) => onMember(i, { Fy: v * 1e6 })}
      />
      {model.type === 'frame' && (
        <NumberField
          label="Mₚ"
          value={Math.round(memberMp(m) / 1e3)}
          step={10}
          suffix="kN·m"
          onChange={(v) => onMember(i, { Mp: v * 1e3 })}
        />
      )}
      <button className="danger-btn" onClick={() => onDeleteMember(i)}>
        Delete member
      </button>
    </div>
  )
}
