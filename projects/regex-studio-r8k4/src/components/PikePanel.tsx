import { useMemo } from 'react';
import type { RegexNode } from '../engine/ast';
import { compileProgram, disassemble, PikeUnsupported, type DisasmLine } from '../engine/pike';

interface Props {
  ast: RegexNode | null;
  groupCount: number;
  notice: string | null;
}

const OP_CLASS: Record<DisasmLine['op'], string> = {
  char: 'op-char',
  match: 'op-match',
  jmp: 'op-jmp',
  split: 'op-split',
  save: 'op-save',
  assert: 'op-assert',
};

export function PikePanel({ ast, groupCount, notice }: Props) {
  const result = useMemo(() => {
    if (!ast) return null;
    try {
      const prog = compileProgram(ast, groupCount);
      return { lines: disassemble(prog), nslots: prog.nslots, error: null as string | null };
    } catch (e) {
      if (e instanceof PikeUnsupported) return { lines: [] as DisasmLine[], nslots: 0, error: e.message };
      throw e;
    }
  }, [ast, groupCount]);

  if (!ast) return <div className="placeholder">{notice ?? 'Fix the pattern to compile the bytecode.'}</div>;
  if (!result) return <div className="placeholder">Compiling…</div>;

  if (result.error) {
    return (
      <div className="pike-panel">
        <div className="pike-unsupported">
          <strong>The Pike VM can’t run this pattern.</strong>
          <p>{result.error}</p>
          <p className="muted-note">
            This is the whole point of the three-engine design: backreferences and lookaround can’t be compiled to a
            finite thread set, so they need the backtracking VM — and forfeit its linear-time guarantee. Everything
            else compiles to the bytecode below.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pike-panel">
      <div className="pane-head">
        <div>
          <h2>Pike VM — compiled bytecode</h2>
          <p>
            {result.lines.length} instructions · {result.nslots} capture slots. The thread-list simulator runs every
            live thread one step per input character, deduping by program counter — so the whole NFA advances in
            lock-step and matching stays linear, captures and all.
          </p>
        </div>
      </div>

      <div className="disasm">
        {result.lines.map((line) => (
          <div className="disasm-row" key={line.pc}>
            <span className="disasm-pc">{String(line.pc).padStart(3, '0')}</span>
            <span className={`disasm-op ${OP_CLASS[line.op]}`}>{line.op}</span>
            <span className="disasm-arg">{line.text}</span>
            <span className="disasm-note">{line.note}</span>
          </div>
        ))}
      </div>

      <div className="disasm-legend">
        <Legend cls="op-char" name="char" desc="consume one code point" />
        <Legend cls="op-split" name="split" desc="fork two threads (priority-ordered)" />
        <Legend cls="op-jmp" name="jmp" desc="jump" />
        <Legend cls="op-save" name="save" desc="record a capture boundary" />
        <Legend cls="op-assert" name="assert" desc="zero-width check (^ $ \\b)" />
        <Legend cls="op-match" name="match" desc="accept" />
      </div>
    </div>
  );
}

function Legend({ cls, name, desc }: { cls: string; name: string; desc: string }) {
  return (
    <span className="legend-item">
      <span className={`disasm-op ${cls}`}>{name}</span>
      <span className="legend-desc">{desc}</span>
    </span>
  );
}
