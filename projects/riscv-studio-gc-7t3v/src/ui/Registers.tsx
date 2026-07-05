// Register file inspector: all 32 GPRs and 32 FP registers, plus pc, cycles, fcsr and the
// hardware counters. Values that changed since the last step are highlighted, and the integer
// view has a selectable display radix.

import { useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { ABI_NAMES, REG_ROLES, FREG_ABI_NAMES, FREG_ROLES } from '../vm/registers';
import { privName, privLong, SSTATUS_MASK } from '../vm/mmu';
import { PLIC_NUM_SOURCES, UART_IRQ } from '../vm/constants';
import { formatWord, hexWord } from '../vm/format';
import type { Radix } from '../vm/format';
import { f32FromBits, f64FromBits } from '../vm/fp';

interface Props {
  cpu: Cpu;
  prevRegs: Int32Array;
}

const RADII: Radix[] = ['hex', 'dec', 'udec', 'bin'];

/** The six standard interrupt sources and their mip/mie bit positions, in priority order. */
const INT_BITS: readonly [string, number][] = [
  ['MEI', 11], ['MSI', 3], ['MTI', 7], ['SEI', 9], ['SSI', 1], ['STI', 5],
];

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
          MIE={(cpu.mstatus >>> 3) & 1} · MPIE={(cpu.mstatus >>> 7) & 1} · MPP=
          {privName((cpu.mstatus >>> 11) & 3)}
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
            ['medeleg', cpu.medeleg],
            ['mideleg', cpu.mideleg],
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

      <div className="reg-subhead">
        <span>interrupts (mip / mie)</span>
        <span className="reg-fcsr" title="pending·enabled, per interrupt source">
          {INT_BITS.map(([label, bit]) => {
            const p = (cpu.mip >>> bit) & 1;
            const e = (cpu.mie >>> bit) & 1;
            return (
              <span key={label} className={`irq-flag${p ? ' irq-pending' : ''}${p && e ? ' irq-armed' : ''}`}>
                {label}
                <sub>{p}{e}</sub>
              </span>
            );
          })}
        </span>
      </div>

      <div className="reg-subhead">
        <span>supervisor trap CSRs + Sv32</span>
        <span className="reg-fcsr">
          SIE={(cpu.mstatus >>> 1) & 1} · SPIE={(cpu.mstatus >>> 5) & 1} · SPP=
          {privName((cpu.mstatus >>> 8) & 1)}
        </span>
      </div>
      <div className="reg-grid mcsr-grid">
        {(
          [
            ['sstatus', cpu.mstatus & SSTATUS_MASK],
            ['stvec', cpu.stvec],
            ['sepc', cpu.sepc],
            ['scause', cpu.scause],
            ['stval', cpu.stval],
            ['sscratch', cpu.sscratch],
            ['satp', cpu.satp],
          ] as const
        ).map(([name, val]) => (
          <div key={name} className="reg-cell" title={`CSR ${name}`}>
            <span className="reg-name">{name}</span>
            <span className="reg-val">{hexWord(val)}</span>
          </div>
        ))}
        <div className="reg-cell" title="Sstc supervisor timer compare (drives mip.STIP)">
          <span className="reg-name">stimecmp</span>
          <span className="reg-val">
            {Number.isFinite(cpu.stimecmp) ? cpu.stimecmp.toLocaleString() : '∞'}
          </span>
        </div>
      </div>
      <div className="reg-subhead">
        <span>external interrupts — PLIC + UART</span>
        <span className="reg-fcsr" title="the PLIC gateway's pending sources">
          {(() => {
            const pending = cpu.dev.pending();
            const srcs: string[] = [];
            for (let id = 1; id <= PLIC_NUM_SOURCES; id++) if ((pending >>> id) & 1) srcs.push(`#${id}`);
            return `pending: ${srcs.length ? srcs.join(' ') : '—'}`;
          })()}
        </span>
      </div>
      <div className="reg-grid mcsr-grid">
        <div className="reg-cell" title="PLIC pending bitmap (gateway output)">
          <span className="reg-name">plic.pending</span>
          <span className="reg-val">{hexWord(cpu.dev.pending())}</span>
        </div>
        <div className="reg-cell" title="Sources currently in service (claimed, awaiting complete)">
          <span className="reg-name">plic.claimed</span>
          <span className="reg-val">{hexWord(cpu.dev.claimed)}</span>
        </div>
        <div className="reg-cell" title="Context 0 (M-mode) source-enable bitmap → drives mip.MEIP">
          <span className="reg-name">M enable</span>
          <span className="reg-val">{hexWord(cpu.dev.enable[0])}</span>
        </div>
        <div className="reg-cell" title="Context 1 (S-mode) source-enable bitmap → drives mip.SEIP">
          <span className="reg-name">S enable</span>
          <span className="reg-val">{hexWord(cpu.dev.enable[1])}</span>
        </div>
        <div className="reg-cell" title="Context 0 / 1 priority thresholds">
          <span className="reg-name">threshold</span>
          <span className="reg-val">M={cpu.dev.threshold[0]} · S={cpu.dev.threshold[1]}</span>
        </div>
        <div className="reg-cell" title={`UART source #${UART_IRQ} priority`}>
          <span className="reg-name">uart.prio</span>
          <span className="reg-val">{cpu.dev.priority[UART_IRQ]}</span>
        </div>
        <div className="reg-cell" title="UART interrupt-enable (bit 0 = receive-data-available)">
          <span className="reg-name">uart.ier</span>
          <span className="reg-val">{hexWord(cpu.dev.ier)}</span>
        </div>
        <div className="reg-cell" title="UART receive FIFO: bytes read / total in the stream">
          <span className="reg-name">uart.rx</span>
          <span className="reg-val">
            {cpu.dev.rxPos}/{cpu.dev.rxTotal()}
            {cpu.dev.rxRemaining() > 0 ? ' ●' : ''}
          </span>
        </div>
      </div>

      {cpu.error && <div className="reg-error">⚠ {cpu.error}</div>}
    </div>
  );
}
