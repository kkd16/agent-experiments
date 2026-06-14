// Disassembly view: the assembled .text laid out as address / raw word / decoded mnemonic,
// alongside the original source line. The row at the current pc is highlighted, and
// breakpoint rows are marked.

import { useEffect, useRef } from 'react';
import type { Cpu } from '../vm/cpu';
import type { AssembleResult } from '../vm/assembler';
import { disassembleUnit } from '../vm/disassembler';
import { toHex } from '../vm/format';

interface Props {
  cpu: Cpu;
  assembly: AssembleResult | null;
}

export default function Disasm({ cpu, assembly }: Props) {
  const curRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    curRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cpu.pc]);

  if (!assembly || assembly.instrs.length === 0) {
    return (
      <div className="panel disasm">
        <div className="panel-head">
          <h2>Disassembly</h2>
        </div>
        <p className="empty">Assemble a program to see its machine code.</p>
      </div>
    );
  }

  const pc = cpu.pc >>> 0;

  return (
    <div className="panel disasm">
      <div className="panel-head">
        <h2>Disassembly</h2>
        <span className="muted">{assembly.instrs.length} instructions</span>
      </div>
      <div className="disasm-list">
        <div className="disasm-row disasm-header">
          <span className="d-addr">addr</span>
          <span className="d-word">word</span>
          <span className="d-asm">disassembly</span>
          <span className="d-src">source</span>
        </div>
        {assembly.instrs.map((ins) => {
          const cur = ins.addr === pc;
          return (
            <div
              key={ins.addr}
              ref={cur ? curRef : undefined}
              className={`disasm-row${cur ? ' cur' : ''}`}
            >
              <span className="d-addr">{toHex(ins.addr, 8)}</span>
              <span className="d-word">{ins.len === 2 ? toHex(ins.word, 4) + '    ' : toHex(ins.word, 8)}</span>
              <span className="d-asm">{disassembleUnit(ins.word, ins.addr, ins.len)}</span>
              <span className="d-src">{ins.source}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
