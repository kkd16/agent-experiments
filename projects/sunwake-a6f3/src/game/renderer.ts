import { terrain } from './engine'
import { WORLD_HEIGHT } from './types'
import type { Entity, GameState, ShipId } from './types'

type RGB = readonly [number, number, number]
type Palette = readonly RGB[]

// Sky, horizon, sun, far ridge, middle ridge, near ridge, sand, deep sand,
// etched sand, plum ink, solar gold, sail. Each world keeps the same contrast.
const PALETTES: readonly Palette[] = [
  [
    [244, 183, 145],
    [255, 224, 165],
    [255, 240, 177],
    [215, 143, 138],
    [181, 106, 123],
    [137, 80, 110],
    [227, 150, 109],
    [173, 89, 93],
    [251, 189, 125],
    [70, 46, 73],
    [255, 230, 151],
    [112, 220, 208],
  ],
  [
    [221, 153, 161],
    [255, 203, 174],
    [255, 227, 185],
    [190, 128, 154],
    [151, 100, 142],
    [113, 77, 120],
    [204, 124, 146],
    [139, 74, 116],
    [242, 170, 164],
    [58, 40, 73],
    [255, 231, 168],
    [135, 235, 214],
  ],
  [
    [125, 109, 166],
    [222, 173, 191],
    [255, 222, 194],
    [148, 115, 171],
    [111, 87, 146],
    [77, 62, 119],
    [161, 126, 178],
    [96, 74, 130],
    [209, 171, 202],
    [43, 34, 67],
    [255, 222, 162],
    [127, 227, 222],
  ],
  [
    [75, 113, 153],
    [170, 205, 213],
    [254, 236, 190],
    [99, 147, 169],
    [76, 116, 145],
    [50, 83, 115],
    [112, 167, 181],
    [59, 108, 134],
    [169, 216, 217],
    [32, 48, 70],
    [255, 226, 153],
    [173, 243, 218],
  ],
]

const TAU = Math.PI * 2

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smooth(t: number) {
  return t * t * (3 - 2 * t)
}

function mod(value: number, range: number) {
  return ((value % range) + range) % range
}

function random(value: number) {
  const n = Math.sin(value * 127.1 + 311.7) * 43758.5453
  return n - Math.floor(n)
}

function colors(distance: number) {
  const progress = Math.max(0, distance) / 1000
  const index = Math.floor(progress) % PALETTES.length
  const blend = smooth(Math.max(0, ((progress % 1) - 0.68) / 0.32))
  return PALETTES[index].map((rgb, i) => {
    const next = PALETTES[(index + 1) % PALETTES.length][i]
    return `rgb(${Math.round(mix(rgb[0], next[0], blend))},${Math.round(mix(rgb[1], next[1], blend))},${Math.round(mix(rgb[2], next[2], blend))})`
  })
}

function circle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
) {
  ctx.beginPath()
  ctx.arc(x, y, Math.max(0, radius), 0, TAU)
}

function diamond(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
) {
  ctx.beginPath()
  ctx.moveTo(x, y - radius)
  ctx.lineTo(x + radius * 0.66, y)
  ctx.lineTo(x, y + radius)
  ctx.lineTo(x - radius * 0.66, y)
  ctx.closePath()
}

function sky(
  ctx: CanvasRenderingContext2D,
  w: number,
  camera: number,
  time: number,
  palette: string[],
  ready: boolean,
  distance: number,
  top: number,
  bottom: number,
) {
  const gradient = ctx.createLinearGradient(0, top, 0, 540)
  gradient.addColorStop(0, palette[0])
  gradient.addColorStop(1, palette[1])
  ctx.fillStyle = gradient
  ctx.fillRect(0, top, w, bottom - top)

  // Quiet, widely spaced pinpricks, with a little more light in the night worlds.
  const night = Math.sin(Math.min(1, (distance % 4000) / 2400) * Math.PI * 0.5)
  ctx.fillStyle = '#fff5d8'
  for (let i = 0; i < 46; i++) {
    const x = mod(random(i + 6) * (w + 200) - camera * 0.012, w + 200) - 100
    const y = mix(top + 38, 352, random(i + 89))
    ctx.globalAlpha =
      (0.14 + night * 0.34) * (0.6 + Math.sin(time * 0.8 + i) * 0.2)
    if (i % 7 === 0) {
      const r = 2.2 + random(i) * 1.7
      ctx.fillRect(x - r, y - 0.55, r * 2, 1.1)
      ctx.fillRect(x - 0.55, y - r, 1.1, r * 2)
    } else {
      circle(ctx, x, y, random(i + 4) * 1.25 + 0.5)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1

  const sunX = w * (ready ? 0.765 : 0.78)
  const sunY = w < 670 ? 200 : 213
  const sunR =
    Math.min(118, Math.max(79, w * 0.12)) * (1 + Math.min(0.38, -top / 1200))
  const glow = ctx.createRadialGradient(
    sunX,
    sunY,
    sunR * 0.3,
    sunX,
    sunY,
    sunR * 2.25,
  )
  glow.addColorStop(0, '#ffeac350')
  glow.addColorStop(0.55, '#ffeac31b')
  glow.addColorStop(1, '#ffeac300')
  ctx.fillStyle = glow
  ctx.fillRect(sunX - sunR * 2.3, sunY - sunR * 2.3, sunR * 4.6, sunR * 4.6)

  ctx.save()
  ctx.translate(sunX, sunY)
  ctx.rotate(-0.3)
  ctx.lineWidth = 0.9
  ctx.strokeStyle = '#fff1cc'
  ctx.globalAlpha = 0.33
  ctx.beginPath()
  ctx.ellipse(0, 0, sunR * 1.62, sunR * 0.64, 0, Math.PI * 0.78, Math.PI * 1.96)
  ctx.stroke()
  ctx.globalAlpha = 0.2
  circle(ctx, 0, 0, sunR + 15)
  ctx.stroke()
  ctx.restore()

  circle(ctx, sunX, sunY, sunR)
  const disc = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR)
  disc.addColorStop(0, '#fff5ce')
  disc.addColorStop(0.55, palette[2])
  disc.addColorStop(1, '#f7ba91')
  ctx.fillStyle = disc
  ctx.fill()
  ctx.save()
  ctx.clip()
  ctx.globalAlpha = 0.24
  ctx.fillStyle = palette[0]
  for (let i = 0; i < 7; i++) {
    const y = sunY + sunR * 0.14 + i * 13
    ctx.fillRect(sunX - sunR - 2, y, sunR * 2 + 4, 1 + i * 0.75)
  }
  ctx.restore()

  // A small companion moon and a single long cirrus ribbon give the sky scale.
  ctx.globalAlpha = 0.35
  ctx.fillStyle = palette[2]
  circle(ctx, sunX - sunR * 1.48, sunY - sunR * 0.92, 8)
  ctx.fill()
  ctx.globalAlpha = 0.28
  ctx.fillStyle = '#fff2d7'
  ctx.beginPath()
  ctx.moveTo(w * 0.43, 114)
  ctx.bezierCurveTo(w * 0.53, 100, w * 0.58, 112, w * 0.68, 107)
  ctx.bezierCurveTo(w * 0.6, 121, w * 0.55, 117, w * 0.43, 114)
  ctx.fill()
  ctx.globalAlpha = 1
}

function ridgeHeight(x: number, depth: number) {
  return (
    387 +
    depth * 41 +
    Math.sin(x * 0.0045 + depth * 1.8) * 33 +
    Math.sin(x * 0.013 + depth * 2.1) * (depth === 0 ? 20 : 13)
  )
}

function mountains(
  ctx: CanvasRenderingContext2D,
  w: number,
  camera: number,
  palette: string[],
) {
  for (let layer = 0; layer < 3; layer++) {
    const offset = camera * (0.065 + layer * 0.07)
    ctx.beginPath()
    ctx.moveTo(-30, 740)
    for (let x = -30; x <= w + 30; x += 15) {
      const pointX = x + offset
      const jagged =
        layer === 0
          ? Math.abs(Math.sin(pointX * 0.009)) * 48 +
            Math.abs(Math.sin(pointX * 0.0032 + 5)) * 48
          : 0
      ctx.lineTo(x, ridgeHeight(pointX, layer) - jagged)
    }
    ctx.lineTo(w + 30, 740)
    ctx.closePath()
    ctx.fillStyle = palette[3 + layer]
    ctx.globalAlpha = layer === 0 ? 0.55 : layer === 1 ? 0.7 : 0.79
    ctx.fill()
    ctx.globalAlpha = 1

    if (layer === 0) {
      ctx.strokeStyle = palette[1]
      ctx.globalAlpha = 0.14
      ctx.lineWidth = 1
      for (let j = 0; j < 9; j++) {
        const x = mod(j * 261 - offset, w + 250) - 100
        const y = ridgeHeight(x + offset, 0) - 35
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x - 22, y + 30)
        ctx.lineTo(x - 16, y + 46)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }

  const ruinOffset = camera * 0.17
  const first = Math.floor((ruinOffset - 250) / 620)
  ctx.fillStyle = palette[5]
  for (let i = first; i < first + Math.ceil(w / 620) + 2; i++) {
    const x = i * 620 + 230 + random(i + 66) * 180 - ruinOffset
    const baseY = ridgeHeight(x + camera * 0.205, 2) + 5
    const size = 0.5 + random(i + 3) * 0.38
    ctx.save()
    ctx.translate(x, baseY)
    ctx.scale(size, size)
    ctx.globalAlpha = 0.71
    if (mod(i, 3) === 0) {
      // Monolithic arch cut directly out of the silhouette.
      ctx.beginPath()
      ctx.moveTo(-39, 3)
      ctx.lineTo(-37, -58)
      ctx.bezierCurveTo(-36, -113, 34, -119, 41, -61)
      ctx.lineTo(44, 3)
      ctx.lineTo(23, 3)
      ctx.lineTo(22, -60)
      ctx.bezierCurveTo(20, -86, -17, -89, -18, -57)
      ctx.lineTo(-19, 3)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(-54, -4, 112, 10)
      ctx.strokeStyle = palette[3]
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(-29, -54)
      ctx.lineTo(-27, -16)
      ctx.moveTo(33, -51)
      ctx.lineTo(35, -8)
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(-8, 0)
      ctx.lineTo(-5, -72)
      ctx.lineTo(0, -94)
      ctx.lineTo(9, -68)
      ctx.lineTo(12, 0)
      ctx.closePath()
      ctx.fill()
      ctx.fillRect(21, -31, 7, 32)
      ctx.fillRect(-26, -18, 9, 19)
    }
    ctx.restore()
  }

  // Small migrating birds stay well above the playable horizon.
  ctx.strokeStyle = palette[5]
  ctx.globalAlpha = 0.4
  ctx.lineWidth = 1.4
  for (let i = 0; i < 5; i++) {
    const x = mod(w * 0.65 + i * 23 - camera * 0.027, w + 100) - 20
    const y = 314 + Math.sin(i * 0.8) * 14
    ctx.beginPath()
    ctx.moveTo(x - 4, y + 1)
    ctx.quadraticCurveTo(x - 1, y - 2, x, y)
    ctx.quadraticCurveTo(x + 2, y - 3, x + 6, y - 2)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

function ground(
  ctx: CanvasRenderingContext2D,
  w: number,
  camera: number,
  seed: number,
  palette: string[],
  bottom: number,
) {
  const dune = new Path2D()
  dune.moveTo(-20, bottom + 10)
  for (let x = -20; x <= w + 24; x += 8)
    dune.lineTo(x, terrain(x + camera, seed))
  dune.lineTo(w + 24, bottom + 10)
  dune.closePath()
  const fill = ctx.createLinearGradient(0, 400, 0, Math.max(760, bottom))
  fill.addColorStop(0, palette[6])
  fill.addColorStop(1, palette[7])
  ctx.fillStyle = fill
  ctx.fill(dune)

  ctx.save()
  ctx.clip(dune)
  // Contours follow the real course, then open up into long wind-carved ribbons.
  for (
    let line = 0;
    line < Math.max(12, Math.ceil((bottom - 450) / 45));
    line++
  ) {
    ctx.beginPath()
    for (let x = -24; x <= w + 24; x += 15) {
      const worldX = x + camera
      const depth = 12 + line * 17 + line * line * 1.55
      const y =
        terrain(worldX - line * 7, seed) +
        depth +
        Math.sin(worldX * 0.005 + line * 0.42) * line * 2.4
      if (x === -24) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = line % 3 === 0 ? palette[9] : palette[8]
    ctx.globalAlpha =
      line % 3 === 0 ? 0.065 : Math.max(0.045, 0.23 - line * 0.009)
    ctx.lineWidth = line % 4 === 0 ? 1.4 : 0.7
    ctx.stroke()
  }

  ctx.strokeStyle = palette[8]
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.3
  const segment = Math.floor(camera / 110)
  for (let i = segment - 1; i < segment + Math.ceil(w / 110) + 2; i++) {
    const worldX = i * 110 + random(i + seed) * 70
    const x = worldX - camera
    const y = terrain(worldX, seed) + 35 + random(i + 8) * 120
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.quadraticCurveTo(x + 10, y - 3, x + 23, y - 1)
    ctx.moveTo(x + 5, y + 5)
    ctx.lineTo(x + 15, y + 4)
    ctx.stroke()
  }
  ctx.restore()

  ctx.beginPath()
  for (let x = -16; x <= w + 16; x += 8) {
    const y = terrain(x + camera, seed)
    if (x === -16) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = palette[8]
  ctx.lineWidth = 3.5
  ctx.stroke()
  ctx.strokeStyle = palette[2]
  ctx.globalAlpha = 0.54
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.globalAlpha = 1
}

function collectible(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  x: number,
  time: number,
  palette: string[],
) {
  const { y, radius, kind, phase } = entity
  const pulse = Math.sin(time * 3 + phase)
  ctx.save()
  ctx.translate(x, y)
  if (kind === 'spark') {
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 24)
    glow.addColorStop(0, '#fff0b34a')
    glow.addColorStop(1, '#fff0b300')
    ctx.fillStyle = glow
    ctx.fillRect(-24, -24, 48, 48)
    ctx.fillStyle = palette[10]
    diamond(ctx, 0, pulse * 2, 9)
    ctx.fill()
    ctx.fillStyle = '#fff9df'
    diamond(ctx, -1.2, -1 + pulse * 2, 4)
    ctx.fill()
    ctx.strokeStyle = '#fff4ca'
    ctx.globalAlpha = 0.22
    ctx.lineWidth = 0.8
    diamond(ctx, 0, pulse * 2, 15)
    ctx.stroke()
  } else {
    const well = kind === 'sunwell'
    const r = radius * (well ? 0.94 : 1)
    ctx.strokeStyle = well ? palette[11] : palette[10]
    ctx.lineWidth = 10
    ctx.globalAlpha = 0.09
    circle(ctx, 0, 0, r)
    ctx.stroke()
    ctx.lineWidth = 2.2
    ctx.globalAlpha = 0.86
    circle(ctx, 0, 0, r)
    ctx.stroke()
    ctx.globalAlpha = 0.35
    ctx.lineWidth = 0.85
    circle(ctx, 0, 0, r + 6)
    ctx.stroke()
    ctx.globalAlpha = 1
    ctx.strokeStyle = '#fff8dc'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, r, time * 0.55 + phase, time * 0.55 + phase + 0.72)
    ctx.stroke()
    ctx.fillStyle = well ? palette[11] : '#fff6cc'
    if (well) {
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * TAU + time * 0.15
        ctx.save()
        ctx.rotate(angle)
        ctx.fillRect(-0.7, -15, 1.4, 5)
        ctx.restore()
      }
      circle(ctx, 0, 0, 6 + pulse)
      ctx.fill()
    } else {
      diamond(ctx, 0, -r, 4.5)
      ctx.fill()
      diamond(ctx, 0, r, 4.5)
      ctx.fill()
    }
  }
  ctx.restore()
}

function hazard(
  ctx: CanvasRenderingContext2D,
  entity: Entity,
  x: number,
  time: number,
) {
  const { y, radius, kind, phase } = entity
  ctx.save()
  ctx.translate(x, y)
  if (kind === 'rock') {
    ctx.fillStyle = '#8c4c66'
    ctx.beginPath()
    ctx.moveTo(-radius - 7, radius * 0.9)
    ctx.lineTo(-radius * 0.63, -radius * 0.48)
    ctx.lineTo(-radius * 0.07, -radius * 1.13)
    ctx.lineTo(radius * 0.58, -radius * 0.49)
    ctx.lineTo(radius + 5, radius * 0.85)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#cc747e'
    ctx.beginPath()
    ctx.moveTo(-radius * 0.07, -radius * 1.13)
    ctx.lineTo(radius * 0.58, -radius * 0.49)
    ctx.lineTo(radius + 5, radius * 0.85)
    ctx.lineTo(radius * 0.1, radius * 0.61)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = '#ffb99c'
    ctx.lineWidth = 1.8
    ctx.beginPath()
    ctx.moveTo(-radius * 0.48, -radius * 0.28)
    ctx.lineTo(-radius * 0.06, -radius * 0.63)
    ctx.lineTo(radius * 0.13, -radius * 0.2)
    ctx.stroke()
  } else {
    const glow = ctx.createRadialGradient(0, 0, 3, 0, 0, radius * 1.9)
    glow.addColorStop(0, '#ec6b8160')
    glow.addColorStop(1, '#ed637700')
    ctx.fillStyle = glow
    ctx.fillRect(-radius * 2, -radius * 2, radius * 4, radius * 4)

    ctx.save()
    ctx.rotate(Math.sin(time + phase) * 0.13)
    ctx.fillStyle = '#875270'
    ctx.beginPath()
    for (let i = 0; i <= 36; i++) {
      const angle = (i / 36) * TAU
      const r = radius * (0.86 + Math.sin(angle * 5 + phase) * 0.15)
      const px = Math.cos(angle) * r * 1.22
      const py = Math.sin(angle) * r * 0.84
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = '#f599a0'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.strokeStyle = '#ffd9b7'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.moveTo(5, -radius * 0.58)
    ctx.lineTo(-6, 0)
    ctx.lineTo(5, -1)
    ctx.lineTo(-3, radius * 0.58)
    ctx.stroke()
    ctx.restore()

    ctx.strokeStyle = '#ed96a2'
    ctx.lineWidth = 1.1
    ctx.globalAlpha = 0.68
    ctx.beginPath()
    ctx.ellipse(
      0,
      0,
      radius * 1.6,
      radius * 0.53,
      -0.28,
      phase + time * 0.4,
      phase + time * 0.4 + 4.2,
    )
    ctx.stroke()
    for (let i = 0; i < 3; i++) {
      const angle = time * 0.55 + (i / 3) * TAU + phase
      circle(
        ctx,
        Math.cos(angle) * radius * 1.48,
        Math.sin(angle) * radius * 0.95,
        1.8,
      )
      ctx.fillStyle = '#ffb6a9'
      ctx.fill()
    }
  }
  ctx.restore()
}

function personalHorizon(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  w: number,
  camera: number,
  scale: number,
  personalBest: number,
  palette: string[],
) {
  if (state.phase !== 'running' || personalBest <= 30) return
  const worldX = 200 + personalBest * 10
  const x = worldX - camera
  if (x < -40 || x > w + 40) return
  const y = terrain(worldX, state.seed)
  const fontSize = Math.max(10, 8 / scale)
  const pennant = Math.max(27, 12 / scale)
  const captionX = Math.min(w - fontSize * 4.5, Math.max(fontSize * 4.5, x))
  ctx.save()
  ctx.strokeStyle = '#fff0d4'
  ctx.globalAlpha = 0.75
  ctx.lineWidth = Math.max(1, 0.8 / scale)
  ctx.setLineDash([4 / scale, 5 / scale])
  ctx.beginPath()
  ctx.moveTo(x, y + 3)
  ctx.lineTo(x, y - 153)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = '#fff0d4'
  ctx.beginPath()
  ctx.moveTo(x, y - 153)
  ctx.lineTo(x + pennant, y - 146)
  ctx.lineTo(x, y - 136)
  ctx.closePath()
  ctx.fill()
  ctx.globalAlpha = 0.8
  ctx.fillStyle = palette[9]
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.font = `500 ${fontSize}px system-ui, sans-serif`
  ctx.fillText('YOUR HORIZON', captionX, y - 161 - fontSize * 1.5)
  ctx.font = `650 ${fontSize * 1.16}px system-ui, sans-serif`
  ctx.fillText(
    `${Math.floor(personalBest).toLocaleString('en-US')} m`,
    captionX,
    y - 161,
  )
  ctx.restore()
}

function drawShip(
  ctx: CanvasRenderingContext2D,
  ship: ShipId,
  time: number,
  palette: string[],
  charge: number,
) {
  const sail =
    ship === 'manta' ? '#b798db' : ship === 'comet' ? '#ec8a67' : palette[11]
  const sailLight =
    ship === 'manta' ? '#dfcbf3' : ship === 'comet' ? '#ffe0a6' : '#c8f1d8'
  const ink = palette[9]
  const flutter = Math.sin(time * 6) * 2

  ctx.fillStyle = '#ffd29d'
  ctx.globalAlpha = 0.38
  ctx.beginPath()
  ctx.moveTo(-27, 5)
  ctx.quadraticCurveTo(-51, 1 + flutter, -65, 9)
  ctx.quadraticCurveTo(-42, 13 + flutter, -22, 10)
  ctx.fill()
  ctx.globalAlpha = 1

  // Each craft has an immediately different silhouette, with a shared sailmaking language.
  ctx.strokeStyle = ink
  ctx.lineWidth = 2
  if (ship === 'manta') {
    ctx.fillStyle = sail
    ctx.beginPath()
    ctx.moveTo(2, -37)
    ctx.quadraticCurveTo(-14, -53, -39, -25 + flutter)
    ctx.quadraticCurveTo(-17, -22, -4, -10)
    ctx.lineTo(17, -6)
    ctx.quadraticCurveTo(31, -22, 46, -17)
    ctx.quadraticCurveTo(26, -45, 2, -37)
    ctx.fill()
    ctx.stroke()
    ctx.strokeStyle = sailLight
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(-30, -26)
    ctx.quadraticCurveTo(-13, -38, 2, -37)
    ctx.lineTo(33, -21)
    ctx.stroke()
    ctx.strokeStyle = ink
    ctx.beginPath()
    ctx.moveTo(-14, -25)
    ctx.lineTo(-1, 4)
    ctx.lineTo(19, -21)
    ctx.stroke()
  } else {
    const mastHeight = ship === 'comet' ? -60 : -69
    ctx.fillStyle = sail
    ctx.beginPath()
    ctx.moveTo(4, mastHeight)
    ctx.quadraticCurveTo(15, -49, 33 + flutter, -26)
    ctx.quadraticCurveTo(19, -22, 4, -13)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = sailLight
    ctx.globalAlpha = 0.65
    ctx.beginPath()
    ctx.moveTo(5, mastHeight + 2)
    ctx.quadraticCurveTo(10, -43, 21, -25)
    ctx.lineTo(5, -17)
    ctx.closePath()
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = sailLight
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(5, -44)
    ctx.lineTo(20, -39)
    ctx.moveTo(5, -28)
    ctx.lineTo(31, -27)
    ctx.stroke()
    ctx.strokeStyle = ink
    ctx.lineWidth = 2.6
    ctx.beginPath()
    ctx.moveTo(4, mastHeight - 3)
    ctx.lineTo(4, 6)
    ctx.stroke()
    ctx.strokeStyle = '#ffe5b3'
    ctx.lineWidth = 0.9
    ctx.beginPath()
    ctx.moveTo(4, mastHeight + 6)
    ctx.lineTo(-29, 5)
    ctx.stroke()
  }

  // Wind-caught scarf, rider, goggles, and a low bent-knee stance.
  ctx.fillStyle = '#de7577'
  ctx.beginPath()
  ctx.moveTo(-11, -28)
  ctx.quadraticCurveTo(-24, -34, -41, -27 + flutter)
  ctx.lineTo(-30, -26 + flutter)
  ctx.lineTo(-38, -23 + flutter)
  ctx.quadraticCurveTo(-22, -28, -12, -24)
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = 4.6
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(-11, -25)
  ctx.lineTo(-14 - charge * 2, -11)
  ctx.lineTo(-23, -3)
  ctx.lineTo(-16, 4)
  ctx.moveTo(-14, -11)
  ctx.lineTo(-5, -6)
  ctx.lineTo(-4, 4)
  ctx.moveTo(-10, -21)
  ctx.lineTo(-3, -14)
  ctx.lineTo(3, -19)
  ctx.stroke()
  ctx.fillStyle = '#ffddb0'
  circle(ctx, -10, -32, 6.5)
  ctx.fill()
  ctx.fillStyle = ink
  ctx.beginPath()
  ctx.arc(-10, -33, 6.6, Math.PI * 0.97, TAU)
  ctx.lineTo(-3, -32)
  ctx.lineTo(-5, -35)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#f6ac8c'
  ctx.fillRect(-9, -33, 6, 2.7)

  ctx.fillStyle = ink
  ctx.strokeStyle = '#ffe1a3'
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.moveTo(ship === 'comet' ? -36 : -31, 2)
  ctx.quadraticCurveTo(-7, 8, ship === 'comet' ? 43 : 36, -2)
  ctx.quadraticCurveTo(24, 14, -21, 13)
  ctx.quadraticCurveTo(-29, 10, ship === 'comet' ? -36 : -31, 2)
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  ctx.strokeStyle = sail
  ctx.lineWidth = 2.1
  ctx.beginPath()
  ctx.moveTo(-21, 9)
  ctx.quadraticCurveTo(-2, 13, 24, 4)
  ctx.stroke()
  if (ship === 'comet') {
    ctx.fillStyle = '#fce0a4'
    ctx.beginPath()
    ctx.moveTo(-27, 4)
    ctx.lineTo(-36, -9)
    ctx.lineTo(-16, 5)
    ctx.closePath()
    ctx.fill()
  }
  ctx.lineCap = 'butt'
}

function player(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  camera: number,
  time: number,
  palette: string[],
) {
  const craft = state.player
  const charge = Math.min(1, Math.max(0, craft.charge / 100))
  const x = craft.x - camera
  const groundY = terrain(craft.x, state.seed)
  const altitude = Math.max(0, groundY - craft.y)
  ctx.save()
  ctx.fillStyle = palette[9]
  ctx.globalAlpha = Math.max(0.03, 0.17 - altitude / 1800)
  ctx.beginPath()
  ctx.ellipse(x, groundY + 7, Math.max(14, 34 - altitude / 30), 4.3, 0, 0, TAU)
  ctx.fill()
  ctx.restore()

  if (craft.trail.length > 1) {
    for (let layer = 0; layer < 2; layer++) {
      ctx.beginPath()
      craft.trail.forEach((point, i) => {
        const tx = point.x - camera
        if (i === 0) ctx.moveTo(tx, point.y + 9)
        else ctx.lineTo(tx, point.y + 9)
      })
      ctx.strokeStyle = palette[10]
      ctx.globalAlpha = layer === 0 ? 0.1 : craft.boostTime > 0 ? 0.68 : 0.34
      ctx.lineWidth = layer === 0 ? 12 : 2
      ctx.lineCap = 'round'
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    ctx.lineCap = 'butt'
  }

  ctx.save()
  ctx.translate(x, craft.y)
  ctx.rotate(craft.rotation)
  if (craft.boostTime > 0) {
    const boost = ctx.createLinearGradient(-145, 0, -10, 0)
    boost.addColorStop(0, '#fff1b100')
    boost.addColorStop(0.7, '#ffeca647')
    boost.addColorStop(1, '#fff5c1cc')
    ctx.fillStyle = boost
    ctx.beginPath()
    ctx.moveTo(-21, -5)
    ctx.quadraticCurveTo(-78, -12, -150, 8 + Math.sin(time * 18) * 3)
    ctx.quadraticCurveTo(-79, 21, -20, 15)
    ctx.fill()
  }
  if (craft.invincible > 0 || craft.boostTime > 0) {
    ctx.strokeStyle = palette[11]
    ctx.globalAlpha =
      craft.boostTime > 0 ? 0.5 : 0.25 + Math.sin(time * 10) * 0.16
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.ellipse(0, -21, 48, 55, -0.2, 0.3, 5.6)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  if (craft.invincible > 0 && Math.sin(time * 23) > 0.45) ctx.globalAlpha = 0.55
  drawShip(ctx, state.ship, time, palette, charge)
  ctx.restore()

  if (charge > 0.08 && craft.grounded) {
    ctx.strokeStyle = palette[10]
    ctx.globalAlpha = charge * 0.8
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.ellipse(
      x,
      craft.y + 15,
      33 + charge * 10,
      7,
      craft.rotation,
      Math.PI * 0.08,
      Math.PI * 0.92,
    )
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/** Draw in CSS pixels without changing the caller's device-pixel-ratio transform. */
export function renderWorld(
  ctx: CanvasRenderingContext2D,
  state: GameState,
  width: number,
  height: number,
  ambientTime: number,
  reducedMotion: boolean,
  personalBest = 0,
): void {
  if (width <= 0 || height <= 0) return
  const ready = state.phase === 'ready'
  // Portrait play keeps enough course ahead for a deliberate jump at full speed.
  // Extend the sky and sand instead of cropping or stretching the physical world.
  const scale = ready
    ? height / WORLD_HEIGHT
    : Math.min(height / WORLD_HEIGHT, width / 900)
  const w = width / scale
  const verticalOffset = Math.max(0, height / scale - WORLD_HEIGHT) * 0.45
  const top = -verticalOffset
  const bottom = height / scale - verticalOffset
  const camera = state.player.x - w * (ready ? 0.64 : 0.25)
  const time = reducedMotion ? state.time : ambientTime
  const palette = colors(state.distance)

  ctx.save()
  ctx.scale(scale, scale)
  ctx.translate(0, verticalOffset)
  ctx.lineJoin = 'round'
  sky(ctx, w, camera, time, palette, ready, state.distance, top, bottom)
  mountains(ctx, w, camera, palette)

  ctx.save()
  if (!reducedMotion && state.shake > 0) {
    const amount = Math.min(8, state.shake * 6)
    ctx.translate(
      Math.sin(time * 93) * amount,
      Math.cos(time * 117) * amount * 0.6,
    )
  }
  ground(ctx, w, camera, state.seed, palette, bottom)
  personalHorizon(ctx, state, w, camera, scale, personalBest, palette)

  for (const entity of state.entities) {
    const x = entity.x - camera
    if (entity.collected || x < -100 || x > w + 100) continue
    if (entity.kind === 'rock' || entity.kind === 'storm')
      hazard(ctx, entity, x, time)
    else collectible(ctx, entity, x, time, palette)
  }

  for (const particle of state.particles) {
    const x = particle.x - camera
    if (x < -30 || x > w + 30) continue
    ctx.globalAlpha = Math.max(0, Math.min(1, particle.life / particle.maxLife))
    ctx.fillStyle = particle.color
    if (particle.size > 3) {
      diamond(ctx, x, particle.y, particle.size)
    } else {
      circle(ctx, x, particle.y, particle.size)
    }
    ctx.fill()
  }
  ctx.globalAlpha = 1
  player(ctx, state, camera, time, palette)
  ctx.restore()

  if (!reducedMotion && state.phase === 'running' && state.player.vx > 500) {
    const speed = Math.min(1, (state.player.vx - 500) / 500)
    ctx.strokeStyle = palette[2]
    ctx.globalAlpha = speed * 0.27
    ctx.lineWidth = 1
    for (let i = 0; i < 10; i++) {
      const x = mod(random(i + 93) * w - time * (110 + i * 11), w + 180) - 90
      const y = 100 + random(i + 54) * 520
      if (Math.abs(y - state.player.y) < 55) continue
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + 25 + speed * 65, y)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // A narrow film of warmth at the edges unifies the paper-cut silhouettes.
  const vignette = ctx.createLinearGradient(0, top, 0, bottom)
  vignette.addColorStop(0, '#502e4810')
  vignette.addColorStop(0.16, '#502e4800')
  vignette.addColorStop(0.79, '#502e4800')
  vignette.addColorStop(1, '#502e4824')
  ctx.fillStyle = vignette
  ctx.fillRect(0, top, w, bottom - top)
  ctx.restore()
}
