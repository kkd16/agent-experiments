// A self-contained code editor: a transparent <textarea> sits on top of a syntax-coloured
// <pre>, the two kept in pixel-perfect alignment and scroll-synced. A gutter on the left
// shows line numbers, breakpoint toggles, the current execution line, and error markers.

import { useEffect, useMemo, useRef } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { tokenizeLine } from './highlight';

interface EditorProps {
  source: string;
  onChange: (s: string) => void;
  breakpointLines: ReadonlySet<number>;
  onToggleBreakpoint: (line: number) => void;
  currentLine: number | null;
  errorLines: Map<number, string>;
}

export default function Editor({
  source,
  onChange,
  breakpointLines,
  onToggleBreakpoint,
  currentLine,
  errorLines,
}: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => source.split('\n'), [source]);
  const highlighted = useMemo(() => lines.map((l) => tokenizeLine(l)), [lines]);

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  // Keep the highlight layer aligned if the current line scrolls programmatically.
  useEffect(() => {
    if (currentLine == null || !taRef.current) return;
    const lineHeight = 21;
    const target = (currentLine - 1) * lineHeight;
    const ta = taRef.current;
    if (target < ta.scrollTop || target > ta.scrollTop + ta.clientHeight - lineHeight) {
      ta.scrollTop = Math.max(0, target - ta.clientHeight / 2);
      if (preRef.current) preRef.current.scrollTop = ta.scrollTop;
      if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
    }
  }, [currentLine]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = source.slice(0, start) + '  ' + source.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  };

  return (
    <div className="editor">
      <div className="gutter" ref={gutterRef} aria-hidden>
        {lines.map((_, i) => {
          const ln = i + 1;
          const hasBp = breakpointLines.has(ln);
          const isCur = currentLine === ln;
          const err = errorLines.get(ln);
          return (
            <div
              key={ln}
              className={`gutter-line${isCur ? ' cur' : ''}${err ? ' err' : ''}`}
              title={err ?? (hasBp ? 'breakpoint' : 'click to toggle breakpoint')}
              onClick={() => onToggleBreakpoint(ln)}
            >
              <span className={`bp${hasBp ? ' on' : ''}`} />
              <span className="lnum">{ln}</span>
            </div>
          );
        })}
      </div>

      <div className="code-wrap">
        <pre className="code-hl" ref={preRef} aria-hidden>
          {highlighted.map((tokens, i) => (
            <div key={i} className={`hl-line${currentLine === i + 1 ? ' cur' : ''}`}>
              {tokens.length === 0 ? (
                '​'
              ) : (
                tokens.map((t, j) => (
                  <span key={j} className={`tok-${t.kind}`}>
                    {t.value}
                  </span>
                ))
              )}
            </div>
          ))}
        </pre>
        <textarea
          ref={taRef}
          className="code-input"
          value={source}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
