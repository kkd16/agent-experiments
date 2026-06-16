// Register file inspector: all 32 GPRs and 32 FP registers, plus pc, cycles, fcsr and the
// hardware counters. Values that changed since the last step are highlighted, and the integer
// view has a selectable display radix.

import { useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { ABI_NAMES, REG_ROLES, FREG_ABI_NAMES, FREG_ROLES } from '../vm/registers';
import { formatWord, hexWord } from '../vm/format';
import type { Radix } from '../vm/format';
import { f32FromBits } from '../vm/fp';
import { ACCESS_FETCH } from '../vm/mmu';
import type { TranslationTrace } from '../vm/mmu';

interface Props {
  cpu: Cpu;
  prevRegs: Int32Array;
}

const RADII: Radix[] = ['hex', 'dec', 'udec', 'bin'];

const PRIV_NAMES: Record<number, string> = { 0: 'U user', 1: 'S supervisor', 3: 'M machine' };
const PAGE_FAULT_NAMES: Record<number, string> = {
  12: 'instruction page fault',
  13: 'load page fault',
  15: 'store/AMO page fault',
};

/** Decode `satp` into a friendly one-liner for the MMU sub-header. */
function satpLabel(satp: number): string {
  if ((satp >>> 31 & 1) === 0) return 'Bare (translation off)';
  const asid = (satp >>> 22) & 0x1ff;
  const rootPhys = (satp & 0x3f_ffff) * 0x1000;
  return `Sv32 · ASID ${asid} · root @ ${hexWord(rootPhys >>> 0)}`;
}

/** One row per page-table level visited by a read-only walk of the current pc. */
function TranslationTracer({ trace }: { trace: TranslationTrace }) {
  return (
    <div className="mmu-trace">
      <div className="mmu-trace-head">
        translate pc {hexWord(trace.vaddr)} →{' '}
        {trace.fault !== null ? (
          <span className="status-error">{PAGE_FAULT_NAMES[trace.fault] ?? 'page fault'}</span>
        ) : (
          <span className="status-paused">{hexWord(trace.physical! >>> 0)}</span>
        )}
      </div>
      {trace.steps.map((s, i) => (
        <div key={i} className={`mmu-trace-step kind-${s.kind}`}>
          <span className="reg-name">L{s.level}</span>
          <span className="reg-val">{hexWord(s.pteAddr)}</span>
          <span className="mmu-pte">pte {hexWord(s.pte)}</span>
          <span className="mmu-kind">{s.kind}</span>
        </div>
      ))}
    </div>
  );
}

/** Compact single-precision rendering: integers keep a `.0`, others ~7 sig-figs. */
function fmtFloat(bits: number): string {
  const x = f32FromBits(bits);
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '-∞';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  if (Number.isInteger(x) && Math.abs(x) < 1e7) return `${x}.0`;
  return String(Number(x.toPrecision(7)));
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
            <span>float registers (RV32F)</span>
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
                <span className="reg-val">{fmtFloat(cpu.fregs[i])}</span>
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
        <div className="reg-cell">
          <span className="reg-name">status</span>
          <span className={`reg-val status-${cpu.status}`}>{cpu.status}</span>
        </div>
        <div className="reg-cell" title="current privilege ring">
          <span className="reg-name">priv</span>
          <span className={`reg-val priv-${cpu.priv}`}>{PRIV_NAMES[cpu.priv] ?? cpu.priv}</span>
        </div>
      </div>

      {(cpu.mtvec !== 0 || cpu.mcause !== 0 || cpu.mstatus !== 0) && (
        <>
          <div className="reg-subhead">
            <span>machine-mode trap CSRs</span>
            <span className="reg-fcsr">
              MIE={(cpu.mstatus >> 3) & 1} · MPIE={(cpu.mstatus >> 7) & 1}
            </span>
          </div>
          <div className="reg-special csr-special">
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
              ] as [string, number][]
            ).map(([name, val]) => (
              <div key={name} className="reg-cell" title={`CSR ${name}`}>
                <span className="reg-name">{name}</span>
                <span className="reg-val">{hexWord(val)}</span>
              </div>
            ))}
            <div className="reg-cell" title="CLINT mtime">
              <span className="reg-name">mtime</span>
              <span className="reg-val">{cpu.mtime.toLocaleString()}</span>
            </div>
            <div className="reg-cell" title="CLINT mtimecmp">
              <span className="reg-name">mtimecmp</span>
              <span className="reg-val">{cpu.mtimecmp.toLocaleString()}</span>
            </div>
          </div>
        </>
      )}
      {(cpu.satp !== 0 || cpu.priv !== 3 || cpu.stvec !== 0 || cpu.scause !== 0) && (
        <>
          <div className="reg-subhead">
            <span>supervisor mode &amp; Sv32 MMU</span>
            <span className="reg-fcsr">{satpLabel(cpu.satp)}</span>
          </div>
          <div className="reg-special csr-special">
            {(
              [
                ['stvec', cpu.stvec],
                ['sepc', cpu.sepc],
                ['scause', cpu.scause],
                ['stval', cpu.stval],
                ['sscratch', cpu.sscratch],
                ['satp', cpu.satp],
                ['medeleg', cpu.medeleg],
                ['mideleg', cpu.mideleg],
              ] as [string, number][]
            ).map(([name, val]) => (
              <div key={name} className="reg-cell" title={`CSR ${name}`}>
                <span className="reg-name">{name}</span>
                <span className="reg-val">{hexWord(val)}</span>
              </div>
            ))}
          </div>
          {(cpu.satp >>> 31 & 1) === 1 && cpu.priv !== 3 && (
            <TranslationTracer trace={cpu.explainTranslation(cpu.pc, ACCESS_FETCH)} />
          )}
        </>
      )}
      {cpu.error && <div className="reg-error">⚠ {cpu.error}</div>}
    </div>
  );
}
