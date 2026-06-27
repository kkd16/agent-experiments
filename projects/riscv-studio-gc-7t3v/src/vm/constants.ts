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
