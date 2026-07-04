// Vector (SVG) export. Re-draws the world as scalable paths so an atlas can be
// printed or edited: filled Voronoi cells, coastline, rivers, roads, province
// borders, place labels and city markers. It shares the exact fill logic the canvas
// renderer uses (regionColor + hillshade) so the SVG matches the on-screen map.

import type { WorldMap } from '../core/types'
import { paletteByKey, rgbToCss } from './palettes'
import { computeShade, regionColor } from './render'
import type { ViewOptions } from '../ui/viewOptions'

const nextHalfedge = (e: number): number => (e % 3 === 2 ? e - 2 : e + 1)
const triangleOfEdge = (e: number): number => Math.floor(e / 3)
const f1 = (v: number): string => (Math.round(v * 10) / 10).toString()
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function cellPoints(world: WorldMap, r: number): string {
  const tris = world.mesh.cellTriangles[r]
  if (tris.length < 3) return ''
  const { cx, cy } = world.mesh
  let s = ''
  for (const t of tris) s += `${f1(cx[t])},${f1(cy[t])} `
  return s.trim()
}

export function worldToSvg(world: WorldMap, view: ViewOptions): string {
  const W = world.params.width
  const H = world.params.height
  const pal = paletteByKey(view.paletteKey)
  const mesh = world.mesh
  const shade = view.showHillshade ? computeShade(world, pal.hillshade) : null
  const out: string[] = []

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
  )
  out.push(`<rect width="${W}" height="${H}" fill="${pal.background}"/>`)

  // --- Cells ---
  out.push('<g stroke-width="0.5">')
  for (let r = 0; r < mesh.numSolid; r++) {
    const pts = cellPoints(world, r)
    if (!pts) continue
    const css = rgbToCss(regionColor(world, r, pal, shade))
    out.push(`<polygon points="${pts}" fill="${css}" stroke="${css}"/>`)
  }
  out.push('</g>')

  // --- Province tints ---
  if (view.showProvinces) {
    out.push('<g>')
    for (let r = 0; r < mesh.numSolid; r++) {
      if (world.ocean[r] || world.lake[r] || world.province[r] < 0) continue
      const pts = cellPoints(world, r)
      if (!pts) continue
      const hue = (world.province[r] * 137.508 + 20) % 360
      out.push(
        `<polygon points="${pts}" fill="hsl(${hue.toFixed(0)},${pal.provinceSat}%,${pal.provinceLum}%)" fill-opacity="${pal.provinceAlpha}"/>`,
      )
    }
    out.push('</g>')
  }

  // Helper to emit a set of Voronoi edges as one path.
  const edgePath = (accept: (a: number, b: number) => boolean): string => {
    let d = ''
    const tri = mesh.triangles
    const half = mesh.halfedges
    for (let e = 0; e < tri.length; e++) {
      const opp = half[e]
      if (opp === -1 || opp < e) continue
      const a = tri[e]
      const b = tri[nextHalfedge(e)]
      if (!accept(a, b)) continue
      const t1 = triangleOfEdge(e)
      const t2 = triangleOfEdge(opp)
      d += `M${f1(mesh.cx[t1])},${f1(mesh.cy[t1])}L${f1(mesh.cx[t2])},${f1(mesh.cy[t2])}`
    }
    return d
  }

  if (view.showProvinces) {
    const d = edgePath(
      (a, b) =>
        a < mesh.numSolid &&
        b < mesh.numSolid &&
        !world.ocean[a] &&
        !world.ocean[b] &&
        !world.lake[a] &&
        !world.lake[b] &&
        world.province[a] !== world.province[b],
    )
    if (d) out.push(`<path d="${d}" fill="none" stroke="${pal.provinceLine}" stroke-width="1.1" stroke-dasharray="5 3"/>`)
  }

  if (view.showCoast) {
    const d = edgePath((a, b) => (world.ocean[a] || world.lake[a]) !== (world.ocean[b] || world.lake[b]))
    if (d) out.push(`<path d="${d}" fill="none" stroke="${pal.coast}" stroke-width="1.4" stroke-linejoin="round"/>`)
  }

  // --- Rivers ---
  if (view.showRivers && world.rivers.length) {
    let maxF = 0
    for (const rv of world.rivers) if (rv.flux > maxF) maxF = rv.flux
    out.push(`<g fill="none" stroke="${pal.water}" stroke-linecap="round">`)
    for (const rv of world.rivers) {
      const w = 0.6 + 3.4 * Math.sqrt(rv.flux / (maxF || 1))
      out.push(
        `<line x1="${f1(mesh.px[rv.a])}" y1="${f1(mesh.py[rv.a])}" x2="${f1(mesh.px[rv.b])}" y2="${f1(mesh.py[rv.b])}" stroke-width="${f1(w)}"/>`,
      )
    }
    out.push('</g>')
  }

  // --- Roads ---
  if (view.showRoads && world.roads.length) {
    for (const rd of world.roads) {
      let d = `M${f1(mesh.px[rd.path[0]])},${f1(mesh.py[rd.path[0]])}`
      for (let k = 1; k < rd.path.length; k++) d += `L${f1(mesh.px[rd.path[k]])},${f1(mesh.py[rd.path[k]])}`
      const w = rd.trunk ? 2.4 : 1.5
      out.push(`<path d="${d}" fill="none" stroke="${pal.roadCasing}" stroke-width="${f1(w + 1.6)}" stroke-linecap="round" stroke-linejoin="round"/>`)
      const dash = rd.trunk ? '' : ' stroke-dasharray="4 3"'
      out.push(`<path d="${d}" fill="none" stroke="${pal.road}" stroke-width="${f1(w)}" stroke-linecap="round" stroke-linejoin="round"${dash}/>`)
    }
  }

  // --- Geographic labels ---
  if (view.showLabels) {
    for (const l of world.labels) {
      const size = l.kind === 'kingdom' ? 15 + 15 * l.weight : l.kind === 'range' ? 11 + 6 * l.weight : 13 + 6 * l.weight
      const italic = l.kind !== 'kingdom' ? ' font-style="italic"' : ''
      const txt = l.kind === 'sea' || l.kind === 'lake' ? esc(l.text.toUpperCase()) : esc(l.text)
      const spacing = l.kind === 'sea' || l.kind === 'lake' ? ` letter-spacing="${f1(size * 0.14)}"` : ''
      out.push(
        `<text x="${f1(l.x)}" y="${f1(l.y)}" text-anchor="middle" dominant-baseline="middle" font-family="Georgia, serif" font-weight="600" font-size="${f1(size)}"${italic}${spacing} fill="${pal.labelFill}" stroke="${pal.labelStroke}" stroke-width="${f1(Math.max(2, size * 0.16))}" paint-order="stroke">${txt}</text>`,
      )
    }
  }

  // --- Cities ---
  if (view.showCities) {
    for (const c of world.cities) {
      const rad = 2.6 + c.tier * 1.5
      out.push(
        `<circle cx="${f1(c.x)}" cy="${f1(c.y)}" r="${f1(rad)}" fill="${pal.city}" stroke="${pal.cityStroke}" stroke-width="1.4"/>`,
      )
      if (c.tier >= 1 || c.capital) {
        const size = c.capital ? 15 : 10 + c.tier * 1.6
        const label = esc((c.capital ? '★ ' : '') + c.name)
        out.push(
          `<text x="${f1(c.x + 6)}" y="${f1(c.y)}" dominant-baseline="middle" font-family="Georgia, serif" font-weight="${c.capital ? 700 : 600}" font-size="${f1(size)}" fill="${pal.cityLabel}" stroke="${pal.cityLabelStroke}" stroke-width="${f1(Math.max(2, size * 0.16))}" paint-order="stroke">${label}</text>`,
        )
      }
    }
  }

  // --- Frame ---
  if (view.showFrame) {
    out.push(`<rect x="8" y="8" width="${W - 16}" height="${H - 16}" fill="none" stroke="${pal.frame}" stroke-width="2.4"/>`)
    out.push(`<rect x="13" y="13" width="${W - 26}" height="${H - 26}" fill="none" stroke="${pal.frame}" stroke-width="0.8"/>`)
  }

  out.push('</svg>')
  return out.join('\n')
}
