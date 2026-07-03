import { useMemo, useState } from 'react'
import { PageHead, Panel, Slider, Verdict } from '../ui/components'
import { obliviousTransfer } from '../ecc/ot'
import {
  garbleCircuit,
  publicTables,
  evaluateCircuit,
  inputLabel,
  tablesByteSize,
  LABEL_BYTES,
  type Label,
} from '../ecc/garble'
import { millionairesCircuit, toBits, evalPlain, type Circuit } from '../ecc/circuit'
import { runMillionaires, runEquality, runSum, runProduct, runAuction } from '../ecc/twopc'
import { gmwCompute, type GmwResult } from '../ecc/gmw'
import { utf8, bytesToHex } from '../ecc/sha256'
import { edEncode, type EdPoint } from '../ecc/ed25519'
import { ellipsize } from '../ui/format'

const hexLabel = (b: Label): string => bytesToHex(b)
const ptHex = (P: EdPoint, head = 20, tail = 8): string => ellipsize(bytesToHex(edEncode(P)), head, tail)

// Garble + evaluate a circuit with both inputs known (for the integrity demo),
// optionally flipping one byte of the first AND gate's ciphertext to show that a
// tampered table yields the wrong answer.
function garbleAndEval(circuit: Circuit, aliceBits: number[], bobBits: number[], corrupt: boolean) {
  const gc = garbleCircuit(circuit)
  const gt = publicTables(gc)
  const active: Label[] = new Array(circuit.numWires)
  circuit.aliceInputs.forEach((w, i) => (active[w] = inputLabel(gc, w, aliceBits[i] & 1)))
  circuit.bobInputs.forEach((w, i) => (active[w] = inputLabel(gc, w, bobBits[i] & 1)))
  let tables = gt
  if (corrupt) {
    const idx = tables.tables.findIndex((t) => t !== null)
    if (idx >= 0) {
      const copy = tables.tables.map((t) => (t ? [t[0].slice(), t[1].slice()] : null)) as typeof tables.tables
      ;(copy[idx] as [Label, Label])[0][0] ^= 0x01
      tables = { tables: copy, decoding: gt.decoding }
    }
  }
  const { bits } = evaluateCircuit(circuit, tables, active)
  return { bits, andTable: gt.tables.find((t) => t !== null) ?? null }
}

export function MpcPage() {
  // ── Oblivious transfer ──
  const [m0, setM0] = useState('launch the missiles')
  const [m1, setM1] = useState('stand down, all clear')
  const [choice, setChoice] = useState<0 | 1>(1)
  const [otNonce, setOtNonce] = useState(0)
  const ot = useMemo(() => {
    void otNonce
    return obliviousTransfer(utf8(m0), utf8(m1), choice)
  }, [m0, m1, choice, otNonce])

  // ── Millionaires' problem ──
  const [bits, setBits] = useState(8)
  const maxV = (1 << bits) - 1
  const [alice, setAlice] = useState(96)
  const [bob, setBob] = useState(140)
  const [mpcNonce, setMpcNonce] = useState(0)
  const a = Math.min(alice, maxV)
  const b = Math.min(bob, maxV)
  const mil = useMemo(() => {
    void mpcNonce
    return runMillionaires(a, b, bits)
  }, [a, b, bits, mpcNonce])

  // ── Other functionalities ──
  const [fn, setFn] = useState<'equal' | 'sum' | 'product'>('equal')
  const [x, setX] = useState(7)
  const [y, setY] = useState(7)
  const fnBits = fn === 'product' ? 6 : 8
  const fnMax = (1 << fnBits) - 1
  const xi = Math.min(x, fnMax)
  const yi = Math.min(y, fnMax)
  const fnResult = useMemo(() => {
    if (fn === 'equal') return runEquality(xi, yi, fnBits)
    if (fn === 'sum') return runSum(xi, yi, fnBits)
    return runProduct(xi, yi, fnBits)
  }, [fn, xi, yi, fnBits])

  // ── Sealed-bid (second-price) auction ──
  const [bidA, setBidA] = useState(150)
  const [bidB, setBidB] = useState(90)
  const auction = useMemo(() => runAuction(bidA, bidB, 8), [bidA, bidB])

  // ── GMW (secret-sharing MPC) — run on demand (a real OT per AND gate) ──
  const [gmw, setGmw] = useState<GmwResult | null>(null)
  const [gmwInputs, setGmwInputs] = useState<{ a: number; b: number; bits: number } | null>(null)
  const runGmw = () => {
    const bw = Math.min(bits, 8) // cap so an interactive click stays snappy
    setGmw(gmwCompute(millionairesCircuit(bw), toBits(a, bw), toBits(b, bw)))
    setGmwInputs({ a, b, bits: bw })
  }

  // ── Circuit anatomy + integrity ──
  const [corrupt, setCorrupt] = useState(false)
  const anatomy = useMemo(() => {
    const circuit = millionairesCircuit(bits)
    const honest = garbleAndEval(circuit, toBits(a, bits), toBits(b, bits), false)
    const tampered = garbleAndEval(circuit, toBits(a, bits), toBits(b, bits), true)
    const plain = evalPlain(circuit, toBits(a, bits), toBits(b, bits))[0]
    let and = 0
    let xor = 0
    let inv = 0
    for (const g of circuit.gates) {
      if (g.type === 'AND') and++
      else if (g.type === 'XOR') xor++
      else inv++
    }
    const tableBytes = tablesByteSize(publicTables(garbleCircuit(circuit)))
    return { and, xor, inv, tableBytes, honest, tampered, plain }
  }, [a, b, bits])

  const shown = corrupt ? anatomy.tampered.bits[0] : anatomy.honest.bits[0]

  return (
    <main className="page">
      <PageHead eyebrow="Lab 33 — computing on secrets" title="Secure Two-Party Computation">
        Two parties want to jointly compute a function of their private inputs — and learn{' '}
        <em>only</em> the output. Yao's protocol makes it real: Alice <strong>garbles</strong> a
        boolean circuit into encrypted gate tables, Bob fetches the wire labels for his own input
        bits by <strong>oblivious transfer</strong> (learning nothing else, while Alice never learns
        his bits), then evaluates the circuit on ciphertext and decodes just the result. Every piece
        below — the OT on this lab's Ed25519 group, the free-XOR/half-gate garbling, the full
        protocol — is built from scratch here. The canonical demo is Yao's own{' '}
        <em>Millionaires' Problem</em>: who is richer, without revealing how rich.
      </PageHead>

      {/* ── Oblivious Transfer ── */}
      <Panel
        title="1 · Oblivious transfer — the atom"
        sub="Chou–Orlandi 1-of-2 OT on Ed25519. The receiver picks a branch; the sender learns nothing about the choice, and the receiver can open only the chosen ciphertext."
        right={
          <button className="btn" onClick={() => setOtNonce((n) => n + 1)}>
            ↻ new randomness
          </button>
        }
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <label className="field">
            <span>sender message m₀</span>
            <input value={m0} onChange={(e) => setM0(e.target.value)} />
          </label>
          <label className="field">
            <span>sender message m₁</span>
            <input value={m1} onChange={(e) => setM1(e.target.value)} />
          </label>
        </div>
        <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
          <span className="sub">receiver's private choice bit</span>
          <span className="seg">
            <button className={choice === 0 ? 'on' : ''} onClick={() => setChoice(0)}>c = 0 · take m₀</button>
            <button className={choice === 1 ? 'on' : ''} onClick={() => setChoice(1)}>c = 1 · take m₁</button>
          </span>
        </div>
        <dl className="kv" style={{ marginTop: '0.9rem' }}>
          <dt>setup S = y·B</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{ptHex(ot.S)}</dd>
          <dt>reply R = x·B + c·S</dt>
          <dd className="hexbox violet" style={{ gridColumn: '1 / -1' }}>{ptHex(ot.R)}</dd>
          <dt>ciphertext e₀</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{ellipsize(bytesToHex(ot.e0), 20, 8)}</dd>
          <dt>ciphertext e₁</dt>
          <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{ellipsize(bytesToHex(ot.e1), 20, 8)}</dd>
          <dt>receiver decrypts</dt>
          <dd className="hexbox lavender" style={{ gridColumn: '1 / -1' }}>“{new TextDecoder().decode(ot.received)}”</dd>
        </dl>
        <div style={{ marginTop: '0.7rem' }}>
          <Verdict ok>received = m{choice} ✓</Verdict>{' '}
          <span className="note" style={{ display: 'inline' }}>
            The receiver's key is H(x·S) = H(x·y·B), which the sender can only recompute for the
            branch it can't tell the receiver took — so the other message stays sealed, and R reveals
            nothing about c.
          </span>
        </div>
      </Panel>

      {/* ── Millionaires' problem ── */}
      <Panel
        title="2 · Yao's Millionaires' Problem"
        sub="Alice and Bob run the full protocol on a comparator circuit. Neither reveals their wealth; both learn only who is richer."
        right={
          <button className="btn" onClick={() => setMpcNonce((n) => n + 1)}>
            ↻ re-garble
          </button>
        }
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label={`Alice's wealth (0–${maxV})`} value={a} min={0} max={maxV} onChange={setAlice} />
          <Slider label={`Bob's wealth (0–${maxV})`} value={b} min={0} max={maxV} onChange={setBob} />
        </div>
        <Slider label="word size" value={bits} min={2} max={12} onChange={setBits} display={`${bits}-bit`} />

        <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Verdict ok={mil.agrees}>
            {mil.aliceRicher ? 'Alice is richer' : a === b ? 'equal wealth' : 'Bob is richer'}
          </Verdict>
          <span className="note" style={{ display: 'inline' }}>
            The circuit outputs 1 iff Alice &gt; Bob, cross-checked against a plaintext comparison:{' '}
            {mil.agrees ? 'the secure computation matches.' : 'MISMATCH.'}
          </span>
        </div>

        <table className="data" style={{ marginTop: '0.9rem' }}>
          <tbody>
            <tr><td>oblivious transfers (one per Bob input bit)</td><td className="mono">{mil.transcript.numOts}</td></tr>
            <tr><td>AND gates (2 ciphertexts each)</td><td className="mono">{mil.transcript.andGates}</td></tr>
            <tr><td>XOR + NOT gates (free — 0 ciphertexts)</td><td className="mono">{mil.transcript.xorGates + mil.transcript.invGates}</td></tr>
            <tr><td>garbled table download</td><td className="mono">{mil.transcript.tableBytes} bytes</td></tr>
            <tr><td>OT setup point S</td><td className="mono">{ellipsize(mil.transcript.otBase, 12, 6)}</td></tr>
            <tr><td>decoded output bit</td><td className="mono">{mil.transcript.outputBits[0]}</td></tr>
          </tbody>
        </table>
      </Panel>

      {/* ── Circuit anatomy + integrity ── */}
      <Panel
        title="3 · Anatomy of a garbled gate"
        sub="Free-XOR makes XOR/NOT cost nothing; a half-gate AND costs exactly two 128-bit ciphertexts — the proven minimum. Corrupt one and the evaluation breaks."
      >
        <div className="grid cols-3" style={{ gap: '1rem' }}>
          <div className="stat"><span className="val">{anatomy.and}</span><span className="sub">AND gates</span></div>
          <div className="stat"><span className="val">{anatomy.xor}</span><span className="sub">XOR gates · free</span></div>
          <div className="stat"><span className="val">{anatomy.inv}</span><span className="sub">NOT gates · free</span></div>
        </div>
        {anatomy.honest.andTable && (
          <dl className="kv" style={{ marginTop: '0.9rem' }}>
            <dt>a sample AND gate · T_G</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hexLabel(anatomy.honest.andTable[0])}</dd>
            <dt>a sample AND gate · T_E</dt>
            <dd className="hexbox" style={{ gridColumn: '1 / -1' }}>{hexLabel(anatomy.honest.andTable[1])}</dd>
          </dl>
        )}
        <div style={{ marginTop: '0.8rem' }}>
          <span className="seg">
            <button className={!corrupt ? 'on' : ''} onClick={() => setCorrupt(false)}>honest tables</button>
            <button className={corrupt ? 'on' : ''} onClick={() => setCorrupt(true)}>flip 1 byte</button>
          </span>
        </div>
        <div style={{ marginTop: '0.7rem' }}>
          <Verdict ok={shown === anatomy.plain}>
            evaluated output bit = {shown} {shown === anatomy.plain ? '· correct' : '· corrupted, wrong answer'}
          </Verdict>{' '}
          <span className="note" style={{ display: 'inline' }}>
            {corrupt
              ? 'A single flipped ciphertext bit propagates a wrong wire label, so the decoded result no longer matches the true comparison.'
              : 'The honest garbling decodes to exactly the plaintext comparison.'}
          </span>
        </div>
      </Panel>

      {/* ── Other functionalities ── */}
      <Panel
        title="4 · The same protocol, other functions"
        sub="Swap the circuit, keep the protocol. Private equality, a private sum, and a private product — each revealing only its output."
      >
        <div className="seg" style={{ marginBottom: '0.8rem', flexWrap: 'wrap' }}>
          <button className={fn === 'equal' ? 'on' : ''} onClick={() => setFn('equal')}>equality · a = b?</button>
          <button className={fn === 'sum' ? 'on' : ''} onClick={() => setFn('sum')}>sum · a + b</button>
          <button className={fn === 'product' ? 'on' : ''} onClick={() => setFn('product')}>product · a · b</button>
        </div>
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label={`Alice's a (0–${fnMax})`} value={xi} min={0} max={fnMax} onChange={setX} />
          <Slider label={`Bob's b (0–${fnMax})`} value={yi} min={0} max={fnMax} onChange={setY} />
        </div>
        <div style={{ marginTop: '0.8rem' }}>
          <Verdict ok={fnResult.agrees}>
            {fn === 'equal' && ((fnResult as { equal: boolean }).equal ? 'a = b — equal' : 'a ≠ b — different')}
            {fn === 'sum' && `a + b = ${(fnResult as { sum: number }).sum}`}
            {fn === 'product' && `a · b = ${(fnResult as { product: number }).product}`}
          </Verdict>{' '}
          <span className="note" style={{ display: 'inline' }}>
            {fnResult.transcript.numOts} OTs · {fnResult.transcript.andGates} AND gates ·{' '}
            {fnResult.transcript.tableBytes} bytes garbled · matches the plaintext computation:{' '}
            {fnResult.agrees ? 'yes' : 'no'}.
          </span>
        </div>
      </Panel>

      {/* ── Sealed-bid auction ── */}
      <Panel
        title="5 · A sealed-bid second-price auction"
        sub="Two bidders learn who won and the price they pay — the lower of the two bids — without either revealing their bid. Vickrey's incentive-compatible auction, run as a garbled circuit."
      >
        <div className="grid cols-2" style={{ gap: '1rem' }}>
          <Slider label="Alice's bid (0–255)" value={bidA} min={0} max={255} onChange={setBidA} />
          <Slider label="Bob's bid (0–255)" value={bidB} min={0} max={255} onChange={setBidB} />
        </div>
        <div style={{ marginTop: '0.8rem', display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <Verdict ok={auction.agrees}>
            {bidA === bidB ? 'tie — no strict winner' : auction.aliceWins ? 'Alice wins' : 'Bob wins'} · price {auction.price}
          </Verdict>
          <span className="note" style={{ display: 'inline' }}>
            The winner pays the <em>second-highest</em> bid ({auction.price}), computed as min(a, b) via a
            garbled comparator + multiplexer. Neither the winning bid nor the loser's exact number leaks
            beyond the price — {auction.transcript.andGates} AND gates, {auction.transcript.tableBytes} bytes garbled.
          </span>
        </div>
      </Panel>

      {/* ── GMW: the other MPC paradigm ── */}
      <Panel
        title="6 · GMW — the other paradigm (secret sharing)"
        sub="Garbled circuits aren't the only way. GMW keeps every wire XOR-shared between the parties and works gate by gate: XOR and NOT are local, and each AND gate is resolved by a single 1-of-4 oblivious transfer. Same circuit, different mechanism — the answers must match."
        right={
          <button className="btn" onClick={runGmw}>
            ▶ run GMW on the bids above
          </button>
        }
      >
        {!gmw && (
          <p className="note">
            Runs the same Millionaires' comparator on Alice's and Bob's wealth from panel 2, but under
            GMW instead of garbled circuits. It performs a real public-key oblivious transfer per AND
            gate, so it's a click rather than a live slider.
          </p>
        )}
        {gmw && gmwInputs && (
          <>
            <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <Verdict ok={gmw.agrees}>
                {gmw.outputBits[0] === 1 ? 'Alice is richer' : gmwInputs.a === gmwInputs.b ? 'equal wealth' : 'Bob is richer'}
              </Verdict>
              <span className="note" style={{ display: 'inline' }}>
                Reconstructed from the two parties' XOR shares (sᴬ ⊕ sᴮ) — the {gmwInputs.bits}-bit
                comparison agrees with both the garbled-circuit run and the plaintext:{' '}
                {gmw.agrees ? 'yes' : 'no'}.
              </span>
            </div>
            <table className="data" style={{ marginTop: '0.9rem' }}>
              <tbody>
                <tr><td>AND gates → 1-of-4 oblivious transfers</td><td className="mono">{gmw.transcript.andGates}</td></tr>
                <tr><td>XOR + NOT gates (local, no interaction)</td><td className="mono">{gmw.transcript.xorGates + gmw.transcript.invGates}</td></tr>
                <tr><td>oblivious-transfer rounds run</td><td className="mono">{gmw.transcript.otInstances}</td></tr>
              </tbody>
            </table>
            <p className="note" style={{ marginTop: '0.7rem' }}>
              GMW's cost is interaction — one OT round per AND gate, versus garbled circuits' single
              round of large tables. The trade-off between the two is the heart of practical MPC.
            </p>
          </>
        )}
      </Panel>

      <Panel title="What the transcript proves" sub="A quick audit of the guarantees, straight from the run above.">
        <ul className="note" style={{ lineHeight: 1.7 }}>
          <li>
            <strong>Input privacy (Bob):</strong> Bob's bits enter only through OT, so Alice's view is
            his OT replies R — points that hide the choice c.
          </li>
          <li>
            <strong>Input privacy (Alice):</strong> Alice sends wire labels and encrypted tables;
            without the global offset Δ a label is an opaque 128-bit string, so Bob learns no
            intermediate value — only the decoded outputs.
          </li>
          <li>
            <strong>Correctness:</strong> the decoded output equals the plaintext function on every
            input pair (verified exhaustively in the Self-Test).
          </li>
          <li>
            <strong>Cost:</strong> only AND gates cost communication (2·{LABEL_BYTES} bytes each);
            XOR and NOT are free — the reason circuits are minimized for AND count.
          </li>
          <li>
            <strong>Two paradigms, one answer:</strong> the GMW panel computes the same comparator by
            secret-sharing instead of garbling — one OT round per AND gate rather than one big table —
            and reconstructs the identical result, the practical trade-off at the heart of MPC.
          </li>
        </ul>
      </Panel>
    </main>
  )
}
