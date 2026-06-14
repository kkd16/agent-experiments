import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { useVM } from './hooks/useVM';
import { useHashRoute } from './router';
import { DEFAULT_EXAMPLE, EXAMPLES } from './vm/examples';
import type { Example } from './vm/examples';
import { programFromUrl, buildShareUrl } from './vm/share';
import Editor from './ui/Editor';
import Registers from './ui/Registers';
import MemoryView from './ui/MemoryView';
import Disasm from './ui/Disasm';
import Console from './ui/Console';
import Framebuffer from './ui/Framebuffer';
import Tests from './ui/Tests';
import Examples from './ui/Examples';
import Docs from './ui/Docs';
import CCStudio from './ui/CCStudio';

const TABS: { id: string; label: string }[] = [
  { id: 'registers', label: 'Registers' },
  { id: 'disasm', label: 'Disassembly' },
  { id: 'memory', label: 'Memory' },
  { id: 'console', label: 'Console' },
  { id: 'display', label: 'Display' },
  { id: 'cc', label: 'C Compiler' },
  { id: 'examples', label: 'Examples' },
  { id: 'verify', label: 'Verify' },
  { id: 'docs', label: 'Docs' },
];

export default function App() {
  // A shared `?prog=` link wins over the default example on first load.
  const sharedProgram = useMemo(() => programFromUrl(), []);
  const vm = useVM(sharedProgram ?? DEFAULT_EXAMPLE.code);
  const [route, navigate] = useHashRoute();
  const [activeExample, setActiveExample] = useState<string | null>(
    sharedProgram ? null : DEFAULT_EXAMPLE.id,
  );
  const [shared, setShared] = useState(false);
  const didInit = useRef(false);

  // Load the initial program once on mount so the inspector is populated immediately.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    vm.loadSource(sharedProgram ?? DEFAULT_EXAMPLE.code);
  }, [vm, sharedProgram]);

  const onShare = () => {
    const url = buildShareUrl(vm.source);
    try {
      window.history.replaceState(null, '', url);
    } catch {
      /* ignore: sandboxed thumbnail */
    }
    try {
      void navigator.clipboard?.writeText(url);
    } catch {
      /* clipboard may be unavailable */
    }
    setShared(true);
    window.setTimeout(() => setShared(false), 1600);
  };

  const errorLines = useMemo(() => {
    const m = new Map<number, string>();
    if (vm.assembly) for (const e of vm.assembly.errors) if (!m.has(e.line)) m.set(e.line, e.message);
    return m;
  }, [vm.assembly]);

  const onLoadExample = (ex: Example) => {
    setActiveExample(ex.id);
    vm.loadSource(ex.code);
    if (ex.focus === 'framebuffer') navigate('display');
    else navigate('console');
  };

  const onEdit = (s: string) => {
    vm.setSource(s);
    setActiveExample(null);
  };

  // The C compiler hands its generated assembly to the main debugger.
  const onSendAsm = (asm: string) => {
    vm.loadSource(asm);
    setActiveExample(null);
    navigate('console');
  };

  const status = vm.cpu.status;
  const hasErrors = vm.assembly !== null && !vm.assembly.ok;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">RV</span>
          <div>
            <h1>RISC-V Studio</h1>
            <p>an RV32IMAF + Zicsr assembler, emulator &amp; time-travel debugger</p>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={route === t.id ? 'on' : ''} onClick={() => navigate(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {route !== 'cc' && (
      <div className="toolbar">
        <div className="tool-group">
          <button className="run" onClick={vm.running ? vm.stop : vm.run} disabled={hasErrors}>
            {vm.running ? '■ Stop' : '▶ Run'}
          </button>
          <button
            onClick={vm.stepBack}
            disabled={vm.running || vm.historyDepth === 0}
            title="Time-travel: undo the last instruction"
          >
            ⤺ Back
          </button>
          <button onClick={vm.step} disabled={vm.running || hasErrors}>
            ⤳ Step
          </button>
          <button onClick={vm.reset}>↺ Reset</button>
          <button onClick={vm.assembleOnly}>⚙ Assemble</button>
          <button onClick={onShare} title="Copy a shareable link to this program">
            {shared ? '✓ Copied' : '🔗 Share'}
          </button>
        </div>
        <div className="tool-group">
          <select
            value={activeExample ?? ''}
            onChange={(e) => {
              const ex = EXAMPLES.find((x) => x.id === e.target.value);
              if (ex) onLoadExample(ex);
            }}
          >
            <option value="" disabled>
              load an example…
            </option>
            {EXAMPLES.map((ex) => (
              <option key={ex.id} value={ex.id}>
                {ex.title}
              </option>
            ))}
          </select>
          {vm.breakpointLines.size > 0 && (
            <button onClick={vm.clearBreakpoints}>✕ {vm.breakpointLines.size} bp</button>
          )}
        </div>
        <div className="tool-status">
          <span className={`pill status-${status}`}>{status}</span>
          <span className="cyc">{vm.cpu.cycles.toLocaleString()} cyc</span>
        </div>
      </div>
      )}

      {route === 'cc' ? (
        <main className="workspace cc-full">
          <CCStudio onSendAsm={onSendAsm} />
        </main>
      ) : (
        <main className="workspace">
          <section className="left">
            <Editor
              source={vm.source}
              onChange={onEdit}
              breakpointLines={vm.breakpointLines}
              onToggleBreakpoint={vm.toggleBreakpoint}
              currentLine={vm.currentLine}
              errorLines={errorLines}
            />
            {hasErrors && (
              <div className="error-bar">
                {vm.assembly!.errors.slice(0, 6).map((e, i) => (
                  <div key={i} className="err-item" onClick={() => navigate('registers')}>
                    <span className="err-line">line {e.line}</span> {e.message}
                  </div>
                ))}
                {vm.assembly!.errors.length > 6 && (
                  <div className="err-item muted">+{vm.assembly!.errors.length - 6} more…</div>
                )}
              </div>
            )}
          </section>

          <section className="right">
            {route === 'registers' && <Registers cpu={vm.cpu} prevRegs={vm.prevRegs} />}
            {route === 'disasm' && <Disasm cpu={vm.cpu} assembly={vm.assembly} />}
            {route === 'memory' && <MemoryView cpu={vm.cpu} />}
            {route === 'console' && <Console cpu={vm.cpu} />}
            {route === 'display' && <Framebuffer cpu={vm.cpu} tick={vm.tick} />}
            {route === 'examples' && <Examples onLoad={onLoadExample} activeId={activeExample} />}
            {route === 'verify' && <Tests />}
            {route === 'docs' && <Docs />}
          </section>
        </main>
      )}

      <footer className="statusline">
        <span>
          {vm.assembly?.instrs.length ?? 0} instr · {vm.breakpointLines.size} breakpoints ·{' '}
          {vm.historyDepth} undo
        </span>
        <span>
          {vm.cpu.error ? <span className="err-text">{vm.cpu.error}</span> : 'RV32IMAF · Zicsr · little-endian · 32-bit'}
        </span>
      </footer>
    </div>
  );
}
