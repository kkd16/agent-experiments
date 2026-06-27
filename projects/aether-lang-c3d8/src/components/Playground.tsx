import { useCallback, useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'
import Editor from './Editor.tsx'
import type { Diagnostic } from './Editor.tsx'
import OutputView from './OutputView.tsx'
import CanvasView from './CanvasView.tsx'
import TokensPanel from './panels/TokensPanel.tsx'
import AstPanel from './panels/AstPanel.tsx'
import TypesPanel from './panels/TypesPanel.tsx'
import BytecodePanel from './panels/BytecodePanel.tsx'
import JsPanel from './panels/JsPanel.tsx'
import WasmPanel from './panels/WasmPanel.tsx'
import OptimizerPanel from './panels/OptimizerPanel.tsx'
import EqSatPanel from './panels/EqSatPanel.tsx'
import TerminationPanel from './panels/TerminationPanel.tsx'
import DerivationPanel from './panels/DerivationPanel.tsx'
import ClassesPanel from './panels/ClassesPanel.tsx'
import CheckPanel from './panels/CheckPanel.tsx'
import DebuggerPanel from './panels/DebuggerPanel.tsx'
import { runPipeline } from '../lang/pipeline.ts'
import type { PipelineResult } from '../lang/pipeline.ts'
import type { Snapshot } from '../lang/vm.ts'
import type { Span } from '../lang/lexer.ts'
import { DEFAULT_CODE, EXAMPLES } from '../examples.ts'
import {
  buildShareUrl,
  consumePendingCode,
  loadSavedCode,
  readShareParam,
  saveCode,
} from '../share.ts'

type Tab =
  | 'output'
  | 'canvas'
  | 'tokens'
  | 'ast'
  | 'types'
  | 'classes'
  | 'check'
  | 'deriv'
  | 'bytecode'
  | 'optimizer'
  | 'eqsat'
  | 'termination'
  | 'js'
  | 'wasm'
  | 'debug'

const TABS: { id: Tab; label: string }[] = [
  { id: 'output', label: 'Result' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'ast', label: 'AST' },
  { id: 'types', label: 'Types' },
  { id: 'classes', label: 'Classes' },
  { id: 'check', label: 'Check' },
  { id: 'deriv', label: 'Derivation' },
  { id: 'bytecode', label: 'Bytecode' },
  { id: 'optimizer', label: 'Optimizer' },
  { id: 'eqsat', label: 'Eq-Sat' },
  { id: 'termination', label: 'Termination' },
  { id: 'js', label: 'JavaScript' },
  { id: 'wasm', label: 'WebAssembly' },
  { id: 'debug', label: 'Debugger' },
]

export default function Playground() {
  const [code, setCode] = useState(
    () => consumePendingCode() ?? readShareParam() ?? loadSavedCode() ?? DEFAULT_CODE,
  )
  const [copied, setCopied] = useState(false)
  const [optimizeOn, setOptimizeOn] = useState(true)
  const [inlayOn, setInlayOn] = useState(true)
  const [runResult, setRunResult] = useState<PipelineResult | null>(null)
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null)
  const [traceNonce, setTraceNonce] = useState(0)
  const [tab, setTab] = useState<Tab>('output')
  const [debugSpan, setDebugSpan] = useState<Span | null>(null)

  // live analysis (no execution) — drives the static panels & error squiggle
  const analysis = useMemo(
    () => runPipeline(code, { execute: false, optimize: optimizeOn }),
    [code, optimizeOn],
  )

  // persist the buffer so it survives reloads
  useEffect(() => {
    saveCode(code)
  }, [code])

  const share = useCallback(() => {
    const url = buildShareUrl(code)
    const done = (): void => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done, done)
    } else {
      done()
    }
  }, [code])

  const doRun = useCallback(
    (record: boolean) => {
      const res = runPipeline(code, { execute: true, record, optimize: optimizeOn })
      setRunResult(res)
      setSnapshots(record ? (res.run?.snapshots ?? []) : null)
      if (record) {
        setTraceNonce((n) => n + 1)
        setTab('debug')
      } else if (res.run && res.run.effects.length > 0) {
        setTab('canvas')
      } else {
        setTab('output')
      }
    },
    [code, optimizeOn],
  )

  const onEditorKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      doRun(false)
    }
  }

  const onSpanChange = useCallback((s: Span | null) => setDebugSpan(s), [])

  const loadExample = (id: string): void => {
    const ex = EXAMPLES.find((e) => e.id === id)
    if (!ex) return
    setCode(ex.code)
    setRunResult(null)
    setSnapshots(null)
    setDebugSpan(null)
  }

  const editorError = analysis.error?.span ?? null
  const highlightSpan = tab === 'debug' ? debugSpan : null
  const warningSpans = useMemo(
    () => analysis.warnings.map((w) => w.span).filter((s): s is Span => s !== null),
    [analysis],
  )
  const diagnostics = useMemo<Diagnostic[]>(() => {
    const out: Diagnostic[] = []
    if (analysis.error?.span) {
      out.push({ span: analysis.error.span, message: analysis.error.message, severity: 'error' })
    }
    for (const w of analysis.warnings) {
      if (w.span) out.push({ span: w.span, message: w.message, severity: 'warning' })
    }
    return out
  }, [analysis])

  return (
    <div className="playground">
      <div className="pg-left" onKeyDown={onEditorKey}>
        <div className="pg-toolbar">
          <button className="btn primary" onClick={() => doRun(false)}>
            ▶ Run
          </button>
          <button className="btn" onClick={() => doRun(true)} title="Run and record a trace">
            ⏺ Debug
          </button>
          <select
            className="example-select"
            value=""
            onChange={(e) => {
              if (e.target.value) loadExample(e.target.value)
            }}
          >
            <option value="">Load example…</option>
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title}
                {ex.visual ? ' ✦' : ''}
              </option>
            ))}
          </select>
          <button className="btn" onClick={share} title="Copy a shareable link">
            {copied ? '✓ copied' : '⇗ share'}
          </button>
          <label className="opt-toggle" title="The optimizing middle-end (see the Optimizer tab)">
            <input
              type="checkbox"
              checked={optimizeOn}
              onChange={(e) => setOptimizeOn(e.target.checked)}
            />
            optimize
          </label>
          <label className="opt-toggle" title="Show inferred types inline at the end of each binding's line">
            <input
              type="checkbox"
              checked={inlayOn}
              onChange={(e) => setInlayOn(e.target.checked)}
            />
            hints
          </label>
          <span className="kbd-hint" title="⌘/Ctrl ↵ run · ⌘/Ctrl Space complete · F2 rename · ⌘/Ctrl-click go to definition">
            ⌘↵ · ⌘Space · F2
          </span>
        </div>

        <Editor
          value={code}
          onChange={setCode}
          errorSpan={editorError}
          highlightSpan={highlightSpan}
          warningSpans={warningSpans}
          ast={analysis.ast}
          typeResult={analysis.typeResult}
          diagnostics={diagnostics}
          showInlayHints={inlayOn}
        />

        <StatusBar analysis={analysis} />
      </div>

      <div className="pg-right">
        <div className="pg-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`pg-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="pg-content">
          {tab === 'output' && <OutputView result={runResult} hasRun={runResult !== null} />}
          {tab === 'canvas' && (
            <CanvasView effects={runResult?.run?.effects ?? []} animate={true} />
          )}
          {tab === 'tokens' && <TokensPanel tokens={analysis.tokens} />}
          {tab === 'ast' && <AstPanel ast={analysis.ast} typeResult={analysis.typeResult} />}
          {tab === 'types' && (
            <TypesPanel programType={analysis.programType} bindingTypes={analysis.bindingTypes} />
          )}
          {tab === 'classes' && (
            <ClassesPanel
              ast={analysis.ast}
              coreAst={analysis.coreAst}
              classKinds={analysis.typeResult?.classKinds ?? null}
            />
          )}
          {tab === 'check' && <CheckPanel code={code} />}
          {tab === 'deriv' && (
            <DerivationPanel ast={analysis.ast} typeResult={analysis.typeResult} />
          )}
          {tab === 'bytecode' && <BytecodePanel proto={analysis.proto} />}
          {tab === 'optimizer' && <OptimizerPanel code={code} />}
          {tab === 'eqsat' && <EqSatPanel code={code} />}
          {tab === 'termination' && <TerminationPanel code={code} />}
          {tab === 'js' && (
            <JsPanel ast={analysis.optimizedCoreAst} code={code} optimize={optimizeOn} />
          )}
          {tab === 'wasm' && (
            <WasmPanel ast={analysis.optimizedCoreAst} code={code} optimize={optimizeOn} />
          )}
          {tab === 'debug' && (
            <DebuggerPanel
              key={traceNonce}
              snapshots={snapshots}
              output={runResult?.run?.output ?? []}
              onSpanChange={onSpanChange}
              onRequestTrace={() => doRun(true)}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function StatusBar({ analysis }: { analysis: PipelineResult }) {
  if (analysis.error) {
    const { stage, message, span } = analysis.error
    return (
      <div className="status-bar error">
        <span className="status-stage">{stage}</span>
        {span && span.line > 0 && <span className="status-loc">{span.line}:{span.col}</span>}
        <span className="status-msg">{message}</span>
      </div>
    )
  }
  return (
    <div className="status-stack">
      <div className="status-bar ok">
        <span className="status-check">✓</span>
        <span className="status-msg">
          type-checks · <code>{analysis.programType}</code>
          {analysis.foldCount > 0 && (
            <span className="status-fold"> · optimizer: {analysis.foldCount} rewrites</span>
          )}
        </span>
      </div>
      {analysis.warnings.map((w, i) => (
        <div className="status-bar warn" key={i}>
          <span className="status-stage">warning</span>
          {w.span && w.span.line > 0 && (
            <span className="status-loc">
              {w.span.line}:{w.span.col}
            </span>
          )}
          <span className="status-msg">{w.message}</span>
        </div>
      ))}
    </div>
  )
}
