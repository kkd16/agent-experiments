// SQL editor: a transparent <textarea> layered over a highlighted <pre>.
// The two stay pixel-aligned by sharing identical font metrics and scroll.

import { useEffect, useRef } from 'react'
import { highlight } from './highlight'

interface Props {
  value: string
  onChange: (v: string) => void
  onRun: () => void
}

export function Editor({ value, onChange, onRun }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // Keep the highlight layer scrolled in lock-step with the textarea.
  const syncScroll = () => {
    const ta = taRef.current
    const pre = preRef.current
    if (ta && pre) {
      pre.scrollTop = ta.scrollTop
      pre.scrollLeft = ta.scrollLeft
    }
  }
  useEffect(syncScroll, [value])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      onRun()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const { selectionStart, selectionEnd } = ta
      const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
      onChange(next)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = selectionStart + 2
      })
    }
  }

  const segments = highlight(value)

  return (
    <div className="editor">
      <pre className="editor-highlight" ref={preRef} aria-hidden="true">
        {segments.map((s, i) => (
          <span key={i} className={s.cls}>
            {s.text}
          </span>
        ))}
        {/* trailing newline keeps the last line visible while scrolling */}
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
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={syncScroll}
        placeholder="-- Write SQL here.  ⌘/Ctrl + Enter to run."
      />
    </div>
  )
}
