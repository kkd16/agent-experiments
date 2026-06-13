const KEYS = new Set([
  "twopointers", "slidingwindow", "binarysearch", "hashmap", "stack",
  "linkedlist", "heap", "treetraversal", "graph", "trie", "dp1d", "dp2d",
  "backtracking", "intervals", "greedy", "bitxor", "rotate", "dijkstra",
]);

export function hasVisualizer(key?: string): boolean {
  return !!key && KEYS.has(key);
}
