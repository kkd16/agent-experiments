// The network model: latency, jitter, random drops and partitions.
//
// Connectivity is stored as a set of *blocked* undirected links so partitions
// and single-link cuts compose naturally. Latency for each delivery is drawn
// from the simulation RNG, so two nodes never have a fixed in-order channel —
// reordering is possible and the protocols must cope, exactly as in reality.
import type { NodeId } from './types';
import type { Rng } from './prng';

export interface NetworkConfig {
  /** Minimum one-way latency (ms). */
  minLatency: number;
  /** Maximum one-way latency (ms); the actual delay is uniform in [min, max]. */
  maxLatency: number;
  /** Probability in [0,1] that any given message is silently dropped. */
  dropRate: number;
}

export const DEFAULT_NETWORK: NetworkConfig = {
  minLatency: 20,
  maxLatency: 60,
  dropRate: 0,
};

/** Canonical key for an undirected link between two nodes. */
export function linkKey(a: NodeId, b: NodeId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class Network {
  config: NetworkConfig;
  /** Undirected links that are currently cut. */
  blocked: Set<string>;

  constructor(config: NetworkConfig = DEFAULT_NETWORK, blocked: Iterable<string> = []) {
    this.config = { ...config };
    this.blocked = new Set(blocked);
  }

  connected(a: NodeId, b: NodeId): boolean {
    return !this.blocked.has(linkKey(a, b));
  }

  cut(a: NodeId, b: NodeId): void {
    this.blocked.add(linkKey(a, b));
  }

  heal(a: NodeId, b: NodeId): void {
    this.blocked.delete(linkKey(a, b));
  }

  toggle(a: NodeId, b: NodeId): void {
    const k = linkKey(a, b);
    if (this.blocked.has(k)) this.blocked.delete(k);
    else this.blocked.add(k);
  }

  healAll(): void {
    this.blocked.clear();
  }

  /** Cut every link that crosses between two groups (a clean network partition). */
  partition(groups: NodeId[][]): void {
    this.blocked.clear();
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        for (const a of groups[i]) for (const b of groups[j]) this.cut(a, b);
      }
    }
  }

  /** One-way delay for a delivery, or null if the message is lost. */
  latency(a: NodeId, b: NodeId, rng: Rng): number | null {
    if (!this.connected(a, b)) return null;
    if (this.config.dropRate > 0 && rng.chance(this.config.dropRate)) return null;
    const { minLatency, maxLatency } = this.config;
    return Math.round(rng.float(minLatency, Math.max(minLatency, maxLatency)));
  }
}
