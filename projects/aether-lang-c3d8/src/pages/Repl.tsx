import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { evalRepl } from '../repl.ts'

interface LogEntry {
  prompt: string
  result: string
  ok: boolean
}

const SAMPLES = [
  'let double = fn x -> x * 2',
  'double 21',
  'type Tree a = Leaf | Node (Tree a) a (Tree a)',
  'let rec size t = match t with | Leaf -> 0 | Node l _ r -> 1 + size l + size r',
  'size (Node Leaf 1 (Node Leaf 2 Leaf))',
]

export default function Repl() {
  const [defs, setDefs] = useState<string[]>([])
  const [log, setLog] = useState<LogEntry[]>([])
  const [input, setInput] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [histIdx, setHistIdx] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [log])

  const submit = (): void => {
    const text = input.trim()
    if (!text) return
    const outcome = evalRepl(defs, text)
    setLog((l) => [...l, { prompt: text, result: outcome.display, ok: outcome.ok }])
    if (outcome.newDef) setDefs((d) => [...d, outcome.newDef as string])
    setHistory((h) => [...h, text])
    setHistIdx(null)
    setInput('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    // up/down recall previous inputs (when caret on the single line)
    if (e.key === 'ArrowUp' && !input.includes('\n')) {
      e.preventDefault()
      if (history.length === 0) return
      const next = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1)
      setHistIdx(next)
      setInput(history[next])
    } else if (e.key === 'ArrowDown' && histIdx !== null) {
      e.preventDefault()
      if (histIdx >= history.length - 1) {
        setHistIdx(null)
        setInput('')
      } else {
        setHistIdx(histIdx + 1)
        setInput(history[histIdx + 1])
      }
    }
  }

  const reset = (): void => {
    setDefs([])
    setLog([])
    setInput('')
    setHistory([])
    setHistIdx(null)
  }

  const loadSamples = (): void => {
    let d = [...defs]
    const entries: LogEntry[] = []
    for (const s of SAMPLES) {
      const outcome = evalRepl(d, s)
      entries.push({ prompt: s, result: outcome.display, ok: outcome.ok })
      if (outcome.newDef) d = [...d, outcome.newDef]
    }
    setDefs(d)
    setLog((l) => [...l, ...entries])
    setHistory((h) => [...h, ...SAMPLES])
  }

  return (
    <div className="page repl-page">
      <h1>REPL</h1>
      <p className="page-lead">
        An interactive prompt. Type an expression to evaluate it, or a bare <code>let</code> /{' '}
        <code>type</code> to add a definition that stays in scope for everything after it. Enter
        runs; Shift+Enter inserts a newline; ↑/↓ recall history.
      </p>

      <div className="repl-toolbar">
        <button className="btn" onClick={loadSamples}>
          ▶ Run sample session
        </button>
        <button className="btn" onClick={reset}>
          ⟲ Reset
        </button>
        <span className="repl-count">{defs.length} definition{defs.length === 1 ? '' : 's'} in scope</span>
      </div>

      <div className="repl-console" ref={scrollRef}>
        {log.length === 0 && <div className="repl-hint">The session is empty — try an expression like <code>1 + 2</code>.</div>}
        {log.map((e, i) => (
          <div className="repl-entry" key={i}>
            <div className="repl-in">
              <span className="repl-caret">›</span>
              <pre>{e.prompt}</pre>
            </div>
            <pre className={`repl-out ${e.ok ? '' : 'err'}`}>{e.result}</pre>
          </div>
        ))}
      </div>

      <div className="repl-input-row">
        <span className="repl-caret">›</span>
        <textarea
          className="repl-input"
          value={input}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          rows={1}
          placeholder="expression, or let / type definition…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
