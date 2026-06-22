// Register file inspector: all 32 GPRs and 32 FP registers, plus pc, cycles, fcsr and the
// hardware counters. Values that changed since the last step are highlighted, and the integer
// view has a selectable display radix.

import { useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { ABI_NAMES, REG_ROLES, FREG_ABI_NAMES, FREG_ROLES } from '../vm/registers';
import { privName, privLong } from '../vm/mmu';
import { formatWord, hexWord } from '../vm/format';
import type { Radix } from '../vm/format';
import { f32FromBits, f64FromBits } from '../vm/fp';

interface Props {
  cpu: Cpu;
  prevRegs: Int32Array;
}

const RADII: Radix[] = ['hex', 'dec', 'udec', 'bin'];

/** Pretty-print a float value for the inspector. */
function pretty(x: number, sig: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return `${x}.0`;
  return String(Number(x.toPrecision(sig)));
}

/**
 * Render a float register. A NaN-boxed value (high half all ones) is a single; anything else
 * is shown as the double it holds, so RV32D registers read correctly.
 */
function fmtFloat(lo: number, hi: number): string {
  if (hi === 0xffff_ffff) return pretty(f32FromBits(lo), 7);
  return pretty(f64FromBits(lo, hi), 16);
}

export default function Registers({ cpu, prevRegs }: Props) {
  const [radix, setRadix] = useState<Radix>('hex');
  const [showFloat, setShowFloat] = useState(true);

  const frm = (cpu.fcsr >>> 5) & 7;
  const fflags = cpu.fcsr & 0x1f;

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
          <button className={showFloat ? 'on' : ''} onClick={() => setShowFloat((v) => !v)}>
            ƒ
          </button>
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

      {showFloat && (
        <>
          <div className="reg-subhead">
            <span>float registers (RV32F/D · FLEN=64)</span>
            <span className="reg-fcsr">
              fcsr=0x{cpu.fcsr.toString(16).padStart(2, '0')} · frm={frm} · fflags=
              {fflags.toString(2).padStart(5, '0')}
            </span>
          </div>
          <div className="reg-grid freg-grid">
            {Array.from({ length: 32 }, (_, i) => (
              <div key={i} className="reg-cell" title={FREG_ROLES[i]}>
                <span className="reg-name">
                  {FREG_ABI_NAMES[i]}
                  <span className="reg-x">f{i}</span>
                </span>
                <span className="reg-val">{fmtFloat(cpu.fregs[i], cpu.fregsHi[i])}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="reg-special">
        <div className="reg-cell pc">
          <span className="reg-name">pc</span>
          <span className="reg-val">{hexWord(cpu.pc)}</span>
        </div>
        <div className="reg-cell">
          <span className="reg-name">cycle</span>
          <span className="reg-val">{cpu.cycles.toLocaleString()}</span>
        </div>
        <div className="reg-cell" title={`current privilege: ${privLong(cpu.priv)} mode`}>
          <span className="reg-name">priv</span>
          <span className={`reg-val priv-${privName(cpu.priv)}`}>{privName(cpu.priv)} · {privLong(cpu.priv)}</span>
        </div>
        <div className="reg-cell">
          <span className="reg-name">status</span>
          <span className={`reg-val status-${cpu.status}`}>{cpu.status}</span>
        </div>
      </div>

      <div className="reg-subhead">
        <span>machine trap CSRs (Zicsr)</span>
        <span className="reg-fcsr">
          MIE={(cpu.mstatus >>> 3) & 1} · MPIE={(cpu.mstatus >>> 7) & 1} · MTIP=
          {(cpu.mip >>> 7) & 1}
        </span>
      </div>
      <div className="reg-grid mcsr-grid">
        {(
          [
            ['mstatus', cpu.mstatus],
            ['mtvec', cpu.mtvec],
            ['mepc', cpu.mepc],
            ['mcause', cpu.mcause],
            ['mtval', cpu.mtval],
            ['mie', cpu.mie],
            ['mip', cpu.mip],
            ['mscratch', cpu.mscratch],
          ] as const
        ).map(([name, val]) => (
          <div key={name} className="reg-cell" title={`CSR ${name}`}>
            <span className="reg-name">{name}</span>
            <span className="reg-val">{hexWord(val)}</span>
          </div>
        ))}
        <div className="reg-cell" title="CLINT free-running timer (= retired cycles)">
          <span className="reg-name">mtime</span>
          <span className="reg-val">{cpu.cycles.toLocaleString()}</span>
        </div>
        <div className="reg-cell" title="CLINT timer compare">
          <span className="reg-name">mtimecmp</span>
          <span className="reg-val">
            {Number.isFinite(cpu.mtimecmp) ? cpu.mtimecmp.toLocaleString() : '∞'}
          </span>
        </div>
      </div>
      {cpu.error && <div className="reg-error">⚠ {cpu.error}</div>}
    </div>
  );
}
