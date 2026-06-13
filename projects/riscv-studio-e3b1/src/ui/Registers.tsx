// Register file inspector: all 32 GPRs plus pc, with the values that changed since the last
// step highlighted, and a selectable display radix.

import { useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { ABI_NAMES, REG_ROLES } from '../vm/registers';
import { formatWord, hexWord } from '../vm/format';
import type { Radix } from '../vm/format';

interface Props {
  cpu: Cpu;
  prevRegs: Int32Array;
}

const RADII: Radix[] = ['hex', 'dec', 'udec', 'bin'];

export default function Registers({ cpu, prevRegs }: Props) {
  const [radix, setRadix] = useState<Radix>('hex');

  return (
    <div className="panel regs">
      <div className="panel-head">
        <h2>Registers</h2>
        <div className="radix-pick">
          {RADII.map((r) => (
            <button key={r} className={radix === r ? 'on' : ''} onClick={() => setRadix(r)}>
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="reg-grid">
        {Array.from({ length: 32 }, (_, i) => {
          const v = cpu.regs[i];
          const changed = prevRegs[i] !== v && v !== 0;
          return (
            <div key={i} className={`reg-cell${changed ? ' changed' : ''}`} title={REG_ROLES[i]}>
              <span className="reg-name">
                {ABI_NAMES[i]}
                <span className="reg-x">x{i}</span>
              </span>
              <span className="reg-val">{formatWord(v, radix)}</span>
            </div>
          );
        })}
      </div>
      <div className="reg-special">
        <div className="reg-cell pc">
          <span className="reg-name">pc</span>
          <span className="reg-val">{hexWord(cpu.pc)}</span>
        </div>
        <div className="reg-cell">
          <span className="reg-name">cycles</span>
          <span className="reg-val">{cpu.cycles.toLocaleString()}</span>
        </div>
        <div className="reg-cell">
          <span className="reg-name">status</span>
          <span className={`reg-val status-${cpu.status}`}>{cpu.status}</span>
        </div>
      </div>
      {cpu.error && <div className="reg-error">⚠ {cpu.error}</div>}
    </div>
  );
}
