import { useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { GateOp } from '../quantum/QuantumState';

interface GateDef {
  name: string;
  label: string;
  color: string;
  description: string;
  qubits: number;
  paramCount?: number;
}

const GATE_PALETTE: GateDef[] = [
  { name: 'H', label: 'H', color: '#7c3aed', description: 'Hadamard', qubits: 1 },
  { name: 'X', label: 'X', color: '#dc2626', description: 'Pauli-X (NOT)', qubits: 1 },
  { name: 'Y', label: 'Y', color: '#d97706', description: 'Pauli-Y', qubits: 1 },
  { name: 'Z', label: 'Z', color: '#059669', description: 'Pauli-Z', qubits: 1 },
  { name: 'S', label: 'S', color: '#0891b2', description: 'S (π/2 phase)', qubits: 1 },
  { name: 'T', label: 'T', color: '#7c3aed', description: 'T (π/4 phase)', qubits: 1 },
  { name: 'Rx', label: 'Rx', color: '#dc2626', description: 'X-rotation', qubits: 1, paramCount: 1 },
  { name: 'Ry', label: 'Ry', color: '#d97706', description: 'Y-rotation', qubits: 1, paramCount: 1 },
  { name: 'Rz', label: 'Rz', color: '#059669', description: 'Z-rotation', qubits: 1, paramCount: 1 },
  { name: 'CNOT', label: 'CX', color: '#dc2626', description: 'Controlled-NOT', qubits: 2 },
  { name: 'CZ', label: 'CZ', color: '#059669', description: 'Controlled-Z', qubits: 2 },
  { name: 'SWAP', label: '⇄', color: '#0891b2', description: 'SWAP', qubits: 2 },
  { name: 'Toffoli', label: 'CCX', color: '#7c3aed', description: 'Toffoli (3-qubit)', qubits: 3 },
];

interface CircuitCell {
  id: string;
  col: number;
  gate: GateDef;
  qubits: number[];
  params?: number[];
}

interface Props {
  numQubits: number;
  onNumQubitsChange: (n: number) => void;
  ops: GateOp[];
  onOpsChange: (ops: GateOp[]) => void;
}

const CELL_W = 52;
const CELL_H = 48;
const QUBIT_LABEL_W = 36;
const MIN_COLS = 8;

function gateId() {
  return Math.random().toString(36).slice(2, 9);
}

export default function CircuitEditor({ numQubits, onNumQubitsChange, ops, onOpsChange }: Props) {
  const [dragging, setDragging] = useState<GateDef | null>(null);
  const [hoverCell, setHoverCell] = useState<{ col: number; qubit: number } | null>(null);
  const [pendingGate, setPendingGate] = useState<{ gate: GateDef; col: number; qubits: number[] } | null>(null);
  const [paramInput, setParamInput] = useState('3.14159');
  const [cells, setCells] = useState<CircuitCell[]>([]);
  const dragRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const numCols = Math.max(MIN_COLS, Math.max(...cells.map((c) => c.col + 1), 0) + 3);

  const rebuildOps = useCallback((newCells: CircuitCell[]) => {
    const sorted = [...newCells].sort((a, b) => a.col !== b.col ? a.col - b.col : a.qubits[0] - b.qubits[0]);
    const newOps: GateOp[] = sorted.map((c) => ({
      name: c.gate.name,
      qubits: c.qubits,
      params: c.params,
    }));
    onOpsChange(newOps);
  }, [onOpsChange]);

  const placeGate = useCallback((gate: GateDef, col: number, startQubit: number) => {
    if (gate.qubits === 1) {
      if (gate.paramCount) {
        setPendingGate({ gate, col, qubits: [startQubit] });
        return;
      }
      const newCell: CircuitCell = { id: gateId(), col, gate, qubits: [startQubit] };
      const updated = [...cells, newCell];
      setCells(updated);
      rebuildOps(updated);
    } else {
      // Multi-qubit: use startQubit and next qubits
      const qubits = Array.from({ length: gate.qubits }, (_, i) => startQubit + i).filter((q) => q < numQubits);
      if (qubits.length < gate.qubits) return;
      const newCell: CircuitCell = { id: gateId(), col, gate, qubits };
      const updated = [...cells, newCell];
      setCells(updated);
      rebuildOps(updated);
    }
  }, [cells, numQubits, rebuildOps]);

  const confirmParam = useCallback(() => {
    if (!pendingGate) return;
    const param = parseFloat(paramInput);
    if (isNaN(param)) return;
    const newCell: CircuitCell = {
      id: gateId(),
      col: pendingGate.col,
      gate: pendingGate.gate,
      qubits: pendingGate.qubits,
      params: [param],
    };
    const updated = [...cells, newCell];
    setCells(updated);
    rebuildOps(updated);
    setPendingGate(null);
  }, [pendingGate, paramInput, cells, rebuildOps]);

  const removeCell = useCallback((id: string) => {
    const updated = cells.filter((c) => c.id !== id);
    setCells(updated);
    rebuildOps(updated);
  }, [cells, rebuildOps]);

  const clearAll = useCallback(() => {
    setCells([]);
    onOpsChange([]);
  }, [onOpsChange]);

  const getCellAtQubit = (col: number, qubit: number) =>
    cells.find((c) => c.col === col && c.qubits.includes(qubit));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Gate Palette */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{ color: '#64748b', fontSize: 11, marginRight: 4 }}>Gates:</span>
        {GATE_PALETTE.map((gate) => (
          <motion.div
            key={gate.name}
            draggable
            onDragStart={() => {
              setDragging(gate);
              dragRef.current = { x: 0, y: 0 };
            }}
            onDragEnd={() => setDragging(null)}
            whileHover={{ scale: 1.08, y: -1 }}
            whileTap={{ scale: 0.95 }}
            title={gate.description}
            style={{
              width: 36,
              height: 28,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: gate.color,
              borderRadius: 4,
              cursor: 'grab',
              fontSize: 10,
              fontWeight: 700,
              color: '#fff',
              userSelect: 'none',
              boxShadow: `0 0 8px ${gate.color}66`,
              fontFamily: 'monospace',
            }}
          >
            {gate.label}
          </motion.div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <span style={{ color: '#64748b', fontSize: 11 }}>Qubits:</span>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <button
              key={n}
              onClick={() => onNumQubitsChange(n)}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                border: 'none',
                background: numQubits === n ? '#7c3aed' : '#1e293b',
                color: numQubits === n ? '#fff' : '#64748b',
                fontSize: 11,
                cursor: 'pointer',
                fontWeight: numQubits === n ? 700 : 400,
              }}
            >
              {n}
            </button>
          ))}
          <button
            onClick={clearAll}
            style={{
              padding: '3px 8px',
              borderRadius: 4,
              border: '1px solid #ef4444',
              background: 'transparent',
              color: '#ef4444',
              fontSize: 10,
              cursor: 'pointer',
              marginLeft: 8,
            }}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Circuit Grid */}
      <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          {/* SVG for wires and gate connections */}
          <svg
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 1 }}
            width={QUBIT_LABEL_W + numCols * CELL_W}
            height={numQubits * CELL_H}
          >
            {/* Horizontal wires */}
            {Array.from({ length: numQubits }, (_, q) => (
              <line
                key={q}
                x1={QUBIT_LABEL_W}
                y1={q * CELL_H + CELL_H / 2}
                x2={QUBIT_LABEL_W + numCols * CELL_W}
                y2={q * CELL_H + CELL_H / 2}
                stroke="#1e3a5f"
                strokeWidth={1.5}
              />
            ))}

            {/* Multi-qubit gate vertical connections */}
            {cells.filter((c) => c.gate.qubits > 1).map((c) => {
              const minQ = Math.min(...c.qubits);
              const maxQ = Math.max(...c.qubits);
              const x = QUBIT_LABEL_W + c.col * CELL_W + CELL_W / 2;
              return (
                <line
                  key={`conn-${c.id}`}
                  x1={x}
                  y1={minQ * CELL_H + CELL_H / 2}
                  x2={x}
                  y2={maxQ * CELL_H + CELL_H / 2}
                  stroke={c.gate.color}
                  strokeWidth={2}
                  strokeDasharray="4,2"
                  opacity={0.7}
                />
              );
            })}
          </svg>

          {/* Grid cells */}
          <div style={{ display: 'grid', gridTemplateRows: `repeat(${numQubits}, ${CELL_H}px)` }}>
            {Array.from({ length: numQubits }, (_, qubit) => (
              <div key={qubit} style={{ display: 'flex', alignItems: 'center' }}>
                {/* Qubit label */}
                <div style={{
                  width: QUBIT_LABEL_W,
                  height: CELL_H,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#7c3aed',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  flexShrink: 0,
                  zIndex: 2,
                  position: 'relative',
                }}>
                  q{qubit}
                </div>

                {/* Columns */}
                {Array.from({ length: numCols }, (_, col) => {
                  const cell = getCellAtQubit(col, qubit);
                  const isHover = hoverCell?.col === col && hoverCell?.qubit === qubit;
                  const isPrimary = cell && cell.qubits[0] === qubit;

                  return (
                    <div
                      key={col}
                      style={{
                        width: CELL_W,
                        height: CELL_H,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        position: 'relative',
                        zIndex: 2,
                        background: isHover && !cell ? 'rgba(124, 58, 237, 0.1)' : 'transparent',
                        borderRadius: 4,
                        cursor: 'copy',
                      }}
                      onDragOver={(e) => {
                        e.preventDefault();
                        setHoverCell({ col, qubit });
                      }}
                      onDragLeave={() => setHoverCell(null)}
                      onDrop={() => {
                        setHoverCell(null);
                        if (dragging) placeGate(dragging, col, qubit);
                      }}
                      onClick={() => {
                        if (!cell && dragging === null) {
                          // Allow clicking a preset gate from the keyboard would go here
                        }
                      }}
                    >
                      <AnimatePresence>
                        {cell && isPrimary && (
                          <motion.div
                            key={cell.id}
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                            transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                            onClick={() => removeCell(cell.id)}
                            title={`${cell.gate.description} — click to remove`}
                            style={{
                              width: 38,
                              height: 32,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              background: cell.gate.color,
                              borderRadius: 5,
                              cursor: 'pointer',
                              fontSize: cell.gate.label.length > 2 ? 9 : 11,
                              fontWeight: 700,
                              color: '#fff',
                              userSelect: 'none',
                              boxShadow: `0 0 10px ${cell.gate.color}88, 0 2px 4px rgba(0,0,0,0.4)`,
                              fontFamily: 'monospace',
                              position: 'relative',
                              zIndex: 3,
                            }}
                          >
                            {cell.gate.label}
                            {cell.params && (
                              <span style={{ position: 'absolute', bottom: -1, right: 2, fontSize: 7, opacity: 0.8 }}>
                                {cell.params[0].toFixed(2)}
                              </span>
                            )}
                          </motion.div>
                        )}
                        {cell && !isPrimary && cell.gate.qubits > 1 && (
                          <motion.div
                            key={`dot-${cell.id}-${qubit}`}
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            exit={{ scale: 0 }}
                            style={{
                              width: 10,
                              height: 10,
                              borderRadius: '50%',
                              background: cell.gate.color,
                              boxShadow: `0 0 6px ${cell.gate.color}`,
                            }}
                          />
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ color: '#475569', fontSize: 10 }}>
        {ops.length} gate{ops.length !== 1 ? 's' : ''} — drag gates onto the circuit wires • click a gate to remove
      </div>

      {/* Parameter dialog */}
      <AnimatePresence>
        {pendingGate && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 100,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0,0,0,0.7)',
            }}
            onClick={(e) => e.target === e.currentTarget && setPendingGate(null)}
          >
            <div style={{
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: 12,
              padding: 24,
              minWidth: 280,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 12, color: '#e2e8f0' }}>
                {pendingGate.gate.name} angle (radians)
              </div>
              <input
                type="number"
                value={paramInput}
                onChange={(e) => setParamInput(e.target.value)}
                step={0.1}
                style={{
                  width: '100%',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  borderRadius: 6,
                  padding: '8px 12px',
                  color: '#e2e8f0',
                  fontSize: 14,
                  fontFamily: 'monospace',
                  marginBottom: 12,
                  boxSizing: 'border-box',
                }}
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && confirmParam()}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                {['π/4', 'π/2', 'π', '2π'].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => {
                      const vals: Record<string, string> = { 'π/4': '0.7854', 'π/2': '1.5708', 'π': '3.14159', '2π': '6.28318' };
                      setParamInput(vals[preset]);
                    }}
                    style={{
                      flex: 1,
                      padding: '4px 0',
                      borderRadius: 4,
                      border: '1px solid #334155',
                      background: '#1e293b',
                      color: '#94a3b8',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'monospace',
                    }}
                  >
                    {preset}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  onClick={confirmParam}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 6,
                    border: 'none',
                    background: '#7c3aed',
                    color: '#fff',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Add Gate
                </button>
                <button
                  onClick={() => setPendingGate(null)}
                  style={{
                    flex: 1,
                    padding: '8px 0',
                    borderRadius: 6,
                    border: '1px solid #334155',
                    background: 'transparent',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
