// The Compiler tab's C source editor — the same transparent-textarea-over-highlighted-pre
// technique as the assembly Editor, but driven by the C highlighter and with a gutter that
// marks lines carrying a compiler diagnostic.

import { useMemo, useRef } from 'react';
import type { KeyboardEvent, UIEvent } from 'react';
import { highlightC } from '../cc/highlightC';

interface CEditorProps {
  source: string;
  onChange: (s: string) => void;
  errorLines: Map<number, string>;
}

export default function CEditor({ source, onChange, errorLines }: CEditorProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = useMemo(() => source.split('\n').length, [source]);
  const highlighted = useMemo(() => highlightC(source), [source]);

  const syncScroll = (e: UIEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (preRef.current) {
      preRef.current.scrollTop = el.scrollTop;
      preRef.current.scrollLeft = el.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = el.scrollTop;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = source.slice(0, start) + '    ' + source.slice(end);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 4;
      });
    }
  };

  return (
    <div className="editor">
      <div className="gutter" ref={gutterRef} aria-hidden>
        {Array.from({ length: lineCount }, (_, i) => {
          const ln = i + 1;
          const err = errorLines.get(ln);
          return (
            <div key={ln} className={`gutter-line${err ? ' err' : ''}`} title={err ?? ''}>
              <span className="lnum">{ln}</span>
            </div>
          );
        })}
      </div>

      <div className="code-wrap">
        <pre className="code-hl" ref={preRef} aria-hidden>
          {highlighted.map((tokens, i) => (
            <div key={i} className={`hl-line${errorLines.has(i + 1) ? ' err-line' : ''}`}>
              {tokens.length === 0
                ? '​'
                : tokens.map((t, j) => (
                    <span key={j} className={`tok-${t.kind}`}>
                      {t.value}
                    </span>
                  ))}
            </div>
          ))}
        </pre>
        <textarea
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
