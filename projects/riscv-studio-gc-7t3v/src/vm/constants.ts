// Memory map and machine-wide constants for the RV32 virtual machine.
//
// The address space is a full 32-bit flat space, materialised lazily through a paged
// memory (see memory.ts). The layout below mirrors a conventional bare-metal RISC-V
// program: code low, data above it, a downward-growing stack near the top of the
// usable space, and a memory-mapped framebuffer in a dedicated MMIO window.

export const XLEN = 32;
export const WORD = 4;

/** Where assembled `.text` is linked. */
export const TEXT_BASE = 0x0000_0000;
/** Where assembled `.data` is linked. */
export const DATA_BASE = 0x1001_0000;
/** Initial stack pointer (x2). The stack grows downward from here. */
export const STACK_TOP = 0x7fff_fff0;
/** Initial global pointer (x3). */
export const GLOBAL_POINTER = DATA_BASE;

/**
 * CLINT — the core-local interruptor. A small MMIO window holding the 64-bit machine timer
 * (`mtime`, free-running = retired cycles) and its compare register (`mtimecmp`). When
 * `mtime ≥ mtimecmp` the machine timer interrupt pending bit (`mip.MTIP`) is raised; writing a
 * larger `mtimecmp` clears it. The layout matches the SiFive CLINT so bare-metal code ports.
 */
export const CLINT_BASE = 0x0200_0000;
export const CLINT_SIZE = 0x0001_0000;
/**
 * `msip` for hart 0 — the machine **software** interrupt pending bit, memory-mapped. Writing
 * bit 0 raises (or, with 0, clears) `mip.MSIP`; this is how a hart sends itself (or, on real
 * SMP, another hart) an inter-processor interrupt. Matches the SiFive CLINT layout.
 */
export const MSIP_BASE = CLINT_BASE + 0x0000;
export const MTIMECMP_LO = CLINT_BASE + 0x4000;
export const MTIMECMP_HI = CLINT_BASE + 0x4004;
export const MTIME_LO = CLINT_BASE + 0xbff8;
export const MTIME_HI = CLINT_BASE + 0xbffc;

/**
 * PLIC — the Platform-Level Interrupt Controller: the standard RISC-V router for *external*
 * (off-core) device interrupts, complementing the CLINT's core-local software/timer interrupts.
 * It gates each source through a priority + per-context enable + threshold, and hands the winning
 * source to software via a claim/complete register. Two contexts are modelled: context 0 = hart 0
 * M-mode (drives `mip.MEIP`) and context 1 = hart 0 S-mode (drives `mip.SEIP`). The register
 * layout matches the SiFive/QEMU `virt` PLIC so bare-metal drivers port unchanged.
 */
export const PLIC_BASE = 0x0c00_0000;
export const PLIC_SIZE = 0x0040_0000;
/** Interrupt source ids 1..N (id 0 is the reserved "no interrupt"). */
export const PLIC_NUM_SOURCES = 8;
/** Contexts wired to this hart: 0 → M-mode external, 1 → S-mode external. */
export const PLIC_NUM_CONTEXTS = 2;
export const PLIC_PENDING_OFF = 0x1000; // pending bitmap (one word for ≤ 32 sources)
export const PLIC_ENABLE_OFF = 0x2000; // enable bitmap, per context
export const PLIC_ENABLE_STRIDE = 0x80;
export const PLIC_CONTEXT_OFF = 0x20_0000; // threshold (+0) & claim/complete (+4), per context
export const PLIC_CONTEXT_STRIDE = 0x1000;
/** Priorities are capped at this width (plenty for teaching; keeps the undo snapshot compact). */
export const PLIC_PRIO_BITS = 3;
export const PLIC_PRIO_MAX = (1 << PLIC_PRIO_BITS) - 1;

/**
 * UART — a memory-mapped NS16550-subset serial port. Reading `RBR` pops the next received byte;
 * writing `THR` transmits a byte to the syscall console. Its receive-data-available line is wired
 * to PLIC source `UART_IRQ`. Received input is a host-provided byte stream metered into the RX
 * FIFO on a fixed cycle cadence, so execution stays fully deterministic (and time-travellable).
 */
export const UART0_BASE = 0x1000_0000;
export const UART_SIZE = 0x100;
export const UART_IRQ = 1; // PLIC source id for the UART receive line
export const UART_RBR = 0x00; // read: RX data (+ pop);  write: TX (THR)
export const UART_IER = 0x04; // interrupt enable (bit 0 = receive-data-available)
export const UART_LSR = 0x08; // line status (read-only)
export const UART_IER_RX = 0x1; // IER: receive-data-available interrupt enable
export const UART_LSR_DR = 0x01; // LSR: receive data ready
export const UART_LSR_THRE = 0x20; // LSR: transmit-hold register empty (always, here)
export const UART_LSR_TEMT = 0x40; // LSR: transmitter empty (always, here)
export const UART_RX_START = 4; // cycle at which the first received byte arrives
export const UART_RX_INTERVAL = 6; // cycles between subsequent received bytes
/** The receive stream a fresh machine starts with, so the UART echo example runs out of the box. */
export const DEFAULT_UART_INPUT = 'RISC-V!\n';

/** Memory-mapped framebuffer: FB_W × FB_H bytes, one palette index per pixel. */
export const FB_BASE = 0x2000_0000;
export const FB_W = 128;
export const FB_H = 128;
export const FB_BYTES = FB_W * FB_H;
export const FB_END = FB_BASE + FB_BYTES;

/** A 16-entry palette (classic VGA-ish), indexed by the byte written to the framebuffer. */
export const PALETTE: readonly string[] = [
  '#000000', // 0  black
  '#1d2b53', // 1  dark blue
  '#7e2553', // 2  dark purple
  '#008751', // 3  dark green
  '#ab5236', // 4  brown
  '#5f574f', // 5  dark grey
  '#c2c3c7', // 6  light grey
  '#fff1e8', // 7  white
  '#ff004d', // 8  red
  '#ffa300', // 9  orange
  '#ffec27', // 10 yellow
  '#00e436', // 11 green
  '#29adff', // 12 blue
  '#83769c', // 13 lavender
  '#ff77a8', // 14 pink
  '#ffccaa', // 15 peach
];

/** Default instruction budget for a single "run" so runaway loops cannot hang the tab. */
export const DEFAULT_MAX_STEPS = 50_000_000;

/** Instructions executed per animation frame while running, to keep the UI responsive. */
export const STEPS_PER_FRAME = 250_000;
