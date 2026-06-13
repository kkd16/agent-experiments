import { useMemo, useRef } from 'react'
import type { ChangeEvent, KeyboardEvent, UIEvent } from 'react'
import { highlight } from '../highlight.ts'
import type { Span } from '../lang/lexer.ts'

interface EditorProps {
  value: string
  onChange: (next: string) => void
  errorSpan?: Span | null
  highlightSpan?: Span | null
}

interface Marked {
  text: string
  cls: string
}

function buildSegments(src: string, errorSpan?: Span | null, highlightSpan?: Span | null): Marked[] {
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
    out.push({ text: seg.text, cls })
  }
  return out
}

export default function Editor({ value, onChange, errorSpan, highlightSpan }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

  const segments = useMemo(
    () => buildSegments(value, errorSpan, highlightSpan),
    [value, errorSpan, highlightSpan],
  )
  const lineCount = useMemo(() => value.split('\n').length, [value])

  const onScroll = (e: UIEvent<HTMLTextAreaElement>): void => {
    const t = e.currentTarget
    if (preRef.current) {
      preRef.current.scrollTop = t.scrollTop
      preRef.current.scrollLeft = t.scrollLeft
    }
    if (gutterRef.current) gutterRef.current.scrollTop = t.scrollTop
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        <textarea
          ref={taRef}
          className="editor-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
