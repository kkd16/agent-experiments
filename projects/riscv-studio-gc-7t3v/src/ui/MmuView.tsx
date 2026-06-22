// The MMU / privilege inspector. Shows the current privilege mode, the satp translation
// register, the privilege-relevant mstatus fields, the supervisor trap CSRs + delegation,
// a live page-table-walk visualizer for any probed virtual address, and the (incoherent)
// TLB with its hit/miss tally. This makes the otherwise-invisible Sv32 translation legible.

import { useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { hexWord } from '../vm/format';
import {
  decodeSatp,
  decodePte,
  pteFlagString,
  privName,
  privLong,
  causeName,
  MSTATUS,
  type Access,
} from '../vm/mmu';

interface Props {
  cpu: Cpu;
  /** Bumps on every machine mutation so the inspector re-renders in lock-step. */
  tick: number;
}

const ACCESSES: Access[] = ['fetch', 'load', 'store'];

export default function MmuView({ cpu, tick }: Props) {
  void tick;
  const [vaText, setVaText] = useState('0x40000000');
  const [access, setAccess] = useState<Access>('store');

  const satp = decodeSatp(cpu.satp);
  const va = parseAddr(vaText);
  const trace = va === null ? null : cpu.probeTranslate(va >>> 0, access);
  const m = cpu.mstatus;
  const bit = (mask: number) => ((m & mask) !== 0 ? 1 : 0);
  const mpp = (m >>> 11) & 3;
  const tlb = cpu.tlbEntries();
  const total = cpu.tlbHits + cpu.tlbMisses;
  const hitRate = total === 0 ? '—' : `${((100 * cpu.tlbHits) / total).toFixed(1)}%`;

  return (
    <div className="panel mmu">
      <div className="panel-head">
        <h2>MMU &amp; Privilege</h2>
        <span className={`priv-badge priv-${privName(cpu.priv)}`}>{privLong(cpu.priv)} mode</span>
      </div>

      {/* --- satp + the privilege-relevant mstatus fields --- */}
      <div className="reg-subhead">
        <span>address translation</span>
        <span className="reg-fcsr">
          satp = {hexWord(cpu.satp)} · {satp.mode === 1 ? 'Sv32' : 'Bare'}
        </span>
      </div>
      <div className="reg-grid mcsr-grid">
        <Cell name="mode" val={satp.mode === 1 ? 'Sv32' : 'Bare'} title="satp.MODE: 1 = paged, 0 = identity" />
        <Cell name="asid" val={satp.asid.toString()} title="address-space id" />
        <Cell name="root ppn" val={'0x' + satp.ppn.toString(16)} title="physical page number of the root table" />
        <Cell name="root @" val={hexWord(satp.rootBase)} title="physical base of the root page table" />
      </div>

      <div className="reg-subhead">
        <span>mstatus (privilege bits)</span>
        <span className="reg-fcsr">{hexWord(m)}</span>
      </div>
      <div className="reg-grid mcsr-grid">
        <Cell name="MPP" val={`${mpp} (${privName(mpp)})`} title="machine previous privilege — where mret returns" />
        <Cell name="SPP" val={`${bit(MSTATUS.SPP)} (${bit(MSTATUS.SPP) ? 'S' : 'U'})`} title="supervisor previous privilege — where sret returns" />
        <Cell name="MIE / SIE" val={`${bit(MSTATUS.MIE)} / ${bit(MSTATUS.SIE)}`} title="global interrupt-enable (M / S)" />
        <Cell name="MPIE/SPIE" val={`${bit(MSTATUS.MPIE)} / ${bit(MSTATUS.SPIE)}`} title="prior interrupt-enable saved on trap" />
        <Cell name="MPRV" val={String(bit(MSTATUS.MPRV))} title="loads/stores use MPP's privilege when set" />
        <Cell name="SUM" val={String(bit(MSTATUS.SUM))} title="permit S-mode access to user pages" />
        <Cell name="MXR" val={String(bit(MSTATUS.MXR))} title="make execute-only pages readable" />
        <Cell name="" val="" title="" />
      </div>

      <div className="reg-subhead">
        <span>supervisor trap CSRs · delegation</span>
        <span className="reg-fcsr">scause = {hexWord(cpu.scause)}</span>
      </div>
      <div className="reg-grid mcsr-grid">
        <Cell name="stvec" val={hexWord(cpu.stvec)} title="supervisor trap-handler base" />
        <Cell name="sepc" val={hexWord(cpu.sepc)} title="supervisor exception pc" />
        <Cell name="scause" val={hexWord(cpu.scause)} title="supervisor trap cause" />
        <Cell name="stval" val={hexWord(cpu.stval)} title="supervisor trap value (e.g. faulting VA)" />
        <Cell name="sscratch" val={hexWord(cpu.sscratch)} title="supervisor scratch register" />
        <Cell name="medeleg" val={hexWord(cpu.medeleg)} title="exceptions delegated to S-mode (cause bitmap)" />
        <Cell name="mideleg" val={hexWord(cpu.mideleg)} title="interrupts delegated to S-mode" />
        <Cell name="" val="" title="" />
      </div>

      {/* --- the page-table walk visualizer --- */}
      <div className="reg-subhead">
        <span>page-table walk</span>
        <span className="walk-controls">
          <input
            className="va-input"
            value={vaText}
            spellCheck={false}
            onChange={(e) => setVaText(e.target.value)}
            aria-label="virtual address to probe"
          />
          {ACCESSES.map((a) => (
            <button key={a} className={access === a ? 'on' : ''} onClick={() => setAccess(a)}>
              {a}
            </button>
          ))}
        </span>
      </div>

      {trace === null ? (
        <div className="walk-note bad">enter a hex or decimal virtual address</div>
      ) : (
        <div className="walk">
          <div className="walk-va">
            <span className="reg-name">VA {hexWord(trace.va)}</span>
            <span className="va-split">
              <em>vpn1</em> {trace.vpn1} · <em>vpn0</em> {trace.vpn0} · <em>off</em> 0x
              {trace.offset.toString(16)}
            </span>
          </div>

          {!trace.active ? (
            <div className="walk-note">{trace.reason}</div>
          ) : (
            <>
              {trace.levels.map((lv) => (
                <div key={lv.level} className="walk-level">
                  <div className="walk-step">
                    <span className="lv">L{lv.level}</span>
                    <span className="reg-val">
                      pte@{hexWord(lv.pteAddr)} = {hexWord(lv.pte.raw)}
                    </span>
                  </div>
                  <div className="walk-flags">
                    <span className="flags">{pteFlagString(lv.pte)}</span>
                    <span className="ppn">
                      ppn 0x{lv.pte.ppn.toString(16)} · {lv.pte.leaf ? 'leaf' : 'pointer'}
                    </span>
                  </div>
                </div>
              ))}
              {trace.fault !== undefined ? (
                <div className="walk-note bad">
                  ✗ {causeName(trace.fault)} — {trace.reason}
                </div>
              ) : (
                <div className="walk-note good">
                  ✓ PA {hexWord(trace.pa!)} — {trace.reason}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* --- the TLB --- */}
      <div className="reg-subhead">
        <span>TLB (incoherent — flushed by sfence.vma)</span>
        <span className="walk-controls">
          <span className="reg-fcsr">
            {cpu.tlbHits} hit · {cpu.tlbMisses} miss · {hitRate}
          </span>
          <button onClick={() => cpu.flushTlb()} title="flush all cached translations">
            flush
          </button>
        </span>
      </div>
      {tlb.length === 0 ? (
        <div className="walk-note">empty — translation off, or no access has been translated yet</div>
      ) : (
        <div className="tlb-grid">
          <div className="tlb-row tlb-head">
            <span>VPN</span>
            <span>page</span>
            <span>PTE</span>
            <span>flags</span>
          </div>
          {tlb.map((e) => {
            const p = decodePte(e.pte);
            return (
              <div key={e.vpn} className="tlb-row">
                <span>0x{e.vpn.toString(16)}</span>
                <span>{e.level === 1 ? '4 MiB' : '4 KiB'}</span>
                <span>{hexWord(e.pte)}</span>
                <span className="flags">{pteFlagString(p)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Cell({ name, val, title }: { name: string; val: string; title: string }) {
  if (!name) return <div className="reg-cell" aria-hidden="true" />;
  return (
    <div className="reg-cell" title={title}>
      <span className="reg-name">{name}</span>
      <span className="reg-val">{val}</span>
    </div>
  );
}

/** Parse a hex (`0x…`) or decimal virtual address; null if it is not a number. */
function parseAddr(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const v = /^0x[0-9a-fA-F]+$/.test(t) ? parseInt(t.slice(2), 16) : /^[0-9]+$/.test(t) ? parseInt(t, 10) : NaN;
  return Number.isFinite(v) ? v >>> 0 : null;
}
