import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, MouseEvent, UIEvent } from 'react'
import { highlight } from '../highlight.ts'
import type { Span } from '../lang/lexer.ts'
import type { Expr } from '../lang/ast.ts'
import type { InferResult } from '../lang/infer.ts'
import { GLOBALS } from '../lang/prelude.ts'
import {
  binderUnder,
  buildSemanticIndex,
  completionItems,
  definitionAt,
  hoverAt,
  inlayHints,
  isValidName,
  occurrencesAt,
  renameBinder,
} from '../lang/semantics.ts'
import type { Completion, HoverInfo, InlayHint } from '../lang/semantics.ts'

export interface Diagnostic {
  span: Span
  message: string
  severity: 'error' | 'warning'
}

interface EditorProps {
  value: string
  onChange: (next: string) => void
  errorSpan?: Span | null
  highlightSpan?: Span | null
  warningSpans?: Span[]
  /** the live, type-checked AST (null while the buffer doesn't parse) */
  ast?: Expr | null
  /** the live inference result (drives hovers, inlays, completion types) */
  typeResult?: InferResult | null
  /** error + warning ranges with messages, shown on hover */
  diagnostics?: Diagnostic[]
  /** render end-of-line `: type` ghosts for bindings */
  showInlayHints?: boolean
}

interface Marked {
  text: string
  cls: string
}

const MEASURE_LEN = 40

function buildSegments(
  src: string,
  errorSpan: Span | null | undefined,
  highlightSpan: Span | null | undefined,
  warningSpans: Span[],
  occurrenceSpans: Span[],
): Marked[] {
  const segs = highlight(src)
  const out: Marked[] = []
  let offset = 0
  const intersects = (s: Span | null | undefined, start: number, end: number): boolean =>
    !!s && s.start < end && s.end > start && s.end > s.start
  for (const seg of segs) {
    const start = offset
    const end = offset + seg.text.length
    offset = end
    let cls = `hl-${seg.cls}`
    if (intersects(errorSpan, start, end)) cls += ' hl-error'
    else if (intersects(highlightSpan, start, end)) cls += ' hl-active'
    else if (warningSpans.some((w) => intersects(w, start, end))) cls += ' hl-warn'
    if (occurrenceSpans.some((o) => intersects(o, start, end))) cls += ' hl-occur'
    out.push({ text: seg.text, cls })
  }
  return out
}

interface Metrics {
  padLeft: number
  padTop: number
  lineHeight: number
  charWidth: number
}

export default function Editor({
  value,
  onChange,
  errorSpan,
  highlightSpan,
  warningSpans = [],
  ast = null,
  typeResult = null,
  diagnostics = [],
  showInlayHints = false,
}: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const metricsRef = useRef<Metrics | null>(null)
  const hoverOffsetRef = useRef<number>(-1)
  const wantCompletionRef = useRef<boolean>(false)

  const [occurrences, setOccurrences] = useState<Span[]>([])
  const [hover, setHover] = useState<{ x: number; y: number; info: HoverInfo } | null>(null)
  const [diagHover, setDiagHover] = useState<{ x: number; y: number; text: string } | null>(null)
  const [completion, setCompletion] = useState<{
    from: number
    to: number
    items: Completion[]
    selected: number
    x: number
    y: number
  } | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [rename, setRename] = useState<{ offset: number; value: string; x: number; y: number } | null>(
    null,
  )
  const renameInputRef = useRef<HTMLInputElement>(null)

  const segments = useMemo(
    () => buildSegments(value, errorSpan, highlightSpan, warningSpans, occurrences),
    [value, errorSpan, highlightSpan, warningSpans, occurrences],
  )
  const lineCount = useMemo(() => value.split('\n').length, [value])

  // line-start offsets for fast offset ⟷ row/col conversion
  const lineStarts = useMemo(() => {
    const arr = [0]
    for (let i = 0; i < value.length; i++) if (value[i] === '\n') arr.push(i + 1)
    return arr
  }, [value])

  // the semantic view of the current buffer (re-resolved when the AST changes)
  const index = useMemo(
    () => buildSemanticIndex(ast, typeResult, value),
    [ast, typeResult, value],
  )

  const hints = useMemo<InlayHint[]>(
    () => (showInlayHints ? inlayHints(index) : []),
    [showInlayHints, index],
  )

  const offsetToRowCol = useCallback(
    (offset: number): { row: number; col: number } => {
      let row = 0
      // lineStarts is ascending; find the last start ≤ offset
      for (let i = lineStarts.length - 1; i >= 0; i--) {
        if (lineStarts[i] <= offset) {
          row = i
          break
        }
      }
      return { row, col: offset - lineStarts[row] }
    },
    [lineStarts],
  )

  const rowColToOffset = useCallback(
    (row: number, col: number): number => {
      const r = Math.max(0, Math.min(row, lineStarts.length - 1))
      const start = lineStarts[r]
      const lineEnd = r + 1 < lineStarts.length ? lineStarts[r + 1] - 1 : value.length
      return Math.min(start + Math.max(0, col), lineEnd)
    },
    [lineStarts, value.length],
  )

  const readMetrics = useCallback((): Metrics | null => {
    const ta = taRef.current
    const m = measureRef.current
    if (!ta || !m) return null
    const cs = getComputedStyle(ta)
    const padLeft = parseFloat(cs.paddingLeft) || 14
    const padTop = parseFloat(cs.paddingTop) || 12
    const fontSize = parseFloat(cs.fontSize) || 13.5
    let lineHeight = parseFloat(cs.lineHeight)
    if (!isFinite(lineHeight)) lineHeight = fontSize * 1.55
    const charWidth = m.getBoundingClientRect().width / MEASURE_LEN || fontSize * 0.6
    return { padLeft, padTop, lineHeight, charWidth }
  }, [])

  useLayoutEffect(() => {
    let raf = 0
    const measure = (): void => {
      const next = readMetrics()
      metricsRef.current = next
      setMetrics(next)
    }
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }
    schedule()
    // re-measure once the monospace webfont has actually loaded
    if (document.fonts?.ready) document.fonts.ready.then(schedule).catch(() => {})
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
    }
  }, [readMetrics])

  const getMetrics = useCallback((): Metrics | null => {
    if (!metricsRef.current) metricsRef.current = readMetrics()
    return metricsRef.current
  }, [readMetrics])

  // keep the inlay overlay glued to the scrolled text without a React re-render
  const syncOverlay = useCallback((): void => {
    const ta = taRef.current
    const ov = overlayRef.current
    if (ta && ov) ov.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
  }, [])
  useLayoutEffect(syncOverlay, [syncOverlay, hints, value])

  const onScroll = (e: UIEvent<HTMLTextAreaElement>): void => {
    const t = e.currentTarget
    if (preRef.current) {
      preRef.current.scrollTop = t.scrollTop
      preRef.current.scrollLeft = t.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop
    syncOverlay()
    setHover(null)
    setDiagHover(null)
    setCompletion(null)
  }

  // ----- caret-driven occurrence highlighting --------------------------------
  const refreshOccurrences = useCallback((): void => {
    const ta = taRef.current
    if (!ta || !index.ast) {
      setOccurrences([])
      return
    }
    const occ = occurrencesAt(index, ta.selectionStart)
    setOccurrences(occ && occ.length > 1 ? occ : [])
  }, [index])

  // ----- hover ---------------------------------------------------------------
  const onMouseMove = (e: MouseEvent<HTMLTextAreaElement>): void => {
    if (completion) return
    const ta = taRef.current
    const metrics = getMetrics()
    if (!ta || !metrics) return
    const rect = ta.getBoundingClientRect()
    const localX = e.clientX - rect.left - metrics.padLeft + ta.scrollLeft
    const localY = e.clientY - rect.top - metrics.padTop + ta.scrollTop
    const row = Math.floor(localY / metrics.lineHeight)
    const col = Math.round(localX / metrics.charWidth)
    if (row < 0 || col < 0) {
      hoverOffsetRef.current = -1
      setHover(null)
      setDiagHover(null)
      return
    }
    const offset = rowColToOffset(row, col)
    if (offset === hoverOffsetRef.current) return
    hoverOffsetRef.current = offset

    const diag = diagnostics.find((d) => offset >= d.span.start && offset <= d.span.end)
    if (diag) {
      setDiagHover({ x: e.clientX, y: e.clientY, text: diag.message })
      setHover(null)
      return
    }
    setDiagHover(null)

    const info = hoverAt(index, offset)
    if (info && (info.type || info.scheme)) {
      setHover({ x: e.clientX, y: e.clientY, info })
    } else {
      setHover(null)
    }
  }

  const clearHover = (): void => {
    hoverOffsetRef.current = -1
    setHover(null)
    setDiagHover(null)
  }

  // ----- go-to-definition (⌘/Ctrl-click) -------------------------------------
  const onMouseDown = (e: MouseEvent<HTMLTextAreaElement>): void => {
    if (!(e.metaKey || e.ctrlKey)) return
    const ta = taRef.current
    const metrics = getMetrics()
    if (!ta || !metrics || !index.ast) return
    const rect = ta.getBoundingClientRect()
    const localX = e.clientX - rect.left - metrics.padLeft + ta.scrollLeft
    const localY = e.clientY - rect.top - metrics.padTop + ta.scrollTop
    const offset = rowColToOffset(
      Math.floor(localY / metrics.lineHeight),
      Math.round(localX / metrics.charWidth),
    )
    const def = definitionAt(index, offset)
    if (def) {
      e.preventDefault()
      ta.focus()
      ta.setSelectionRange(def.start, def.end)
      // nudge the caret into view
      const { row } = offsetToRowCol(def.start)
      ta.scrollTop = Math.max(0, row * metrics.lineHeight - ta.clientHeight / 2)
      syncOverlay()
      requestAnimationFrame(refreshOccurrences)
    }
  }

  // ----- completion ----------------------------------------------------------
  const closeCompletion = useCallback(() => setCompletion(null), [])

  const openCompletionAt = useCallback(
    (caret: number, force: boolean): void => {
      const ta = taRef.current
      const metrics = getMetrics()
      if (!ta || !metrics) return
      const res = completionItems(index, value, caret, GLOBALS)
      if (res.items.length === 0 || (!force && res.prefix.length === 0)) {
        setCompletion(null)
        return
      }
      const { row, col } = offsetToRowCol(res.to)
      const rect = ta.getBoundingClientRect()
      const x = rect.left + metrics.padLeft + col * metrics.charWidth - ta.scrollLeft
      const y = rect.top + metrics.padTop + (row + 1) * metrics.lineHeight - ta.scrollTop
      setHover(null)
      setDiagHover(null)
      setCompletion({ from: res.from, to: res.to, items: res.items, selected: 0, x, y })
    },
    [index, value, getMetrics, offsetToRowCol],
  )

  // recompute completion after the buffer changes (or a manual trigger)
  useEffect(() => {
    if (!wantCompletionRef.current) return
    wantCompletionRef.current = false
    const ta = taRef.current
    if (!ta || document.activeElement !== ta) return
    openCompletionAt(ta.selectionStart, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const acceptCompletion = useCallback(
    (item: Completion): void => {
      const next = value.slice(0, completion?.from ?? 0) + item.label + value.slice(completion?.to ?? 0)
      const caret = (completion?.from ?? 0) + item.label.length
      setCompletion(null)
      onChange(next)
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (ta) ta.setSelectionRange(caret, caret)
      })
    },
    [value, completion, onChange],
  )

  const onChangeInput = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    wantCompletionRef.current = true
    onChange(e.target.value)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // completion popup navigation takes priority
    if (completion) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCompletion((c) =>
          c ? { ...c, selected: (c.selected + 1) % c.items.length } : c,
        )
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCompletion((c) =>
          c ? { ...c, selected: (c.selected - 1 + c.items.length) % c.items.length } : c,
        )
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        acceptCompletion(completion.items[completion.selected])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCompletion()
        return
      }
    }
    // ⌘/Ctrl-Space → force completion
    if ((e.metaKey || e.ctrlKey) && e.key === ' ') {
      e.preventDefault()
      const ta = e.currentTarget
      openCompletionAt(ta.selectionStart, true)
      return
    }
    // F2 → rename the binding under the caret
    if (e.key === 'F2') {
      e.preventDefault()
      const ta = e.currentTarget
      const b = binderUnder(index, ta.selectionStart)
      const m = getMetrics()
      if (b && m) {
        const { row, col } = offsetToRowCol(b.defSpan.start)
        const rect = ta.getBoundingClientRect()
        setRename({
          offset: b.defSpan.start,
          value: b.name,
          x: rect.left + m.padLeft + col * m.charWidth - ta.scrollLeft,
          y: rect.top + m.padTop + row * m.lineHeight - ta.scrollTop,
        })
        setCompletion(null)
      }
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = value.slice(0, start) + '  ' + value.slice(end)
      onChange(next)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
  }

  const onCaretChange = (): void => {
    if (!completion) refreshOccurrences()
  }

  const commitRename = useCallback((): void => {
    if (!rename) return
    if (!isValidName(rename.value)) {
      setRename(null)
      return
    }
    const res = renameBinder(index, rename.offset, rename.value)
    setRename(null)
    if (res) {
      onChange(res.source)
      requestAnimationFrame(() => {
        const ta = taRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(res.caret, res.caret)
        }
      })
    }
  }, [rename, index, onChange])

  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setRename(null)
      requestAnimationFrame(() => taRef.current?.focus())
    }
  }

  useEffect(() => {
    refreshOccurrences()
  }, [refreshOccurrences])

  useEffect(() => {
    if (rename) {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    }
  }, [rename])

  return (
    <div className="editor">
      <div className="editor-gutter" ref={gutterRef}>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="editor-gutter-line">
            {i + 1}
          </div>
        ))}
      </div>
      <div className="editor-code">
        <pre className="editor-hl" ref={preRef} aria-hidden="true">
          {segments.map((s, i) => (
            <span key={i} className={s.cls}>
              {s.text}
            </span>
          ))}
          {'\n'}
        </pre>

        {/* inlay-hint layer — glued to the scrolled text via transform */}
        <div className="editor-inlays" ref={overlayRef} aria-hidden="true">
          {hints.map((h, i) => {
            if (!metrics) return null
            const { row } = offsetToRowCol(h.anchor)
            // end-of-line: place the ghost just past the binding's own line text
            const lineEnd =
              row + 1 < lineStarts.length ? lineStarts[row + 1] - 1 : value.length
            const lineLen = lineEnd - lineStarts[row]
            const x = metrics.padLeft + (lineLen + 2) * metrics.charWidth
            const y = metrics.padTop + row * metrics.lineHeight
            return (
              <span
                key={i}
                className="editor-inlay"
                style={{ left: x, top: y, lineHeight: `${metrics.lineHeight}px` }}
              >
                {h.text}
              </span>
            )
          })}
        </div>

        {/* hidden ruler for monospace char-width measurement */}
        <span className="editor-measure" ref={measureRef} aria-hidden="true">
          {'x'.repeat(MEASURE_LEN)}
        </span>

        <textarea
          ref={taRef}
          className="editor-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={onChangeInput}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onKeyUp={onCaretChange}
          onClick={onCaretChange}
          onSelect={onCaretChange}
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseLeave={clearHover}
          onBlur={closeCompletion}
        />
      </div>

      {hover && (
        <div
          className="editor-hovercard"
          style={{ left: hover.x + 12, top: hover.y + 18 }}
          role="tooltip"
        >
          <div className="hc-title">{hover.info.title}</div>
          {hover.info.scheme && <div className="hc-type">{hover.info.scheme}</div>}
          {hover.info.type && !hover.info.scheme && <div className="hc-type">{hover.info.type}</div>}
          {hover.info.type && hover.info.scheme && hover.info.type !== hover.info.scheme && (
            <div className="hc-sub">at use: {hover.info.type}</div>
          )}
          {hover.info.origin && <div className="hc-origin">{hover.info.origin}</div>}
        </div>
      )}

      {diagHover && (
        <div className="editor-hovercard diag" style={{ left: diagHover.x + 12, top: diagHover.y + 18 }}>
          {diagHover.text}
        </div>
      )}

      {rename && (
        <div className="editor-rename" style={{ left: rename.x, top: rename.y }}>
          <input
            ref={renameInputRef}
            className="rename-input"
            value={rename.value}
            spellCheck={false}
            onChange={(e) => setRename((r) => (r ? { ...r, value: e.target.value } : r))}
            onKeyDown={onRenameKey}
            onBlur={() => setRename(null)}
          />
          <span className={`rename-hint ${isValidName(rename.value) ? '' : 'bad'}`}>
            {isValidName(rename.value) ? '↵ rename · esc' : 'invalid name'}
          </span>
        </div>
      )}

      {completion && completion.items.length > 0 && (
        <ul className="editor-completions" style={{ left: completion.x, top: completion.y }}>
          {completion.items.slice(0, 12).map((it, i) => (
            <li
              key={it.label}
              className={`cmp-item ${i === completion.selected ? 'sel' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                acceptCompletion(it)
              }}
            >
              <span className={`cmp-kind cmp-${it.kind}`}>{kindGlyph(it.kind)}</span>
              <span className="cmp-label">{it.label}</span>
              {it.detail && <span className="cmp-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function kindGlyph(kind: Completion['kind']): string {
  switch (kind) {
    case 'local':
      return 'x'
    case 'param':
      return 'p'
    case 'global':
      return 'ƒ'
    case 'prelude':
      return 'λ'
    case 'ctor':
      return '◇'
    case 'method':
      return '∷'
    case 'keyword':
      return 'k'
  }
}
