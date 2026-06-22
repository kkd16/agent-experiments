import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A dependency-free code editor: a monospace textarea with a synced line-number
 * gutter and editor-grade key handling — Tab / Shift-Tab indent or outdent
 * (selection-aware), Enter copies the current indentation (and adds a level
 * after an opening bracket), and a closing brace/bracket de-dents as you type.
 * No syntax highlighting overlay — keeping the caret perfectly aligned is more
 * valuable than colour, and it stays rock-solid across browsers.
 */

const INDENT = "  ";

export default function CodeEditor({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = Math.max(1, value.split("\n").length);

  // Keep the gutter scroll in lock-step with the textarea.
  const syncScroll = useCallback(() => {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  }, []);

  useLayoutEffect(syncScroll, [value, syncScroll]);

  const apply = (next: string, selStart: number, selEnd: number) => {
    onChange(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.selectionStart = selStart;
        ta.selectionEnd = selEnd;
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const { selectionStart: s, selectionEnd: en, value: v } = ta;

    if (e.key === "Tab") {
      e.preventDefault();
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      if (e.shiftKey) {
        // Outdent every line in the selection.
        const block = v.slice(lineStart, en);
        const dedented = block.replace(/^ {1,2}/gm, "");
        const removedFirst = block.length - block.replace(/^ {1,2}/, "").length;
        const removedTotal = block.length - dedented.length;
        apply(
          v.slice(0, lineStart) + dedented + v.slice(en),
          Math.max(lineStart, s - removedFirst),
          en - removedTotal,
        );
      } else if (s !== en) {
        // Indent every line in the selection.
        const block = v.slice(lineStart, en);
        const indented = block.replace(/^/gm, INDENT);
        const added = indented.length - block.length;
        apply(v.slice(0, lineStart) + indented + v.slice(en), s + INDENT.length, en + added);
      } else {
        // Insert a soft tab at the caret.
        apply(v.slice(0, s) + INDENT + v.slice(s), s + INDENT.length, s + INDENT.length);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const line = v.slice(lineStart, s);
      const indentMatch = line.match(/^[ \t]*/);
      let indent = indentMatch ? indentMatch[0] : "";
      const prevChar = v[s - 1];
      const nextChar = v[s];
      if (prevChar === "{" || prevChar === "(" || prevChar === "[") {
        const inner = indent + INDENT;
        if ((prevChar === "{" && nextChar === "}") || (prevChar === "(" && nextChar === ")") || (prevChar === "[" && nextChar === "]")) {
          // Opening immediately followed by its close: expand into a block.
          const insert = "\n" + inner + "\n" + indent;
          apply(v.slice(0, s) + insert + v.slice(s), s + 1 + inner.length, s + 1 + inner.length);
          return;
        }
        indent = inner;
      }
      const insert = "\n" + indent;
      apply(v.slice(0, s) + insert + v.slice(en), s + insert.length, s + insert.length);
      return;
    }

    if ((e.key === "}" || e.key === ")" || e.key === "]") && s === en) {
      // De-dent a lone closing bracket sitting on its own indented line.
      const lineStart = v.lastIndexOf("\n", s - 1) + 1;
      const line = v.slice(lineStart, s);
      if (/^[ \t]+$/.test(line) && line.length >= INDENT.length) {
        e.preventDefault();
        const trimmed = line.slice(0, line.length - INDENT.length);
        const next = v.slice(0, lineStart) + trimmed + e.key + v.slice(s);
        const caret = lineStart + trimmed.length + 1;
        apply(next, caret, caret);
      }
    }
  };

  return (
    <div className="code-editor">
      <div className="ce-gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i} className="ce-lineno">
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        ref={taRef}
        className="ce-textarea"
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label={ariaLabel ?? "Code editor"}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
