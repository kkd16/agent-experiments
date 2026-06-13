export interface QuizQuestion {
  id: number;
  prompt: string;
  /** id of the correct pattern (matches patterns[].id) */
  answer: string;
  /** why this pattern — the teaching moment */
  why: string;
}

/**
 * Pattern-recognition trainer. The skill that actually transfers to interviews
 * is reading a problem and *naming the pattern* before writing any code.
 */
export const quiz: QuizQuestion[] = [
  {
    id: 1,
    prompt:
      "Given a sorted array, find two numbers that add up to a target. Return their indices.",
    answer: "two-pointers",
    why: "The array is sorted, so a converging pair of pointers can decide which way to move based on whether the sum is too big or too small — O(n), no nested loop.",
  },
  {
    id: 2,
    prompt:
      "Find the length of the longest substring without repeating characters.",
    answer: "sliding-window",
    why: "The answer is a contiguous range whose validity (no repeats) you can maintain incrementally as you grow the right edge and shrink the left.",
  },
  {
    id: 3,
    prompt:
      "Given an unsorted array, return the indices of two numbers that sum to a target.",
    answer: "arrays-hashing",
    why: "Unsorted + need O(1) 'have I seen the complement?' lookups → a hash map storing value→index in a single pass.",
  },
  {
    id: 4,
    prompt: "Determine if a string of brackets ()[]{} is validly matched and nested.",
    answer: "stack",
    why: "Nesting is last-in-first-out: the most recent opening bracket must be the first to close — a textbook stack.",
  },
  {
    id: 5,
    prompt:
      "You can buy/sell a stock once; find the maximum profit given daily prices.",
    answer: "sliding-window",
    why: "Track the minimum price seen so far (the window's left) and the best profit against today's price — a one-pass running window.",
  },
  {
    id: 6,
    prompt:
      "Find the minimum eating speed so a monkey finishes all banana piles within H hours.",
    answer: "binary-search",
    why: "Speed has a monotonic property (faster always finishes in ≤ time), so binary-search the answer space, not the input.",
  },
  {
    id: 7,
    prompt: "Return the k most frequent elements in an array.",
    answer: "heap-priority-queue",
    why: "You need the top-k by frequency without fully sorting — a size-k heap (or bucket sort) does it efficiently.",
  },
  {
    id: 8,
    prompt: "Generate every possible subset of a set of distinct integers.",
    answer: "backtracking",
    why: "The output is a set of arrangements built by include/exclude choices — choose, explore, un-choose.",
  },
  {
    id: 9,
    prompt:
      "Count the number of islands (connected groups of land) in a grid of land/water.",
    answer: "graphs",
    why: "A grid is a graph; each island is a connected component found by flood-fill DFS/BFS with a visited set.",
  },
  {
    id: 10,
    prompt:
      "Find the shortest time for all oranges in a grid to rot, spreading to 4-neighbors each minute.",
    answer: "graphs",
    why: "Shortest spread time in equal steps → multi-source BFS expanding in rings from all rotten oranges at once.",
  },
  {
    id: 11,
    prompt:
      "Given courses with prerequisites, return an order to take them all (or detect it's impossible).",
    answer: "advanced-graphs",
    why: "Dependencies that must precede others → topological sort; a cycle means no valid ordering.",
  },
  {
    id: 12,
    prompt: "How many distinct ways can you climb n stairs taking 1 or 2 steps at a time?",
    answer: "dp-1d",
    why: "ways(n) = ways(n-1) + ways(n-2): overlapping subproblems along one dimension — classic 1-D DP.",
  },
  {
    id: 13,
    prompt: "Find the length of the longest common subsequence of two strings.",
    answer: "dp-2d",
    why: "State needs two indices (position in each string), so the DP table is a grid filled from neighbors.",
  },
  {
    id: 14,
    prompt: "Find the contiguous subarray with the largest sum.",
    answer: "greedy",
    why: "Kadane's: at each step greedily extend the current run or restart — a provably optimal local choice.",
  },
  {
    id: 15,
    prompt: "Merge all overlapping intervals in a list of [start, end] pairs.",
    answer: "intervals",
    why: "Sort by start, then a single sweep merges any interval that overlaps the previous one.",
  },
  {
    id: 16,
    prompt:
      "Reverse a singly linked list and return the new head, using O(1) extra space.",
    answer: "linked-list",
    why: "In-place pointer surgery: keep prev/curr, flip each next, advance — no extra structure.",
  },
  {
    id: 17,
    prompt: "Find the element that appears once when every other element appears twice.",
    answer: "bit-manipulation",
    why: "XOR is its own inverse, so XOR-ing everything cancels the pairs and leaves the unique value — O(1) space.",
  },
  {
    id: 18,
    prompt: "Validate that a binary tree is a valid binary search tree.",
    answer: "trees",
    why: "Recurse carrying (min, max) bounds down each subtree — a node's value must lie strictly within them.",
  },
  {
    id: 19,
    prompt: "Implement autocomplete: insert words and query which start with a given prefix.",
    answer: "tries",
    why: "Prefix queries over many words share common paths — a trie answers startsWith in O(prefix length).",
  },
  {
    id: 20,
    prompt: "Rotate an n×n matrix 90 degrees clockwise in place.",
    answer: "math-geometry",
    why: "A structural identity: transpose across the diagonal, then reverse each row — index arithmetic, O(1) space.",
  },
  {
    id: 21,
    prompt:
      "Find the shortest path cost in a weighted graph with non-negative edges.",
    answer: "advanced-graphs",
    why: "Weighted shortest path → Dijkstra: a min-heap always expands the closest-so-far node.",
  },
  {
    id: 22,
    prompt: "Find the node where a cycle begins in a linked list (or detect there's none).",
    answer: "linked-list",
    why: "Floyd's fast/slow pointers detect the loop; resetting one to head finds the entry — O(1) space.",
  },
  {
    id: 23,
    prompt:
      "Return the kth smallest element in a binary search tree.",
    answer: "trees",
    why: "An in-order traversal of a BST yields sorted order, so the kth visited node is the answer.",
  },
  {
    id: 24,
    prompt:
      "Given target amount and coin denominations, find the fewest coins that make the amount.",
    answer: "dp-1d",
    why: "dp[amount] = 1 + min over coins of dp[amount - coin]: overlapping subproblems along the amount axis.",
  },
];
