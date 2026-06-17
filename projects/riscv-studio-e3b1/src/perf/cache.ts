// A set-associative cache simulator (used twice: an instruction cache on fetch addresses and a
// data cache on load/store addresses). It models only what the timing layer needs — whether an
// access hits or misses — plus the bookkeeping (hits, misses, writebacks) a teaching view wants
// to show. It is policy-configurable: associativity, block size, LRU/FIFO replacement, and
// write-back/allocate vs write-through/no-allocate.

export type ReplacePolicy = 'lru' | 'fifo';

export interface CacheConfig {
  /** Total data capacity in bytes (power of two). */
  sizeBytes: number;
  /** Bytes per cache line / block (power of two). */
  blockBytes: number;
  /** Associativity (ways per set; 1 = direct-mapped). */
  ways: number;
  replace: ReplacePolicy;
  /** Write-back + write-allocate when true; write-through + no-write-allocate when false. */
  writeBack: boolean;
}

export interface CacheStats {
  reads: number;
  writes: number;
  readMisses: number;
  writeMisses: number;
  writebacks: number;
  get accesses(): number;
  get misses(): number;
}

interface Line {
  valid: boolean;
  tag: number;
  dirty: boolean;
  /** Last-use timestamp (LRU) or fill timestamp (FIFO). */
  stamp: number;
}

export class Cache {
  private readonly sets: number;
  private readonly blockBits: number;
  private readonly setMask: number;
  private readonly lines: Line[]; // sets * ways, row-major by set
  private clock = 0;

  reads = 0;
  writes = 0;
  readMisses = 0;
  writeMisses = 0;
  writebacks = 0;
  readonly config: CacheConfig;

  constructor(config: CacheConfig) {
    this.config = config;
    const block = nextPow2(config.blockBytes);
    const ways = Math.max(1, config.ways);
    let sets = Math.max(1, Math.floor(config.sizeBytes / (block * ways)));
    sets = nextPow2(sets);
    this.sets = sets;
    this.blockBits = Math.log2(block);
    this.setMask = sets - 1;
    this.lines = [];
    for (let i = 0; i < sets * ways; i++) {
      this.lines.push({ valid: false, tag: 0, dirty: false, stamp: 0 });
    }
  }

  private get ways(): number {
    return Math.max(1, this.config.ways);
  }

  private setIndex(addr: number): number {
    return (addr >>> this.blockBits) & this.setMask;
  }
  private tagOf(addr: number): number {
    // Block number above the set bits; kept as an unsigned-ish integer (addresses are 32-bit).
    return Math.floor((addr >>> 0) / (1 << this.blockBits) / this.sets);
  }

  /** Model one access. Returns true on a hit, false on a miss. */
  access(addr: number, isWrite: boolean): boolean {
    if (isWrite) this.writes++;
    else this.reads++;

    const set = this.setIndex(addr);
    const tag = this.tagOf(addr);
    const base = set * this.ways;
    this.clock++;

    // Probe the set.
    for (let w = 0; w < this.ways; w++) {
      const line = this.lines[base + w];
      if (line.valid && line.tag === tag) {
        if (this.config.replace === 'lru') line.stamp = this.clock; // touch on use
        if (isWrite) {
          if (this.config.writeBack) line.dirty = true;
          // write-through: the store also writes memory; no dirty state, no eviction cost here.
        }
        return true;
      }
    }

    // Miss.
    if (isWrite) this.writeMisses++;
    else this.readMisses++;

    // Write-through + no-write-allocate: a write miss does not bring the block in.
    if (isWrite && !this.config.writeBack) return false;

    // Allocate: choose a victim (an invalid way, else by policy) and fill.
    let victim = base;
    let best = Infinity;
    let foundInvalid = false;
    for (let w = 0; w < this.ways; w++) {
      const line = this.lines[base + w];
      if (!line.valid) {
        victim = base + w;
        foundInvalid = true;
        break;
      }
      // LRU and FIFO both evict the smallest stamp (oldest use / oldest fill).
      if (line.stamp < best) {
        best = line.stamp;
        victim = base + w;
      }
    }
    const v = this.lines[victim];
    if (!foundInvalid && v.valid && v.dirty) this.writebacks++;
    v.valid = true;
    v.tag = tag;
    v.dirty = isWrite && this.config.writeBack;
    v.stamp = this.clock; // fill time (FIFO) / last use (LRU)
    return false;
  }

  get accesses(): number {
    return this.reads + this.writes;
  }
  get misses(): number {
    return this.readMisses + this.writeMisses;
  }
  get missRate(): number {
    return this.accesses === 0 ? 0 : this.misses / this.accesses;
  }
}

function nextPow2(n: number): number {
  if (n <= 1) return 1;
  return 1 << Math.ceil(Math.log2(n));
}
