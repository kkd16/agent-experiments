// Paged sparse memory for the full 32-bit address space.
//
// A flat 4 GiB buffer is obviously impossible, so memory is materialised one 4 KiB page
// at a time inside a Map. Unwritten pages read as zero. All accesses are little-endian,
// matching the RISC-V data convention.

import { u32 } from './format';

const PAGE_BITS = 12;
const PAGE_SIZE = 1 << PAGE_BITS; // 4096
const PAGE_MASK = PAGE_SIZE - 1;

export class MemoryError extends Error {
  readonly address: number;
  constructor(message: string, address: number) {
    super(message);
    this.name = 'MemoryError';
    this.address = u32(address);
  }
}

export class Memory {
  private pages = new Map<number, Uint8Array>();

  /** Drop every page, returning to all-zero memory. */
  reset(): void {
    this.pages.clear();
  }

  private pageFor(addr: number, create: boolean): Uint8Array | null {
    const pageNo = (addr >>> PAGE_BITS) >>> 0;
    let page = this.pages.get(pageNo);
    if (!page && create) {
      page = new Uint8Array(PAGE_SIZE);
      this.pages.set(pageNo, page);
    }
    return page ?? null;
  }

  readByte(addr: number): number {
    const page = this.pageFor(addr, false);
    if (!page) return 0;
    return page[addr & PAGE_MASK];
  }

  writeByte(addr: number, value: number): void {
    const page = this.pageFor(addr, true)!;
    page[addr & PAGE_MASK] = value & 0xff;
  }

  /** Little-endian unsigned half-word. May span two pages. */
  readHalf(addr: number): number {
    return (this.readByte(addr) | (this.readByte(addr + 1) << 8)) >>> 0;
  }

  writeHalf(addr: number, value: number): void {
    this.writeByte(addr, value & 0xff);
    this.writeByte(addr + 1, (value >>> 8) & 0xff);
  }

  /** Little-endian unsigned word. May span two pages. */
  readWord(addr: number): number {
    return (
      (this.readByte(addr) |
        (this.readByte(addr + 1) << 8) |
        (this.readByte(addr + 2) << 16) |
        (this.readByte(addr + 3) << 24)) >>>
      0
    );
  }

  writeWord(addr: number, value: number): void {
    this.writeByte(addr, value & 0xff);
    this.writeByte(addr + 1, (value >>> 8) & 0xff);
    this.writeByte(addr + 2, (value >>> 16) & 0xff);
    this.writeByte(addr + 3, (value >>> 24) & 0xff);
  }

  /** Read a NUL-terminated string starting at `addr` (used by the print-string syscall). */
  readCString(addr: number, max = 4096): string {
    const bytes: number[] = [];
    for (let i = 0; i < max; i++) {
      const b = this.readByte(addr + i);
      if (b === 0) break;
      bytes.push(b);
    }
    return String.fromCharCode(...bytes);
  }

  /** Copy a byte range out into a flat array (used by the framebuffer + memory view). */
  readRange(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.readByte(addr + i);
    return out;
  }

  /** Sorted list of touched page base addresses — drives the memory inspector. */
  touchedPages(): number[] {
    return [...this.pages.keys()].map((p) => (p << PAGE_BITS) >>> 0).sort((a, b) => a - b);
  }
}
