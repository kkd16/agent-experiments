// The syscall console: everything the program printed via print_int / print_string / etc.

import { useEffect, useRef } from 'react';
import type { Cpu } from '../vm/cpu';

interface Props {
  cpu: Cpu;
}

export default function Console({ cpu }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [cpu.output]);

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
    </div>
  );
}
