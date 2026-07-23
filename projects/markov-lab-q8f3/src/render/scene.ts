// Draws the main view each frame: the density heatmap, the fading chain
// trail, the current proposal/trajectory, and the live state marker.

import { ACCENT, ACCENT_HOT, ACCENT_WARM } from './colormap'
import type { Simulation } from '../engine/simulation'
import type { Transform } from './field'

export interface SceneOpts {
  showField: boolean
  showTrail: boolean
  showTrajectory: boolean
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  sim: Simulation,
  tf: Transform,
  field: HTMLCanvasElement | null,
  cloud: HTMLCanvasElement | null,
  opts: SceneOpts,
) {
  const { w, h } = tf
  ctx.clearRect(0, 0, w, h)

  // ── density heatmap ───────────────────────────────────────────────
  if (opts.showField && field) {
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(field, 0, 0, w, h)
  } else {
    ctx.fillStyle = '#0a0c16'
    ctx.fillRect(0, 0, w, h)
  }

  // ── accumulated "long-exposure" sample cloud (additive) ───────────
  if (cloud) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.drawImage(cloud, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-over'
  }

  // ── chain trail (recent states, fading with age) ──────────────────
  if (opts.showTrail && sim.trailX.length > 1) {
    const n = sim.trailX.length
    ctx.lineWidth = 1
    for (let i = 1; i < n; i++) {
      const age = i / n // 0 = oldest, 1 = newest
      const [x0, y0] = tf.toPx(sim.trailX[i - 1], sim.trailY[i - 1])
      const [x1, y1] = tf.toPx(sim.trailX[i], sim.trailY[i])
      ctx.strokeStyle = `rgba(150,190,255,${(0.06 + 0.5 * age).toFixed(3)})`
      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.stroke()
    }
  }

  // ── tempered replicas (parallel tempering) ────────────────────────
  const chains = sim.lastChains
  if (chains) {
    for (let k = chains.length - 1; k >= 0; k--) {
      const [px, py] = tf.toPx(chains[k][0], chains[k][1])
      const hot = k / Math.max(1, chains.length - 1)
      const r = 2 + 3 * (1 - hot)
      ctx.fillStyle = k === 0 ? ACCENT : `rgba(255,${Math.round(120 + 100 * hot)},80,0.6)`
      ctx.beginPath()
      ctx.arc(px, py, r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ── leapfrog / slice trajectory ───────────────────────────────────
  const traj = sim.lastTrajectory
  if (opts.showTrajectory && traj && traj.length > 1) {
    ctx.strokeStyle = ACCENT_WARM
    ctx.lineWidth = 1.6
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    const [sx, sy] = tf.toPx(traj[0][0], traj[0][1])
    ctx.moveTo(sx, sy)
    for (let i = 1; i < traj.length; i++) {
      const [px, py] = tf.toPx(traj[i][0], traj[i][1])
      ctx.lineTo(px, py)
    }
    ctx.stroke()
    // little dots at each leapfrog step
    ctx.fillStyle = ACCENT_WARM
    for (let i = 0; i < traj.length; i++) {
      const [px, py] = tf.toPx(traj[i][0], traj[i][1])
      ctx.globalAlpha = 0.5
      ctx.beginPath()
      ctx.arc(px, py, 1.3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }

  // ── proposal (RWM / MALA) ─────────────────────────────────────────
  const prop = sim.lastProposal
  if (prop && sim.last) {
    const [cx, cy] = tf.toPx(sim.xs[sim.xs.length - 1], sim.ys[sim.ys.length - 1])
    const [px, py] = tf.toPx(prop[0], prop[1])
    ctx.strokeStyle = sim.last.accepted ? 'rgba(120,255,180,0.7)' : 'rgba(255,110,130,0.7)'
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(px, py)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.strokeStyle = sim.last.accepted ? 'rgba(120,255,180,0.9)' : 'rgba(255,110,130,0.9)'
    ctx.beginPath()
    ctx.arc(px, py, 3.2, 0, Math.PI * 2)
    ctx.stroke()
  }

  // ── current state marker ──────────────────────────────────────────
  if (sim.xs.length) {
    const [cx, cy] = tf.toPx(sim.xs[sim.xs.length - 1], sim.ys[sim.ys.length - 1])
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, 9)
    grd.addColorStop(0, 'rgba(255,255,255,0.95)')
    grd.addColorStop(0.4, ACCENT_HOT)
    grd.addColorStop(1, 'rgba(255,93,126,0)')
    ctx.fillStyle = grd
    ctx.beginPath()
    ctx.arc(cx, cy, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.beginPath()
    ctx.arc(cx, cy, 2.4, 0, Math.PI * 2)
    ctx.fill()
  }
}
