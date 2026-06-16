// Aether — WebAssembly backend driver
//
// Ties the three pieces together: compile the core AST to a `.wasm` module
// (`codegen.ts`), build the host bridge (`bridge.ts`), instantiate the real
// module via `WebAssembly.instantiate`, run `main`, and decode the result.

import type { Expr } from '../lang/ast.ts'
import type { TurtleCmd } from '../lang/values.ts'
import { valueToString } from '../lang/values.ts'
import { makeBridge } from './bridge.ts'
import { compileToWasm } from './codegen.ts'
import type { WasmModule } from './codegen.ts'

/** Live heap accounting read back from the module after `main` ran. */
export interface WasmHeapStats {
  /** number of `__alloc` calls (cells handed out by the bump allocator) */
  allocCount: number
  /** total bytes the bump allocator handed out */
  allocBytes: number
  /** integers served from the shared small-int cache instead of a fresh box */
  cacheHits: number
}

export interface WasmRunResult {
  result: string | null
  output: string[]
  effects: TurtleCmd[]
  error: string | null
  module: WasmModule
  heap: WasmHeapStats | null
}

interface WasmExports {
  memory: WebAssembly.Memory
  __alloc: (n: number) => number
  main: () => number
  __allocCount?: () => number
  __allocBytes?: () => number
  __cacheHits?: () => number
}

/** Compile, instantiate and run the program on the WebAssembly backend. */
export async function runWasm(userCoreAst: Expr): Promise<WasmRunResult> {
  const module = compileToWasm(userCoreAst)
  const bridge = makeBridge({
    stringLiterals: module.stringLiterals,
    ctorNames: module.ctorNames,
    labels: module.labels,
  })
  try {
    const { instance } = await WebAssembly.instantiate(module.bytes as BufferSource, bridge.imports)
    const exports = instance.exports as unknown as WasmExports
    bridge.ctx.memory = exports.memory
    bridge.ctx.alloc = exports.__alloc
    const ptr = exports.main()
    const value = bridge.decode(ptr)
    const heap: WasmHeapStats | null = exports.__allocCount
      ? {
          allocCount: exports.__allocCount(),
          allocBytes: exports.__allocBytes ? exports.__allocBytes() : 0,
          cacheHits: exports.__cacheHits ? exports.__cacheHits() : 0,
        }
      : null
    return { result: valueToString(value), output: bridge.output, effects: bridge.effects, error: null, module, heap }
  } catch (e) {
    return {
      result: null,
      output: bridge.output,
      effects: bridge.effects,
      error: e instanceof Error ? e.message : String(e),
      module,
      heap: null,
    }
  }
}

/** Compile only — for showing module statistics without executing. */
export function compileWasm(userCoreAst: Expr): WasmModule {
  return compileToWasm(userCoreAst)
}

/** A compact hex dump of the module bytes (16 per row, offsets on the left). */
export function hexDump(bytes: Uint8Array, maxRows = 64): string {
  const rows: string[] = []
  for (let i = 0; i < bytes.length && rows.length < maxRows; i += 16) {
    const slice = Array.from(bytes.slice(i, i + 16))
    const hex = slice.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const off = i.toString(16).padStart(6, '0')
    rows.push(`${off}  ${hex}`)
  }
  if (bytes.length > maxRows * 16) rows.push(`… (${bytes.length} bytes total)`)
  return rows.join('\n')
}

/** Decode the module's top-level section table into a human-readable summary. */
export function sectionSummary(bytes: Uint8Array): { id: number; name: string; size: number }[] {
  const NAMES: Record<number, string> = {
    1: 'type',
    2: 'import',
    3: 'function',
    4: 'table',
    5: 'memory',
    6: 'global',
    7: 'export',
    8: 'start',
    9: 'element',
    10: 'code',
    11: 'data',
  }
  const out: { id: number; name: string; size: number }[] = []
  let i = 8 // skip magic + version
  while (i < bytes.length) {
    const id = bytes[i++]
    let size = 0
    let shift = 0
    for (;;) {
      const b = bytes[i++]
      size |= (b & 0x7f) << shift
      if ((b & 0x80) === 0) break
      shift += 7
    }
    out.push({ id, name: NAMES[id] ?? `#${id}`, size })
    i += size
  }
  return out
}
