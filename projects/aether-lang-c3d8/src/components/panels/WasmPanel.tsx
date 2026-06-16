import { useMemo, useState } from 'react'
import type { Expr } from '../../lang/ast.ts'
import { runPipeline } from '../../lang/pipeline.ts'
import { valueToString } from '../../lang/values.ts'
import { compileWasm, hexDump, runWasm, sectionSummary } from '../../wasm/run.ts'
import type { WasmRunResult } from '../../wasm/run.ts'
import { disassemble } from '../../wasm/disasm.ts'

interface Props {
  /** the elaborated (dictionary-passed) core AST — what actually compiles */
  ast: Expr | null
  /** the current editor source, for running the VM side-by-side */
  code: string
  optimize: boolean
}

interface Comparison {
  wasm: WasmRunResult
  vmResult: string | null
  vmOutput: string[]
  vmEffects: number
  matches: boolean
}

export default function WasmPanel({ ast, code, optimize }: Props) {
  const compiled = useMemo(() => {
    if (!ast) return null
    try {
      return { module: compileWasm(ast), error: null as string | null }
    } catch (e) {
      return { module: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [ast])

  const wat = useMemo(() => {
    if (!compiled?.module) return null
    try {
      return disassemble(compiled.module.bytes)
    } catch {
      return null
    }
  }, [compiled])

  const [cmp, setCmp] = useState<Comparison | null>(null)
  const [busy, setBusy] = useState(false)
  const [showWat, setShowWat] = useState(true)
  const [showHex, setShowHex] = useState(false)

  const run = async (): Promise<void> => {
    if (!ast) return
    setBusy(true)
    try {
      const wasm = await runWasm(ast)
      const vm = runPipeline(code, { execute: true, optimize })
      const vmResult = vm.run?.result ? valueToString(vm.run.result) : vm.error ? null : '()'
      const vmOutput = vm.run?.output ?? []
      const vmEffects = vm.run?.effects.length ?? 0
      const matches =
        wasm.error === null &&
        wasm.result === vmResult &&
        JSON.stringify(wasm.output) === JSON.stringify(vmOutput) &&
        wasm.effects.length === vmEffects
      setCmp({ wasm, vmResult, vmOutput, vmEffects, matches })
    } finally {
      setBusy(false)
    }
  }

  const download = (): void => {
    if (!compiled?.module) return
    const blob = new Blob([compiled.module.bytes as BlobPart], { type: 'application/wasm' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'aether.wasm'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!ast) return <div className="panel-empty">No WebAssembly — fix the error first.</div>
  if (compiled?.error)
    return (
      <div className="panel-empty">
        This program uses a feature the WASM backend doesn&apos;t lower yet.
        <pre className="wasm-err">{compiled.error}</pre>
      </div>
    )

  const module = compiled?.module
  const sections = module ? sectionSummary(module.bytes) : []

  return (
    <div className="js-panel">
      <p className="panel-note">
        A third backend: the same typed AST is lowered to a real <strong>WebAssembly</strong> module —
        hand-assembled to bytes here in the browser (no <code>wabt</code>, no <code>binaryen</code>) —
        then instantiated and run by the engine. A bump allocator (with a shared small-integer cache),
        closures via <code>call_indirect</code>, arithmetic and <code>match</code> run as native WASM;
        printing, <code>show</code>, comparison and the turtle are imports that reuse the VM&apos;s own code,
        so the result matches the bytecode VM byte-for-byte. The module carries a <code>name</code> section
        and reads back as <strong>WAT text</strong> below, disassembled from its own bytes.
      </p>

      <div className="js-toolbar">
        <button className="btn primary" onClick={run} disabled={busy}>
          {busy ? '… running' : '▶ Run WebAssembly & compare'}
        </button>
        {module && (
          <button className="btn" onClick={download} title="Download the .wasm module">
            ⇩ aether.wasm
          </button>
        )}
        {cmp && (
          <span className={`js-badge ${cmp.matches ? 'ok' : 'bad'}`}>
            {cmp.matches ? '✓ matches the VM' : '✗ differs from the VM'}
          </span>
        )}
      </div>

      {cmp && (
        <div className="js-run">
          {cmp.wasm.error ? (
            <div className="run-error">
              <span className="err-stage">runtime error</span>
              <div className="err-msg">{cmp.wasm.error}</div>
            </div>
          ) : (
            <div className="js-cols">
              <div className="js-col">
                <div className="js-col-head">WebAssembly backend</div>
                <div className="result-line">
                  <span className="result-label">result</span>
                  <code className="result-value">{cmp.wasm.result}</code>
                </div>
                {cmp.wasm.output.length > 0 && <pre className="js-out">{cmp.wasm.output.join('\n')}</pre>}
                {cmp.wasm.effects.length > 0 && (
                  <div className="run-stats">{cmp.wasm.effects.length.toLocaleString()} draw commands</div>
                )}
                {cmp.wasm.heap && (
                  <div className="run-stats">
                    {cmp.wasm.heap.allocCount.toLocaleString()} cells allocated (
                    {cmp.wasm.heap.allocBytes.toLocaleString()} B);{' '}
                    {cmp.wasm.heap.cacheHits.toLocaleString()} ints served from the small-int cache
                  </div>
                )}
              </div>
              <div className="js-col">
                <div className="js-col-head">bytecode VM</div>
                <div className="result-line">
                  <span className="result-label">result</span>
                  <code className="result-value">{cmp.vmResult ?? '—'}</code>
                </div>
                {cmp.vmOutput.length > 0 && <pre className="js-out">{cmp.vmOutput.join('\n')}</pre>}
                {cmp.vmEffects > 0 && (
                  <div className="run-stats">{cmp.vmEffects.toLocaleString()} draw commands</div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {module && (
        <>
          <div className="wasm-stats">
            <span>
              <strong>{module.bytes.length.toLocaleString()}</strong> bytes
            </span>
            <span>
              <strong>{module.stats.funcCount}</strong> functions
            </span>
            <span>
              <strong>{module.stats.importCount}</strong> imports
            </span>
            <span>
              <strong>{module.stats.globalCount}</strong> globals
            </span>
          </div>

          <div className="js-code-block">
            <div className="js-code-head">module sections</div>
            <table className="wasm-sections">
              <tbody>
                {sections.map((s, i) => (
                  <tr key={i}>
                    <td className="wsec-id">{s.id}</td>
                    <td className="wsec-name">{s.name}</td>
                    <td className="wsec-size">{s.size.toLocaleString()} B</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button className="js-disclose" onClick={() => setShowWat((s) => !s)}>
            {showWat ? '▾' : '▸'} disassembly (WAT text format)
            {wat && <span className="wasm-wat-meta"> — {wat.instructions.toLocaleString()} instructions, decoded from the bytes</span>}
          </button>
          {showWat &&
            (wat ? (
              <>
                <p className="panel-note wasm-wat-note">
                  Round-tripped back from the module bytes by a from-scratch WAT disassembler — the mirror
                  image of the encoder, also library-free. Names come from the emitted <code>name</code>{' '}
                  section, so calls read <code>call $map</code> instead of <code>call 27</code>.
                </p>
                <pre className="js-code wasm-wat">{wat.header}</pre>
                {wat.funcs.map((f) => (
                  <details key={f.index} className="wasm-func">
                    <summary>{f.name}</summary>
                    <pre className="js-code wasm-wat">{f.wat}</pre>
                  </details>
                ))}
              </>
            ) : (
              <pre className="js-code dim">disassembly unavailable</pre>
            ))}

          <button className="js-disclose" onClick={() => setShowHex((s) => !s)}>
            {showHex ? '▾' : '▸'} module bytes (hex)
          </button>
          {showHex && <pre className="js-code dim wasm-hex">{hexDump(module.bytes)}</pre>}
        </>
      )}
    </div>
  )
}
