// The CSS Color 4 named colors and a perceptual "what's this color called?" lookup.
//
// We store each name's sRGB once, then answer `nearestNamedColor` by minimising CIEDE2000 — the
// same metric a human eye roughly uses — so "a slightly muddy teal" resolves to the closest name
// rather than whatever happens to share two hex digits.

import { deltaE2000 } from './difference'
import type { RGB } from './types'

// name → 0xRRGGBB. The full CSS named-color set (148 entries; 'aqua'/'cyan' &
// 'fuchsia'/'magenta' &c. share values — we keep the canonical spelling).
const HEX: Record<string, number> = {
  black: 0x000000, silver: 0xc0c0c0, gray: 0x808080, white: 0xffffff, maroon: 0x800000,
  red: 0xff0000, purple: 0x800080, fuchsia: 0xff00ff, green: 0x008000, lime: 0x00ff00,
  olive: 0x808000, yellow: 0xffff00, navy: 0x000080, blue: 0x0000ff, teal: 0x008080,
  aqua: 0x00ffff, aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aquamarine: 0x7fffd4,
  azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, blanchedalmond: 0xffebcd,
  blueviolet: 0x8a2be2, brown: 0xa52a2a, burlywood: 0xdeb887, cadetblue: 0x5f9ea0,
  chartreuse: 0x7fff00, chocolate: 0xd2691e, coral: 0xff7f50, cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc, crimson: 0xdc143c, darkblue: 0x00008b, darkcyan: 0x008b8b,
  darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493,
  deepskyblue: 0x00bfff, dimgray: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222,
  floralwhite: 0xfffaf0, forestgreen: 0x228b22, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff,
  gold: 0xffd700, goldenrod: 0xdaa520, greenyellow: 0xadff2f, honeydew: 0xf0fff0,
  hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c,
  lavender: 0xe6e6fa, lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6, lightcoral: 0xf08080, lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightpink: 0xffb6c1, lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa, lightslategray: 0x778899,
  lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, limegreen: 0x32cd32, linen: 0xfaf0e6,
  mediumaquamarine: 0x66cdaa, mediumblue: 0x0000cd, mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db, mediumseagreen: 0x3cb371, mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
  midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5,
  navajowhite: 0xffdead, oldlace: 0xfdf5e6, olivedrab: 0x6b8e23, orange: 0xffa500,
  orangered: 0xff4500, orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98,
  paleturquoise: 0xafeeee, palevioletred: 0xdb7093, papayawhip: 0xffefd5, peachpuff: 0xffdab9,
  peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6, rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1, saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460,
  seagreen: 0x2e8b57, seashell: 0xfff5ee, sienna: 0xa0522d, skyblue: 0x87ceeb,
  slateblue: 0x6a5acd, slategray: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f,
  steelblue: 0x4682b4, tan: 0xd2b48c, thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0,
  violet: 0xee82ee, wheat: 0xf5deb3, whitesmoke: 0xf5f5f5, yellowgreen: 0x9acd32, rebeccapurple: 0x663399,
}

export interface NamedColor {
  name: string
  rgb: RGB
}

const NAMED: NamedColor[] = Object.entries(HEX).map(([name, v]) => ({
  name,
  rgb: { r: ((v >> 16) & 255) / 255, g: ((v >> 8) & 255) / 255, b: (v & 255) / 255 },
}))

export const NAMED_COLORS: ReadonlyArray<NamedColor> = NAMED

export interface NearestNamed extends NamedColor {
  /** ΔE2000 between the query and this name (0 = exact). */
  delta: number
}

/** The CSS named color perceptually closest to a query, by CIEDE2000. */
export function nearestNamedColor(rgb: RGB): NearestNamed {
  let best = NAMED[0]
  let bestD = Infinity
  for (const n of NAMED) {
    const d = deltaE2000(rgb, n.rgb)
    if (d < bestD) {
      bestD = d
      best = n
    }
  }
  return { ...best, delta: bestD }
}
