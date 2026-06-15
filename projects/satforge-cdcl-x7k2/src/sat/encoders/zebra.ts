// Einstein's "Zebra" puzzle as SAT. Five houses in a row, each with a unique color,
// nationality, drink, cigarette and pet. Fifteen clues pin everything down; the famous
// questions are "who drinks water?" and "who owns the zebra?". Encoded straight into
// CNF, a SAT solver reads the answer off in microseconds — and #SAT confirms the
// solution is unique (exactly one model).

import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export const ZEBRA_CATEGORIES = ['Color', 'Nationality', 'Drink', 'Smoke', 'Pet'] as const

export const ZEBRA_VALUES: string[][] = [
  ['Red', 'Green', 'Ivory', 'Yellow', 'Blue'],
  ['Englishman', 'Spaniard', 'Ukrainian', 'Norwegian', 'Japanese'],
  ['Coffee', 'Tea', 'Milk', 'Orange juice', 'Water'],
  ['Old Gold', 'Kools', 'Chesterfields', 'Lucky Strike', 'Parliaments'],
  ['Dog', 'Snails', 'Fox', 'Horse', 'Zebra'],
]

// Category / value indices used by the clues.
const COLOR = 0,
  NATION = 1,
  DRINK = 2,
  SMOKE = 3,
  PET = 4
const RED = 0,
  GREEN = 1,
  IVORY = 2,
  YELLOW = 3,
  BLUE = 4
const ENGLISH = 0,
  SPANIARD = 1,
  UKRAINIAN = 2,
  NORWEGIAN = 3,
  JAPANESE = 4
const COFFEE = 0,
  TEA = 1,
  MILK = 2,
  OJ = 3,
  WATER = 4
const OLD_GOLD = 0,
  KOOLS = 1,
  CHESTERFIELDS = 2,
  LUCKY_STRIKE = 3,
  PARLIAMENTS = 4
const DOG = 0,
  SNAILS = 1,
  FOX = 2,
  HORSE = 3,
  ZEBRA = 4

export interface ZebraSolution {
  /** houses[h][cat] = value index of category `cat` in house h (0 = leftmost). */
  houses: number[][]
  /** Nationality value index that drinks water. */
  waterDrinker: number
  /** Nationality value index that owns the zebra. */
  zebraOwner: number
}

export function encodeZebra(): { cnf: CNF; decode: (model: boolean[]) => ZebraSolution } {
  const b = new CnfBuilder()
  const N = 5
  // x(cat, val, house): category `cat` has value `val` in house `house`.
  const x = (cat: number, val: number, house: number) => (cat * N + val) * N + house + 1
  b.reserve(N * N * N)
  b.comments.push("Einstein's Zebra puzzle: 5 houses, 25 attributes, 15 clues")

  // Each (category, value) sits in exactly one house; each (category, house) holds
  // exactly one value.
  for (let cat = 0; cat < N; cat++) {
    for (let val = 0; val < N; val++) {
      const houses: number[] = []
      for (let h = 0; h < N; h++) houses.push(x(cat, val, h))
      b.exactlyOne(houses)
    }
    for (let h = 0; h < N; h++) {
      const vals: number[] = []
      for (let val = 0; val < N; val++) vals.push(x(cat, val, h))
      b.exactlyOne(vals)
    }
  }

  // ---- clue helpers ----
  // Two attributes share a house.
  const same = (catA: number, valA: number, catB: number, valB: number) => {
    for (let h = 0; h < N; h++) {
      b.add(-x(catA, valA, h), x(catB, valB, h))
      b.add(-x(catB, valB, h), x(catA, valA, h))
    }
  }
  // Attribute A is immediately to the right of attribute B.
  const immRight = (catA: number, valA: number, catB: number, valB: number) => {
    b.add(-x(catA, valA, 0)) // nothing is to the right of the leftmost house
    for (let h = 1; h < N; h++) b.add(-x(catA, valA, h), x(catB, valB, h - 1))
  }
  // Attributes A and B are in adjacent houses.
  const nextTo = (catA: number, valA: number, catB: number, valB: number) => {
    for (let h = 0; h < N; h++) {
      const opts: number[] = [-x(catA, valA, h)]
      if (h - 1 >= 0) opts.push(x(catB, valB, h - 1))
      if (h + 1 < N) opts.push(x(catB, valB, h + 1))
      b.add(...opts)
    }
  }
  const atHouse = (cat: number, val: number, h: number) => b.add(x(cat, val, h))

  // ---- the fifteen clues ----
  same(NATION, ENGLISH, COLOR, RED) // 2
  same(NATION, SPANIARD, PET, DOG) // 3
  same(DRINK, COFFEE, COLOR, GREEN) // 4
  same(NATION, UKRAINIAN, DRINK, TEA) // 5
  immRight(COLOR, GREEN, COLOR, IVORY) // 6
  same(SMOKE, OLD_GOLD, PET, SNAILS) // 7
  same(SMOKE, KOOLS, COLOR, YELLOW) // 8
  atHouse(DRINK, MILK, 2) // 9: middle house
  atHouse(NATION, NORWEGIAN, 0) // 10: first house
  nextTo(SMOKE, CHESTERFIELDS, PET, FOX) // 11
  nextTo(SMOKE, KOOLS, PET, HORSE) // 12
  same(SMOKE, LUCKY_STRIKE, DRINK, OJ) // 13
  same(NATION, JAPANESE, SMOKE, PARLIAMENTS) // 14
  nextTo(NATION, NORWEGIAN, COLOR, BLUE) // 15

  return {
    cnf: b.build(),
    decode: (model) => {
      const houses: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(-1))
      for (let cat = 0; cat < N; cat++)
        for (let val = 0; val < N; val++)
          for (let h = 0; h < N; h++) if (model[x(cat, val, h)]) houses[h][cat] = val
      const houseOf = (cat: number, val: number) => houses.findIndex((hh) => hh[cat] === val)
      const waterHouse = houseOf(DRINK, WATER)
      const zebraHouse = houseOf(PET, ZEBRA)
      return {
        houses,
        waterDrinker: waterHouse >= 0 ? houses[waterHouse][NATION] : -1,
        zebraOwner: zebraHouse >= 0 ? houses[zebraHouse][NATION] : -1,
      }
    },
  }
}
