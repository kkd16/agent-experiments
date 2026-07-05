// External-interrupt hardware: a PLIC (Platform-Level Interrupt Controller) and a memory-mapped
// UART. Together they complete the RISC-V interrupt story — the CLINT (in cpu.ts) handles the
// core-local software and timer interrupts, while the PLIC routes *external* device interrupts
// (here, the UART's receive line) to the hart's MEIP/SEIP pending bits.
//
// This module owns only the pure device *state* + register decode/encode + the gateway logic.
// The CPU (cpu.ts) owns the MMIO dispatch and the mip.MEIP/SEIP wiring, exactly as it already
// does for the CLINT. Keeping the state here — with `snapshot`/`restore` — lets the CPU's
// time-travel journal revert device state alongside registers and memory.

import {
  PLIC_BASE,
  PLIC_SIZE,
  PLIC_NUM_SOURCES,
  PLIC_NUM_CONTEXTS,
  PLIC_PENDING_OFF,
  PLIC_ENABLE_OFF,
  PLIC_ENABLE_STRIDE,
  PLIC_CONTEXT_OFF,
  PLIC_CONTEXT_STRIDE,
  PLIC_PRIO_BITS,
  PLIC_PRIO_MAX,
  UART0_BASE,
  UART_SIZE,
  UART_IRQ,
  UART_RBR,
  UART_IER,
  UART_LSR,
  UART_IER_RX,
  UART_LSR_DR,
  UART_LSR_THRE,
  UART_LSR_TEMT,
  UART_RX_START,
  UART_RX_INTERVAL,
} from './constants';

/** The complete, compact device state for one instruction's undo record (all primitives). */
export interface DevSnap {
  claimed: number; // bitmask of sources currently in-service (claimed, not yet completed)
  prio: number; // packed source priorities: PLIC_PRIO_BITS per source, source i at bit i*bits
  enable0: number;
  enable1: number;
  thr0: number;
  thr1: number;
  ier: number; // UART interrupt-enable register
  rxPos: number; // received bytes the guest has consumed (via RBR reads)
  rxAvail: number; // received bytes that have "arrived" into the RX FIFO
  rxNext: number; // cycle at which the next byte arrives
}

/** The result of a UART register write: whether it landed, and any byte to transmit. */
export interface UartWrite {
  handled: boolean;
  tx?: number;
}

/** Every source id the enable mask may address (bits 1..N; bit 0 is the reserved source). */
const SOURCE_MASK = (((1 << (PLIC_NUM_SOURCES + 1)) - 1) & ~1) >>> 0;

export class Device {
  // --- PLIC state -----------------------------------------------------------
  /** Per-source priority (index by source id; [0] is the reserved source and stays 0). */
  readonly priority = new Uint8Array(PLIC_NUM_SOURCES + 1);
  /** Sources currently in service — claimed by a context but not yet completed. */
  claimed = 0;
  /** Per-context interrupt-enable bitmap (index 0 = M-mode context, 1 = S-mode context). */
  readonly enable = new Int32Array(PLIC_NUM_CONTEXTS);
  /** Per-context priority threshold — a source is only forwarded if its priority exceeds it. */
  readonly threshold = new Int32Array(PLIC_NUM_CONTEXTS);

  // --- UART state -----------------------------------------------------------
  /** The full received byte stream (host-provided; NOT part of the per-step undo record). */
  private rxSource: number[] = [];
  rxPos = 0;
  rxAvail = 0;
  rxNext = UART_RX_START;
  /** UART interrupt-enable register (bit 0 = receive-data-available). */
  ier = 0;

  /** Reset the mutable device state (keeps the configured receive stream). */
  reset(): void {
    this.priority.fill(0);
    this.claimed = 0;
    this.enable.fill(0);
    this.threshold.fill(0);
    this.rxPos = 0;
    this.rxAvail = 0;
    this.rxNext = UART_RX_START;
    this.ier = 0;
  }

  /** Seed the receive stream from a string and rewind the arrival schedule. */
  setInputText(text: string): void {
    const bytes: number[] = [];
    for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
    this.rxSource = bytes;
    this.rxPos = 0;
    this.rxAvail = 0;
    this.rxNext = UART_RX_START;
  }

  /** How many received bytes are still waiting to arrive or be read (for the inspector). */
  rxRemaining(): number {
    return this.rxSource.length - this.rxPos;
  }
  rxTotal(): number {
    return this.rxSource.length;
  }

  // --- the UART receive gateway ---------------------------------------------

  /** Meter the receive stream into the RX FIFO from the free-running cycle count. */
  tick(cycles: number): void {
    while (this.rxAvail < this.rxSource.length && cycles >= this.rxNext) {
      this.rxAvail++;
      this.rxNext += UART_RX_INTERVAL;
    }
  }

  /** True while the UART is asserting its receive interrupt line (RX data ready + RX-IE). */
  private uartLine(): boolean {
    return (this.ier & UART_IER_RX) !== 0 && this.rxAvail > this.rxPos;
  }

  // --- the PLIC gateway ------------------------------------------------------

  /**
   * The gateway pending bitmap: a source is pending while its device line asserts and it is not
   * currently in service. Level-triggered, so completing a source whose line is still high
   * re-raises it (the classic driver re-arm).
   */
  pending(): number {
    let lines = 0;
    if (this.uartLine()) lines |= 1 << UART_IRQ;
    return (lines & ~this.claimed) >>> 0;
  }

  /** Does context `ctx` have a pending, enabled source whose priority beats its threshold? */
  contextPending(ctx: number): boolean {
    const p = this.pending() & this.enable[ctx];
    for (let id = 1; id <= PLIC_NUM_SOURCES; id++) {
      if (((p >>> id) & 1) !== 0 && this.priority[id] > this.threshold[ctx]) return true;
    }
    return false;
  }

  /**
   * Claim the highest-priority pending + enabled source for a context (0 if none), and put it in
   * service so it stops asserting until the handler completes it. Ties break toward the lower id.
   */
  claim(ctx: number): number {
    const p = this.pending() & this.enable[ctx];
    let best = 0;
    let bestPrio = 0;
    for (let id = 1; id <= PLIC_NUM_SOURCES; id++) {
      if (((p >>> id) & 1) === 0) continue;
      const pr = this.priority[id];
      if (pr > this.threshold[ctx] && pr > bestPrio) {
        best = id;
        bestPrio = pr;
      }
    }
    if (best !== 0) this.claimed |= 1 << best;
    return best;
  }

  /** Complete an in-service source (it may re-assert immediately if its line is still high). */
  complete(id: number): void {
    if (id >= 1 && id <= PLIC_NUM_SOURCES) this.claimed &= ~(1 << id);
  }

  // --- MMIO decode: PLIC -----------------------------------------------------

  /**
   * Read a PLIC register (word). Reading a context's claim/complete register **claims** — a real,
   * spec-defined read side-effect. Returns null when `addr` is outside the PLIC window.
   */
  plicRead(addr: number): number | null {
    if (addr < PLIC_BASE || addr >= PLIC_BASE + PLIC_SIZE) return null;
    const off = (addr - PLIC_BASE) >>> 0;
    if (off < 0x1000) {
      const id = off >>> 2; // priority[id] lives at 4*id
      return id >= 1 && id <= PLIC_NUM_SOURCES ? this.priority[id] : 0;
    }
    if (off === PLIC_PENDING_OFF) return this.pending();
    for (let c = 0; c < PLIC_NUM_CONTEXTS; c++) {
      if (off === PLIC_ENABLE_OFF + c * PLIC_ENABLE_STRIDE) return this.enable[c] >>> 0;
      const base = PLIC_CONTEXT_OFF + c * PLIC_CONTEXT_STRIDE;
      if (off === base) return this.threshold[c] >>> 0;
      if (off === base + 4) return this.claim(c); // claim-on-read
    }
    return 0;
  }

  /** Write a PLIC register (word). Returns true when `addr` is inside the PLIC window. */
  plicWrite(addr: number, value: number): boolean {
    if (addr < PLIC_BASE || addr >= PLIC_BASE + PLIC_SIZE) return false;
    const off = (addr - PLIC_BASE) >>> 0;
    const v = value >>> 0;
    if (off < 0x1000) {
      const id = off >>> 2;
      if (id >= 1 && id <= PLIC_NUM_SOURCES) this.priority[id] = v & PLIC_PRIO_MAX;
      return true;
    }
    if (off === PLIC_PENDING_OFF) return true; // pending is read-only (gateway-driven)
    for (let c = 0; c < PLIC_NUM_CONTEXTS; c++) {
      if (off === PLIC_ENABLE_OFF + c * PLIC_ENABLE_STRIDE) {
        this.enable[c] = v & SOURCE_MASK;
        return true;
      }
      const base = PLIC_CONTEXT_OFF + c * PLIC_CONTEXT_STRIDE;
      if (off === base) {
        this.threshold[c] = v & PLIC_PRIO_MAX;
        return true;
      }
      if (off === base + 4) {
        this.complete(v); // completing an interrupt
        return true;
      }
    }
    return true;
  }

  // --- MMIO decode: UART -----------------------------------------------------

  /** Read a UART register (word), or null if `addr` is outside the UART window. */
  uartRead(addr: number): number | null {
    if (addr < UART0_BASE || addr >= UART0_BASE + UART_SIZE) return null;
    switch (addr - UART0_BASE) {
      case UART_RBR:
        // Read + pop the next received byte (0 when the FIFO is empty).
        if (this.rxAvail > this.rxPos) return this.rxSource[this.rxPos++] & 0xff;
        return 0;
      case UART_IER:
        return this.ier & 0xff;
      case UART_LSR: {
        let s = UART_LSR_THRE | UART_LSR_TEMT; // the transmitter is always ready here
        if (this.rxAvail > this.rxPos) s |= UART_LSR_DR;
        return s;
      }
      default:
        return 0;
    }
  }

  /** Write a UART register (word). A THR write returns the byte to transmit to the console. */
  uartWrite(addr: number, value: number): UartWrite {
    if (addr < UART0_BASE || addr >= UART0_BASE + UART_SIZE) return { handled: false };
    switch (addr - UART0_BASE) {
      case UART_RBR: // THR on write — transmit the low byte
        return { handled: true, tx: value & 0xff };
      case UART_IER:
        this.ier = value & 0xff;
        return { handled: true };
      default:
        return { handled: true };
    }
  }

  // --- time-travel: compact snapshot / restore ------------------------------

  snapshot(): DevSnap {
    let prio = 0;
    for (let id = 1; id <= PLIC_NUM_SOURCES; id++) {
      prio |= (this.priority[id] & PLIC_PRIO_MAX) << (PLIC_PRIO_BITS * (id - 1));
    }
    return {
      claimed: this.claimed,
      prio,
      enable0: this.enable[0],
      enable1: this.enable[1],
      thr0: this.threshold[0],
      thr1: this.threshold[1],
      ier: this.ier,
      rxPos: this.rxPos,
      rxAvail: this.rxAvail,
      rxNext: this.rxNext,
    };
  }

  restore(s: DevSnap): void {
    this.claimed = s.claimed;
    for (let id = 1; id <= PLIC_NUM_SOURCES; id++) {
      this.priority[id] = (s.prio >>> (PLIC_PRIO_BITS * (id - 1))) & PLIC_PRIO_MAX;
    }
    this.enable[0] = s.enable0;
    this.enable[1] = s.enable1;
    this.threshold[0] = s.thr0;
    this.threshold[1] = s.thr1;
    this.ier = s.ier;
    this.rxPos = s.rxPos;
    this.rxAvail = s.rxAvail;
    this.rxNext = s.rxNext;
  }
}
