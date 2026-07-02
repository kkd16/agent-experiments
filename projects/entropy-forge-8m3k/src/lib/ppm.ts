// ppm.ts — PPM (Prediction by Partial Matching), the context-modelling coder that
// held the top of the compression benchmarks for years and still underpins the
// PPMd in 7-Zip/RAR. The idea sits one level above order-1 arithmetic: instead of
// a single previous byte, PPM keeps a *stack* of context models of orders
// 0..N and, for each symbol, tries the **longest** matching context first. If the
// symbol has been seen in that context it is coded there (cheaply, because a long
// context predicts sharply); if not, the model emits an **escape** and falls back
// to the next shorter context — repeating down to a uniform order-(−1) model that
// can always code any byte. This is PPMC: the escape probability in a context is
// proportional to the number of *distinct* symbols seen there (Moffat's method C),
// and once we escape past a context every symbol it contains is **excluded** from
// the lower orders (they were already given their chance), which sharpens the
// remaining distribution. Encoder and decoder walk the identical model and the
// identical exclusion set at every step, so the range-coded stream round-trips.
//
// The payoff to *show*: raising the maximum order lifts compression on structured
// text with sharply diminishing returns — the essence of "how much does more
// context buy you?" made measurable.

import { RangeDecoder, RangeEncoder } from './rangecoder.ts'

const ALPHABET = 256
const ESCAPE = -1

// A context: how often each symbol followed this exact suffix, plus a running
// total. `distinct` (= symbols.size) doubles as the PPMC escape count.
interface Context {
  counts: Map<number, number>
  total: number
}

class PPMModel {
  readonly maxOrder: number
  // One table of contexts per order; key = packed previous bytes.
  private tables: Map<string, Context>[]

  constructor(maxOrder: number) {
    this.maxOrder = maxOrder
    this.tables = Array.from({ length: maxOrder + 1 }, () => new Map<string, Context>())
  }

  ctxKey(history: number[], order: number): string {
    if (order === 0) return ''
    const start = history.length - order
    let k = ''
    for (let i = start; i < history.length; i++) k += String.fromCharCode(history[i])
    return k
  }

  get(order: number, key: string): Context | undefined {
    return this.tables[order].get(key)
  }

  /** Increment count(sym) in every order-0..maxOrder context of `history`. */
  update(history: number[], sym: number) {
    const top = Math.min(this.maxOrder, history.length)
    for (let order = 0; order <= top; order++) {
      const key = this.ctxKey(history, order)
      let ctx = this.tables[order].get(key)
      if (!ctx) {
        ctx = { counts: new Map(), total: 0 }
        this.tables[order].set(key, ctx)
      }
      ctx.counts.set(sym, (ctx.counts.get(sym) ?? 0) + 1)
      ctx.total += 1
    }
  }
}

// Per-symbol record for the visualiser: which order finally coded it and how many
// escapes it took to get there (a proxy for "how surprising" the byte was).
export interface PPMStep {
  symbol: number
  codedAtOrder: number // order that coded it (−1 = uniform fallback)
  escapes: number // escapes emitted before it was coded
}

export interface PPMResult {
  encoded: Uint8Array
  encodedBits: number
  steps: PPMStep[]
  perOrderCoded: number[] // index o+1 → count of symbols coded at order o (index 0 = order −1)
}

// Build the (symbol → [cumLow, cumHigh)) layout of a context under the current
// exclusion set, in ascending symbol order, with the escape slot on top. This is
// the single source of truth both encoder and decoder call, guaranteeing identical
// ranges. Returns null if the context contributes nothing (all symbols excluded).
function layout(ctx: Context, excluded: Set<number>): {
  order: number[] // present, non-excluded symbols, ascending
  cum: Map<number, number> // symbol → cumLow
  sumCounts: number
  escFreq: number
  total: number
} | null {
  const order: number[] = []
  for (const s of ctx.counts.keys()) if (!excluded.has(s)) order.push(s)
  if (order.length === 0) return null
  order.sort((a, b) => a - b)
  const cum = new Map<number, number>()
  let acc = 0
  for (const s of order) {
    cum.set(s, acc)
    acc += ctx.counts.get(s)!
  }
  const sumCounts = acc
  const escFreq = order.length // PPMC: escape count = number of distinct symbols
  return { order, cum, sumCounts, escFreq, total: sumCounts + escFreq }
}

// The list of orders to try, longest first, ending at the order-0 model.
function ordersToTry(model: PPMModel, historyLen: number): number[] {
  const top = Math.min(model.maxOrder, historyLen)
  const list: number[] = []
  for (let o = top; o >= 0; o--) list.push(o)
  return list
}

export function ppmEncode(data: Uint8Array, maxOrder = 3): PPMResult {
  const model = new PPMModel(maxOrder)
  const enc = new RangeEncoder()
  const history: number[] = []
  const steps: PPMStep[] = []
  const perOrderCoded = new Array<number>(maxOrder + 2).fill(0)

  for (let i = 0; i < data.length; i++) {
    const sym = data[i]
    const excluded = new Set<number>()
    let escapes = 0
    let coded = false
    let codedAtOrder = ESCAPE

    for (const order of ordersToTry(model, history.length)) {
      const ctx = model.get(order, model.ctxKey(history, order))
      if (!ctx) continue
      const lay = layout(ctx, excluded)
      if (!lay) continue
      const cl = lay.cum.get(sym)
      if (cl !== undefined) {
        // Symbol lives here → code its range and stop.
        const freq = ctx.counts.get(sym)!
        enc.encode(cl, cl + freq, lay.total)
        coded = true
        codedAtOrder = order
        break
      } else {
        // Escape: code the escape slot [sumCounts, total), then exclude everything
        // this context has seen and drop to a shorter context.
        enc.encode(lay.sumCounts, lay.total, lay.total)
        escapes++
        for (const s of lay.order) excluded.add(s)
      }
    }

    if (!coded) {
      // Order −1: a uniform model over every byte not yet excluded.
      const remaining: number[] = []
      for (let s = 0; s < ALPHABET; s++) if (!excluded.has(s)) remaining.push(s)
      const idx = remaining.indexOf(sym)
      enc.encode(idx, idx + 1, remaining.length)
      codedAtOrder = ESCAPE
    }

    steps.push({ symbol: sym, codedAtOrder, escapes })
    perOrderCoded[codedAtOrder + 1]++
    model.update(history, sym)
    history.push(sym)
  }

  const encodedBits = enc.bitLength
  return { encoded: enc.finish(), encodedBits, steps, perOrderCoded }
}

export function ppmDecode(encoded: Uint8Array, length: number, maxOrder = 3): Uint8Array {
  const model = new PPMModel(maxOrder)
  const dec = new RangeDecoder(encoded)
  const history: number[] = []
  const out = new Uint8Array(length)

  for (let i = 0; i < length; i++) {
    const excluded = new Set<number>()
    let sym = -1

    for (const order of ordersToTry(model, history.length)) {
      const ctx = model.get(order, model.ctxKey(history, order))
      if (!ctx) continue
      const lay = layout(ctx, excluded)
      if (!lay) continue
      const dv = dec.decodeFreq(lay.total)
      if (dv >= lay.sumCounts) {
        // Escape slot → mirror the encoder: commit escape, exclude, continue.
        dec.decodeUpdate(lay.sumCounts, lay.total, lay.total)
        for (const s of lay.order) excluded.add(s)
        continue
      }
      // Locate the symbol whose cumulative band contains dv.
      for (const s of lay.order) {
        const cl = lay.cum.get(s)!
        const freq = ctx.counts.get(s)!
        if (dv >= cl && dv < cl + freq) {
          dec.decodeUpdate(cl, cl + freq, lay.total)
          sym = s
          break
        }
      }
      if (sym >= 0) break
    }

    if (sym < 0) {
      // Order −1 uniform fallback.
      const remaining: number[] = []
      for (let s = 0; s < ALPHABET; s++) if (!excluded.has(s)) remaining.push(s)
      const dv = dec.decodeFreq(remaining.length)
      sym = remaining[dv]
      dec.decodeUpdate(dv, dv + 1, remaining.length)
    }

    out[i] = sym
    model.update(history, sym)
    history.push(sym)
  }
  return out
}
