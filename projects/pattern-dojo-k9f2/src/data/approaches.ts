/**
 * Guided "reveal the approach" hints for representative problems, keyed by
 * pattern id then exact problem name. Kept separate from `patterns.ts` so the
 * content model stays untouched and these can grow independently. A pattern's
 * `howItWorks` is used as a fallback when a specific problem has no entry.
 */

export interface Approach {
  hint: string;
  approach: string;
}

export const approaches: Record<string, Record<string, Approach>> = {
  "arrays-hashing": {
    "Two Sum": {
      hint: "What would let you check 'have I seen the number that completes this pair?' in O(1)?",
      approach:
        "Walk the array once. For each value x, you need target − x. Keep a hash map of value → index of everything seen so far; before inserting x, check whether target − x is already in the map. The complement is found in O(1), so the whole thing is one pass, O(n) time and O(n) space — no nested loop.",
    },
    "Contains Duplicate": {
      hint: "You only need to know whether you've encountered a value before, not where.",
      approach:
        "Stream the array into a hash set. The first time you try to add a value that's already present, you've found your duplicate — return true. If you finish the array, return false. O(n) time, O(n) space; the set membership test is what replaces the O(n²) compare-every-pair scan.",
    },
  },
  "two-pointers": {
    "Valid Palindrome": {
      hint: "A palindrome reads the same from both ends — so compare from both ends.",
      approach:
        "Put one pointer at the start and one at the end. Skip non-alphanumeric characters, lowercase the rest, and compare. If they ever differ, it's not a palindrome; otherwise move both inward until they cross. O(n) time, O(1) space — no reversed copy needed.",
    },
    "3Sum": {
      hint: "Fix one number, then it becomes a sorted two-pointer pair-sum problem.",
      approach:
        "Sort the array. For each index i, search the suffix to its right for a pair summing to −nums[i] using two converging pointers. Move the left pointer up when the sum is too small, the right down when too big. Skip equal neighbours at every level to avoid duplicate triplets. O(n²) overall, which beats the O(n³) brute force.",
    },
  },
  "sliding-window": {
    "Longest Substring Without Repeats": {
      hint: "Grow a window on the right; when it becomes invalid, shrink it from the left.",
      approach:
        "Maintain a window [l, r] and a set (or last-seen map) of its characters. Extend r one step at a time; if the new char is already in the window, advance l (removing chars) until it's valid again. Track the max window length seen. Each index enters and leaves the window at most once, so it's O(n).",
    },
    "Longest Repeating Char Replacement": {
      hint: "A window is valid while (window length − count of its most frequent char) ≤ k.",
      approach:
        "Slide a window keeping a frequency table. The window is feasible when length minus the highest single-character count is ≤ k (those are the chars you'd repaint). When it exceeds k, advance the left edge. The answer is the largest feasible window. O(n) with a 26-entry count table.",
    },
  },
  stack: {
    "Valid Parentheses": {
      hint: "The most recently opened bracket must be the first one closed — that's LIFO.",
      approach:
        "Push every opening bracket. On a closing bracket, the top of the stack must be its matching opener — pop and compare; if it doesn't match (or the stack is empty), it's invalid. At the end the stack must be empty. O(n) time and space.",
    },
    "Evaluate RPN": {
      hint: "Operands wait on a stack until their operator arrives.",
      approach:
        "Scan left to right. Push numbers; on an operator, pop the two most recent operands, apply it, and push the result. Postfix needs no precedence rules or parentheses — the order is already encoded. One final value remains on the stack. O(n).",
    },
  },
  "binary-search": {
    "Binary Search": {
      hint: "Each comparison should let you throw away half of what's left.",
      approach:
        "Keep a [lo, hi] range. Look at the middle; if it's the target you're done, if it's too small search the right half, otherwise the left. Use lo + (hi − lo) / 2 to avoid overflow and a consistent boundary convention so you never loop forever. O(log n).",
    },
    "Koko Eating Bananas": {
      hint: "You're not searching the array — you're binary-searching the answer.",
      approach:
        "The eating speed is monotonic: if speed s finishes in time, so does any speed > s. Binary-search s over [1, max pile]. For a candidate speed, sum ceil(pile/s) hours and check it's ≤ h. This 'binary search on the answer' turns an O(answer) scan into O(n log(max)).",
    },
  },
  "linked-list": {
    "Reverse Linked List": {
      hint: "Re-point each node's next to the node behind it as you walk forward.",
      approach:
        "Keep prev = null and curr = head. At each step remember curr.next, point curr.next back to prev, then advance prev and curr. When curr is null, prev is the new head. O(n) time, O(1) space — the trick is saving the next pointer before you clobber it.",
    },
    "Linked List Cycle": {
      hint: "Two runners at different speeds on a loop will eventually meet.",
      approach:
        "Floyd's tortoise and hare: advance one pointer by 1 and another by 2 each step. If there's a cycle they must collide inside it; if the fast pointer hits null, the list is acyclic. O(n) time, O(1) space — no visited set required.",
    },
  },
  trees: {
    "Invert Binary Tree": {
      hint: "Inverting a tree is inverting its subtrees, then swapping them.",
      approach:
        "Recurse: invert the left subtree, invert the right subtree, then swap the two child pointers (a DFS that does its work on the way back up). The base case is a null node. O(n) over all nodes; recursion depth is the tree height.",
    },
    "Validate BST": {
      hint: "A node isn't valid on its own value — it must fit a (min, max) range from its ancestors.",
      approach:
        "DFS carrying an allowed open interval (low, high). A node must satisfy low < val < high; recurse left with high = val and right with low = val. A plain 'left < node < right' local check is the classic trap — it misses violations deeper in the tree. O(n).",
    },
  },
  tries: {
    "Implement Trie": {
      hint: "Each node is a branch per character; words end at marked nodes.",
      approach:
        "Model each node as a map (or 26-slot array) of child links plus an isEnd flag. Insert walks/creates one node per character; search walks the same path and checks isEnd; startsWith just needs the path to exist. Operations are O(length of the word), independent of how many words are stored.",
    },
    "Word Search II": {
      hint: "Searching the board for many words at once? Build one trie of the words and DFS the grid through it.",
      approach:
        "Insert all target words into a trie, then DFS from every cell, descending the trie by the current letter. Prune the instant the prefix leaves the trie. When you reach an isEnd node, record the word. Sharing prefixes across words is what makes this far better than searching each word separately.",
    },
  },
  "heap-priority-queue": {
    "Kth Largest in a Stream": {
      hint: "Keep only the k biggest seen so far — the smallest of those is your answer.",
      approach:
        "Maintain a min-heap of size k. On each add, push the value and, if the heap exceeds k, pop the minimum. The heap's root is always the k-th largest element. Each add is O(log k); you never need to sort the whole stream.",
    },
    "K Closest Points to Origin": {
      hint: "You want the k smallest distances — bound a heap at size k.",
      approach:
        "Use a max-heap of size k keyed by squared distance (no need for the sqrt). Push each point; whenever the heap exceeds k, pop the farthest. What remains is the k closest. O(n log k), beating a full O(n log n) sort when k ≪ n.",
    },
  },
  backtracking: {
    Subsets: {
      hint: "At each element you make a binary choice: include it or don't.",
      approach:
        "DFS over the indices carrying a current partial subset. At index i, record the current subset, then for each later index choose it, recurse, and un-choose (pop) before trying the next — the classic choose / explore / un-choose loop. There are 2ⁿ subsets, so O(n·2ⁿ).",
    },
    "Combination Sum": {
      hint: "Allow reuse by recursing from the same index; prevent duplicate sets by never going backwards.",
      approach:
        "DFS tracking a running total and a start index. At each step you may reuse the current candidate (recurse with the same index) or move on (advance the index). Prune when the total exceeds the target. Passing a start index is what stops permutations of the same combination from being counted twice.",
    },
  },
  graphs: {
    "Number of Islands": {
      hint: "Each unvisited land cell is a new island — flood-fill it so you don't count it twice.",
      approach:
        "Scan the grid. When you hit an unvisited '1', increment the island count and BFS/DFS out to all connected land, marking it visited (or sinking it to '0'). Every cell is touched a constant number of times: O(rows × cols).",
    },
    "Rotting Oranges": {
      hint: "Minutes elapsed = layers spreading outward simultaneously. That's multi-source BFS.",
      approach:
        "Seed a queue with every rotten orange at minute 0, then BFS level by level; each level is one minute, rotting fresh neighbours. The answer is the number of levels processed, or −1 if any fresh orange is unreachable. BFS (not DFS) because you need the shortest spreading time. O(cells).",
    },
  },
  "advanced-graphs": {
    "Course Schedule II": {
      hint: "A valid order exists iff the prerequisite graph has no cycle — that's a topological sort.",
      approach:
        "Build the directed graph and in-degree counts. Start a queue with all zero-in-degree nodes; repeatedly pop one into the order and decrement its neighbours, enqueuing any that hit zero (Kahn's algorithm). If you output every node, that's your ordering; if not, a cycle made it impossible. O(V + E).",
    },
    "Min Cost to Connect Points": {
      hint: "Connect all points at minimum total cost = minimum spanning tree.",
      approach:
        "Treat points as a complete graph weighted by Manhattan distance and build an MST with Prim's: grow a tree from any start, always adding the cheapest edge to an outside node (via a min-heap). The summed edge weights are the answer. O(n² log n) with the dense-graph heap variant.",
    },
  },
  "dp-1d": {
    "Climbing Stairs": {
      hint: "The ways to reach step n only depend on steps n−1 and n−2.",
      approach:
        "Ways(n) = Ways(n−1) + Ways(n−2) — it's Fibonacci. Iterate from the base cases keeping just the last two values, so it's O(n) time and O(1) space. Recognising that a state depends on a fixed window of earlier states is the whole 1-D DP move.",
    },
    "Coin Change": {
      hint: "Best way to make amount a uses the best way to make a − coin for some coin.",
      approach:
        "Build dp[0..amount] where dp[a] = min coins to make a, initialised to infinity except dp[0] = 0. For each amount a, try every coin c ≤ a: dp[a] = min(dp[a], dp[a−c] + 1). The answer is dp[amount] (or −1 if still infinity). O(amount × coins) — a clean unbounded-knapsack DP.",
    },
  },
  "dp-2d": {
    "Longest Common Subsequence": {
      hint: "Compare the two strings character by character on a grid; matches extend a diagonal.",
      approach:
        "dp[i][j] = LCS length of the first i chars of A and first j of B. If A[i−1] == B[j−1], dp[i][j] = dp[i−1][j−1] + 1; otherwise max(dp[i−1][j], dp[i][j−1]). Fill the grid row by row; the bottom-right is the answer. O(m × n), reducible to two rows.",
    },
    "Unique Paths": {
      hint: "You can only arrive at a cell from above or from the left.",
      approach:
        "dp[i][j] = paths to reach (i, j) = dp[i−1][j] + dp[i][j−1], with the first row and column all 1. Sweep the grid; dp[m−1][n−1] is the count. O(m × n) time, O(n) space with a rolling row — a textbook grid DP.",
    },
  },
  greedy: {
    "Maximum Subarray": {
      hint: "At each element, decide: extend the current run, or start fresh from here?",
      approach:
        "Kadane's algorithm: keep cur = max(x, cur + x) — drop the past whenever it's dragging you negative — and track the best cur ever seen. One pass, O(n), O(1) space. The greedy insight is that a negative prefix can never help a later sum.",
    },
    "Jump Game": {
      hint: "Track the furthest index you could possibly reach so far.",
      approach:
        "Sweep left to right maintaining the maximum reachable index. If your current index ever exceeds that reach, you're stuck — return false. If the reach covers the last index, return true. O(n); greedily extending the frontier beats exploring every jump.",
    },
  },
  intervals: {
    "Merge Intervals": {
      hint: "Sort by start, then walk once — overlaps become adjacent.",
      approach:
        "Sort intervals by start time. Keep a 'current' interval; for each next one, if it starts within the current's end, extend the current's end to the max of the two; otherwise emit current and start a new one. O(n log n), dominated by the sort.",
    },
    "Non-overlapping Intervals": {
      hint: "To keep the most intervals, always keep the one that ends earliest.",
      approach:
        "Sort by end time and greedily keep intervals whose start is ≥ the last kept end; count the rest as removals. Choosing the earliest-finishing interval leaves the most room for those that follow — the classic activity-selection argument. O(n log n).",
    },
  },
  "math-geometry": {
    "Rotate Image": {
      hint: "A 90° rotation = transpose, then reverse each row — and it can be done in place.",
      approach:
        "Transpose the matrix (swap a[i][j] with a[j][i]), then reverse every row. That composition is exactly a clockwise 90° turn, mutating the grid in O(n²) time and O(1) extra space. Spotting the transform identity is what avoids an awkward index-juggling rotate.",
    },
    "Spiral Matrix": {
      hint: "Peel the matrix in layers: top row, right column, bottom row, left column.",
      approach:
        "Maintain four boundaries (top, bottom, left, right). Walk the top row left→right and shrink top; the right column top→bottom and shrink right; then the bottom row and left column, with guards so you don't re-walk a collapsed layer. Continue until the boundaries cross. O(rows × cols).",
    },
  },
  "bit-manipulation": {
    "Single Number": {
      hint: "What operation makes equal pairs cancel out to zero?",
      approach:
        "XOR every element together. Identical numbers cancel (x ^ x = 0) and x ^ 0 = x, so the lone unpaired number is what's left. O(n) time, O(1) space — no hash set needed.",
    },
    "Counting Bits": {
      hint: "The bit count of n relates to a smaller number you've already solved.",
      approach:
        "dp[i] = dp[i >> 1] + (i & 1): dropping the lowest bit gives a previously-computed answer, and i & 1 adds back whether that bit was set. Fill 0..n in one pass for O(n) total, instead of popcounting each number independently.",
    },
  },
};

export function approachFor(patternId: string, problemName: string): Approach | undefined {
  return approaches[patternId]?.[problemName];
}
