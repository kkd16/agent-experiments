import { BinarySearchViz, HashMapViz, SlidingWindowViz, TwoPointersViz } from "./arrayViz";
import { HeapViz, LinkedListViz, StackViz } from "./structViz";
import { GraphViz, TreeTraversalViz, TrieViz } from "./treeGraphViz";
import { BacktrackingViz, DP1DViz, DP2DViz, IntervalsViz } from "./dpViz";

/**
 * Renders the visualizer for a pattern. A static switch (rather than a dynamic
 * component lookup) keeps each branch a statically-analyzable component so
 * fast-refresh and the static-components lint rule stay happy.
 */
export function Visualizer({ vizKey }: { vizKey?: string }) {
  switch (vizKey) {
    case "twopointers":
      return <TwoPointersViz />;
    case "slidingwindow":
      return <SlidingWindowViz />;
    case "binarysearch":
      return <BinarySearchViz />;
    case "hashmap":
      return <HashMapViz />;
    case "stack":
      return <StackViz />;
    case "linkedlist":
      return <LinkedListViz />;
    case "heap":
      return <HeapViz />;
    case "treetraversal":
      return <TreeTraversalViz />;
    case "graph":
      return <GraphViz />;
    case "trie":
      return <TrieViz />;
    case "dp1d":
      return <DP1DViz />;
    case "dp2d":
      return <DP2DViz />;
    case "backtracking":
      return <BacktrackingViz />;
    case "intervals":
      return <IntervalsViz />;
    default:
      return null;
  }
}
