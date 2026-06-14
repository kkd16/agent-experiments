// Hex-dump memory inspector. Jump to a region (text / data / stack / framebuffer) or type
// an arbitrary address; the dump follows the program counter when "track pc" is on.

import { useMemo, useState } from 'react';
import type { Cpu } from '../vm/cpu';
import { DATA_BASE, FB_BASE, STACK_TOP, TEXT_BASE } from '../vm/constants';
import { toHex, parseIntLiteral } from '../vm/format';

interface Props {
  cpu: Cpu;
}

const ROWS = 16;
const COLS = 16;

const REGIONS: { label: string; addr: number }[] = [
  { label: '.text', addr: TEXT_BASE },
  { label: '.data', addr: DATA_BASE },
  { label: 'stack', addr: (STACK_TOP - 0xf0) >>> 0 },
  { label: 'framebuffer', addr: FB_BASE },
];

export default function MemoryView({ cpu }: Props) {
  const [base, setBase] = useState<number>(DATA_BASE);
  const [input, setInput] = useState<string>('');
  const [trackPc, setTrackPc] = useState(false);

  const start = trackPc ? (cpu.pc & ~0xf) >>> 0 : base;

  const rows = useMemo(() => {
    const out: { addr: number; bytes: number[] }[] = [];
    for (let r = 0; r < ROWS; r++) {
      const addr = (start + r * COLS) >>> 0;
      const bytes: number[] = [];
      for (let c = 0; c < COLS; c++) bytes.push(cpu.mem.readByte((addr + c) >>> 0));
      out.push({ addr, bytes });
    }
    return out;
    // cpu.tick handled by parent re-render; start covers navigation.
  }, [cpu, start]);

  const go = () => {
    const v = parseIntLiteral(input);
    if (v !== null) {
      setBase(v >>> 0);
      setTrackPc(false);
    }
  };

  return (
    <div className="panel mem">
      <div className="panel-head">
        <h2>Memory</h2>
        <div className="mem-nav">
          {REGIONS.map((reg) => (
            <button
              key={reg.label}
              className={!trackPc && start === reg.addr ? 'on' : ''}
              onClick={() => {
                setBase(reg.addr);
                setTrackPc(false);
              }}
            >
              {reg.label}
            </button>
          ))}
          <button className={trackPc ? 'on' : ''} onClick={() => setTrackPc((t) => !t)}>
            track pc
          </button>
        </div>
      </div>

      <div className="mem-jump">
        <input
          placeholder="0x10010000"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
        />
        <button onClick={go}>go</button>
      </div>

      <div className="hexdump">
        <div className="hex-row hex-header">
          <span className="hex-addr">address</span>
          <span className="hex-bytes">
            {Array.from({ length: COLS }, (_, i) => (
              <span key={i} className="hex-col">
                {toHex(i, 2)}
              </span>
            ))}
          </span>
          <span className="hex-ascii">ascii</span>
        </div>
        {rows.map((row) => (
          <div key={row.addr} className="hex-row">
            <span className="hex-addr">{toHex(row.addr, 8)}</span>
            <span className="hex-bytes">
              {row.bytes.map((b, i) => (
                <span key={i} className={`hex-byte${b !== 0 ? ' nz' : ''}`}>
                  {toHex(b, 2)}
                </span>
              ))}
            </span>
            <span className="hex-ascii">
              {row.bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
