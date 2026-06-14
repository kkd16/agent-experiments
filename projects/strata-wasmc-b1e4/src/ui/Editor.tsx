import { useEffect, useMemo, useRef } from 'react';
import { highlight } from './highlight';

interface EditorProps {
  value: string;
  onChange: (v: string) => void;
  errorLine?: number;
  activeLine?: number; // current line while single-stepping in the debugger
}

// A lightweight code editor: a transparent <textarea> over a highlighted <pre>,
// with a synced line-number gutter. No external dependencies.
export default function Editor({ value, onChange, errorLine, activeLine }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const toks = useMemo(() => highlight(value), [value]);
  const lineCount = useMemo(() => value.split('\n').length, [value]);

  const sync = () => {
    const ta = taRef.current;
    if (!ta) return;
    if (preRef.current) {
      preRef.current.scrollTop = ta.scrollTop;
      preRef.current.scrollLeft = ta.scrollLeft;
    }
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };
  useEffect(sync, [value]);

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const next = value.slice(0, s) + '  ' + value.slice(en);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = s + 2;
      });
    }
  };

  return (
    <div className="editor">
      <div className="gutter" ref={gutterRef}>
        {Array.from({ length: lineCount }, (_, i) => (
          <div
            key={i}
            className={'gln' + (errorLine === i + 1 ? ' gln-err' : '') + (activeLine === i + 1 ? ' gln-active' : '')}
          >
            {activeLine === i + 1 ? '▶' : i + 1}
          </div>
        ))}
      </div>
      <div className="code-area">
        <pre className="hl" ref={preRef} aria-hidden="true">
          {toks.map((t, i) => (
            <span key={i} className={'t-' + t.cls}>
              {t.text}
            </span>
          ))}
          {'\n'}
        </pre>
        <textarea
          ref={taRef}
          className="code-input"
          value={value}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          wrap="off"
          onChange={(e) => onChange(e.target.value)}
          onScroll={sync}
          onKeyDown={handleKey}
        />
      </div>
    </div>
  );
}
