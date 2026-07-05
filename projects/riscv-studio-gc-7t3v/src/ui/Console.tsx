// The syscall console: everything the program printed via print_int / print_string / etc.,
// plus a "UART stdin" box that feeds the memory-mapped UART's receive stream (the bytes an
// interrupt- or poll-driven program reads from the serial port).

import { useEffect, useRef, useState } from 'react';
import type { Cpu } from '../vm/cpu';

interface Props {
  cpu: Cpu;
  uartInput: string;
  onSetUartInput: (s: string) => void;
}

export default function Console({ cpu, uartInput, onSetUartInput }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState(uartInput);
  // Keep the editable draft in sync when the stream changes elsewhere (e.g. loading an example),
  // using React's "adjust state during render" pattern rather than an effect.
  const [lastInput, setLastInput] = useState(uartInput);
  if (uartInput !== lastInput) {
    setLastInput(uartInput);
    setDraft(uartInput);
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [cpu.output]);

  const commit = () => {
    if (draft !== uartInput) onSetUartInput(draft);
  };

  return (
    <div className="panel console">
      <div className="panel-head">
        <h2>Console</h2>
        <span className="muted">
          {cpu.status === 'halted' ? `exited (code ${cpu.exitCode})` : cpu.status}
        </span>
      </div>
      <pre className="console-out">
        {cpu.output.length === 0 ? <span className="muted">— no output yet —</span> : cpu.output}
        <div ref={endRef} />
      </pre>
      <div className="uart-stdin">
        <div className="uart-stdin-head">
          <span>UART stdin</span>
          <span className="muted">
            fed to the memory-mapped UART at 0x1000_0000 · {cpu.dev.rxPos}/{cpu.dev.rxTotal()} read
          </span>
        </div>
        <textarea
          className="uart-input"
          rows={2}
          value={draft}
          spellCheck={false}
          placeholder="bytes the program will receive (the UART echo example expects a trailing newline)"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
        <div className="uart-hint muted">edits reload the program · ⌘/Ctrl+Enter to apply</div>
      </div>
    </div>
  );
}
