/**
 * Guided "reveal the approach" hints for the representative problems, keyed by
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
        "Walk the array once. For each value x you need target − x; keep a hash map of value → index of everything seen so far and, before inserting x, check whether target − x is already there. The complement lookup is O(1), so it's a single O(n) pass instead of an O(n²) double loop.",
    },
    "Contains Duplicate": {
      hint: "You only need to know whether you've encountered a value before, not where.",
      approach:
        "Stream the array into a hash set. The first time you try to add a value that's already present, you've found a duplicate — return true; if you finish, return false. O(n) time and space; the set membership test replaces the compare-every-pair scan.",
    },
    "Valid Anagram": {
      hint: "Anagrams have the exact same multiset of characters.",
      approach:
        "Count each character of the first string (a 26-slot array or hash map), then decrement those counts while scanning the second; if any count goes negative or a final count is non-zero, they're not anagrams. O(n) and O(1) extra space for a fixed alphabet — cheaper than sorting both strings.",
    },
    "Group Anagrams": {
      hint: "All anagrams share a canonical form you can use as a dictionary key.",
      approach:
        "Map each word to a canonical signature — its sorted letters, or a 26-length count tuple — and bucket words by that key in a hash map. Each bucket is one anagram group. With the count-tuple key it's O(total characters), beating O(n · k log k) sorting.",
    },
    "Top K Frequent Elements": {
      hint: "Frequencies are bounded by n, so you can bucket by count instead of sorting.",
      approach:
        "Tally counts in a hash map, then place each value into a bucket indexed by its frequency (an array of size n+1). Walk the buckets from high to low, collecting until you have k. That's O(n) — no full sort or heap needed, since frequencies can't exceed the array length.",
    },
    "Longest Consecutive Sequence": {
      hint: "Only start counting a run from a number that has no left neighbour.",
      approach:
        "Put everything in a hash set. For each value, if value − 1 is absent it's the start of a run, so walk value+1, value+2, … counting how far the run extends. Each number is visited at most twice, giving O(n) — far better than the O(n log n) you'd get from sorting.",
    },
  },
  "two-pointers": {
    "Valid Palindrome": {
      hint: "A palindrome reads the same from both ends — so compare from both ends.",
      approach:
        "Put one pointer at the start and one at the end. Skip non-alphanumerics, lowercase the rest, and compare; if they ever differ it's not a palindrome, otherwise move both inward until they cross. O(n) time, O(1) space — no reversed copy.",
    },
    "Two Sum II": {
      hint: "The array is sorted, so the sum tells you which pointer to move.",
      approach:
        "Converge two pointers from the ends. If the pair sum is too small move the left pointer right (to increase it); if too big move the right pointer left; when it equals the target you're done. Sortedness makes each move unambiguous, so it's O(n) and O(1) space.",
    },
    "3Sum": {
      hint: "Fix one number, then it's a sorted two-pointer pair-sum problem.",
      approach:
        "Sort the array. For each index i, search the suffix for a pair summing to −nums[i] with two converging pointers, skipping equal neighbours at every level to avoid duplicate triplets. O(n²) overall — far better than the O(n³) brute force.",
    },
    "Container With Most Water": {
      hint: "The shorter wall caps the area, so move the pointer that limits you.",
      approach:
        "Start with the widest container (pointers at both ends). Area is width × min(heights). Always move the pointer at the shorter line inward — the only move that could find a taller wall and beat the current best, since shrinking width otherwise only hurts. O(n).",
    },
    "Trapping Rain Water": {
      hint: "Water above a bar is bounded by the shorter of the tallest walls to its left and right.",
      approach:
        "Use two pointers tracking leftMax and rightMax. Whichever side has the smaller max determines the water there: advance that pointer, adding max − height at each step. One O(n) pass, O(1) space — no per-index left/right max arrays required.",
    },
  },
  "sliding-window": {
    "Best Time to Buy/Sell Stock": {
      hint: "Track the cheapest price seen so far as your buy point.",
      approach:
        "Sweep once keeping the minimum price seen and the best profit (current price − min so far). It's a one-sided window: the left edge only ever moves to a new minimum. O(n) time, O(1) space.",
    },
    "Longest Substring Without Repeats": {
      hint: "Grow a window on the right; when it becomes invalid, shrink it from the left.",
      approach:
        "Maintain a window and a last-seen map. Extend the right edge; if the new char repeats inside the window, jump the left edge past its previous occurrence. Track the max width. Each index is processed once, so O(n).",
    },
    "Longest Repeating Char Replacement": {
      hint: "A window is valid while (length − count of its most frequent char) ≤ k.",
      approach:
        "Slide a window with a frequency table. It's feasible when its length minus the highest single-character count is ≤ k (the chars you'd repaint). Shrink from the left when that's exceeded; the answer is the largest feasible window. O(n) with a 26-entry table.",
    },
    "Permutation in String": {
      hint: "A permutation is a fixed-length window with a matching character histogram.",
      approach:
        "Build the target's character counts, then slide a fixed-size window over the haystack maintaining its counts. When the window's histogram equals the target's, you've found a permutation. Update counts in O(1) per step (add right, drop left) for O(n) total.",
    },
    "Minimum Window Substring": {
      hint: "Expand until valid, then contract as far as you can while staying valid.",
      approach:
        "Grow the right edge until the window covers all required characters (track a 'have/need' satisfied count). Then shrink from the left while it stays valid, recording the smallest such window. Each pointer only moves forward, so it's O(n) despite the nested feel.",
    },
  },
  stack: {
    "Valid Parentheses": {
      hint: "The most recently opened bracket must be the first one closed — LIFO.",
      approach:
        "Push every opener. On a closer, the stack top must be its matching opener — pop and compare; mismatch or empty stack means invalid. The stack must be empty at the end. O(n).",
    },
    "Min Stack": {
      hint: "Remember the minimum that was in effect when each element was pushed.",
      approach:
        "Alongside the main stack, keep a second stack (or store pairs) of the running minimum: on push, record min(value, current min). Pop both together. getMin is then just the top of the min stack — O(1) for every operation.",
    },
    "Evaluate RPN": {
      hint: "Operands wait on a stack until their operator arrives.",
      approach:
        "Scan left to right: push numbers; on an operator pop the two most recent operands, apply it, and push the result. Postfix encodes order, so no precedence or parentheses logic is needed. One value remains. O(n).",
    },
    "Daily Temperatures": {
      hint: "Keep a stack of days still waiting for a warmer day.",
      approach:
        "Use a monotonic decreasing stack of indices. For each day, while it's warmer than the day at the stack top, pop and record the gap (current index − popped index) as that day's answer, then push the current day. Each index is pushed and popped once: O(n).",
    },
    "Largest Rectangle in Histogram": {
      hint: "A bar's rectangle extends until it meets a shorter bar on each side.",
      approach:
        "Maintain a stack of increasing bar heights (by index). When a shorter bar arrives, pop taller bars and compute each popped bar's area using the current index as its right boundary and the new stack top as its left boundary. A sentinel zero flushes the stack at the end. O(n).",
    },
  },
  "binary-search": {
    "Binary Search": {
      hint: "Each comparison should let you throw away half of what's left.",
      approach:
        "Keep a [lo, hi] range; check the middle, and search left or right depending on whether it's bigger or smaller than the target. Use lo + (hi − lo)/2 and a consistent boundary convention so you never overflow or loop forever. O(log n).",
    },
    "Search a 2D Matrix": {
      hint: "A row-sorted, column-sorted matrix can be read as one sorted array.",
      approach:
        "Treat the m×n matrix as a flat sorted array of length m·n and binary-search it, mapping index k to row k/n and column k%n. One O(log(m·n)) search — no need to first find the row then the column.",
    },
    "Koko Eating Bananas": {
      hint: "You're not searching the array — you're binary-searching the answer.",
      approach:
        "Eating speed is monotonic: if speed s finishes in time, so does any faster speed. Binary-search s over [1, max pile]; for a candidate, sum ceil(pile/s) hours and check it's ≤ h. 'Binary search on the answer' turns an O(answer) probe into O(n log(max)).",
    },
    "Find Min in Rotated Array": {
      hint: "Compare the middle to the right end to know which half is sorted.",
      approach:
        "If nums[mid] > nums[hi], the rotation point (and the minimum) is to the right, so set lo = mid + 1; otherwise it's at mid or to the left, so hi = mid. Converge on the smallest element in O(log n).",
    },
    "Median of Two Sorted Arrays": {
      hint: "Binary-search the cut point in the shorter array so both halves balance.",
      approach:
        "Partition the smaller array at some i, which forces the partition j in the larger so the left halves hold exactly half the elements. Adjust i until maxLeft ≤ minRight on both sides; the median then comes from the four boundary values. Searching only the shorter array gives O(log(min(m, n))).",
    },
  },
  "linked-list": {
    "Reverse Linked List": {
      hint: "Re-point each node's next to the node behind it as you walk forward.",
      approach:
        "Keep prev = null and curr = head; at each step save curr.next, point curr.next back to prev, then advance prev and curr. When curr is null, prev is the new head. O(n) time, O(1) space — save the next pointer before clobbering it.",
    },
    "Merge Two Sorted Lists": {
      hint: "Repeatedly splice off the smaller head — like the merge step of mergesort.",
      approach:
        "Use a dummy head and a tail pointer. Compare the two list heads, attach the smaller one to the tail, and advance that list; when one list runs out, attach the remainder of the other. O(m + n) and O(1) extra space.",
    },
    "Linked List Cycle": {
      hint: "Two runners at different speeds on a loop will eventually meet.",
      approach:
        "Floyd's tortoise and hare: advance one pointer by 1 and another by 2. In a cycle they must collide; if the fast pointer reaches null, the list is acyclic. O(n) time, O(1) space — no visited set.",
    },
    "Reorder List": {
      hint: "Split in half, reverse the second half, then zip the two halves together.",
      approach:
        "Find the middle with slow/fast pointers, reverse the second half in place, then interleave nodes from the front list and the reversed back list one at a time. Three linear passes, O(n) time and O(1) space.",
    },
    "LRU Cache": {
      hint: "You need O(1) lookup and O(1) move-to-most-recent — a hash map plus a doubly linked list.",
      approach:
        "Keep a hash map from key → node and a doubly linked list ordered by recency. get moves the node to the front; put inserts/updates at the front and, if over capacity, evicts the tail. The map gives O(1) access; the list gives O(1) reordering and eviction.",
    },
  },
  trees: {
    "Invert Binary Tree": {
      hint: "Inverting a tree is inverting its subtrees, then swapping them.",
      approach:
        "Recurse: invert left, invert right, swap the two child pointers (a DFS that does its work on the way back up). Base case is a null node. O(n), with recursion depth equal to the tree height.",
    },
    "Maximum Depth": {
      hint: "A node's depth is one more than the deeper of its two subtrees.",
      approach:
        "Return 0 for null, otherwise 1 + max(depth(left), depth(right)). A straightforward post-order DFS that touches every node once: O(n).",
    },
    "Level Order Traversal": {
      hint: "Process the tree one full level at a time — that's BFS.",
      approach:
        "BFS with a queue, but each outer iteration drains exactly the nodes currently in the queue (one level) before enqueuing their children. Collect each level into its own list. O(n) time and O(width) space.",
    },
    "Validate BST": {
      hint: "A node must fit a (min, max) range inherited from its ancestors, not just beat its children.",
      approach:
        "DFS carrying an open interval (low, high): each node must satisfy low < val < high, then recurse left with high = val and right with low = val. The naive 'left < node < right' local check misses violations deeper in the tree. O(n).",
    },
    "Lowest Common Ancestor": {
      hint: "In a BST, the split point where the two targets diverge is their LCA.",
      approach:
        "Walk down from the root: if both targets are smaller, go left; if both larger, go right; the first node that sits between them (or equals one) is the lowest common ancestor. O(h) for a BST. (In a general tree, return the node where the two targets surface in different subtrees.)",
    },
    "Binary Tree Max Path Sum": {
      hint: "Each node decides whether to extend a path through it or start fresh.",
      approach:
        "Post-order DFS returning the best downward path from each node: max(0, left), max(0, right) added to the node's value (dropping negative branches). While recursing, update a global best with left + node + right — the path that bends through this node. O(n).",
    },
  },
  tries: {
    "Implement Trie": {
      hint: "Each node branches per character; words end at marked nodes.",
      approach:
        "Model nodes as a map (or 26-slot array) of child links plus an isEnd flag. insert walks/creates one node per character; search walks the path and checks isEnd; startsWith just needs the path to exist. Each operation is O(word length), independent of how many words are stored.",
    },
    "Design Add & Search Words": {
      hint: "A '.' wildcard means branching the search across all children at that node.",
      approach:
        "Store words in a trie. On search, walk character by character; when you hit '.', recurse into every child and succeed if any branch matches the rest. Concrete characters stay O(1) per step; wildcards fan out, but the trie keeps it far cheaper than scanning all words.",
    },
    "Word Search II": {
      hint: "Searching the board for many words? Build one trie of the words and DFS the grid through it.",
      approach:
        "Insert all target words into a trie, then DFS from each cell descending the trie by the current letter, pruning the instant a prefix leaves the trie. Record words at isEnd nodes. Sharing prefixes across words is what beats searching each word separately.",
    },
  },
  "heap-priority-queue": {
    "Kth Largest in a Stream": {
      hint: "Keep only the k biggest seen so far — the smallest of those is the answer.",
      approach:
        "Maintain a min-heap of size k. On each add, push the value and pop the minimum if the heap exceeds k; the root is always the k-th largest. Each add is O(log k), with no need to sort the whole stream.",
    },
    "Last Stone Weight": {
      hint: "You repeatedly need the two largest stones — that's a max-heap.",
      approach:
        "Heapify the stones into a max-heap. Repeatedly pop the two largest; if they differ, push the difference back. When 0 or 1 stones remain, that's the answer. Each round is O(log n), O(n log n) overall.",
    },
    "K Closest Points to Origin": {
      hint: "You want the k smallest distances — bound a heap at size k.",
      approach:
        "Use a max-heap of size k keyed by squared distance (skip the sqrt). Push each point and pop the farthest whenever the heap exceeds k; what remains is the k closest. O(n log k), better than a full O(n log n) sort when k ≪ n.",
    },
    "Task Scheduler": {
      hint: "Schedule the most frequent task first to spread out its cooldowns.",
      approach:
        "The answer is governed by the most frequent task: with max count M (appearing t times), you need (M − 1) × (n + 1) + t slots, or just the task count if there are enough distinct tasks to fill the gaps. Take the max of the two. A greedy/heap framing both work; the formula is O(1) after counting.",
    },
    "Find Median from Data Stream": {
      hint: "Keep the lower half and upper half balanced in two heaps.",
      approach:
        "Maintain a max-heap of the smaller half and a min-heap of the larger half, kept balanced in size. The median is the top of the bigger heap, or the average of both tops when sizes are equal. add is O(log n); median is O(1).",
    },
    "Merge K Sorted Lists": {
      hint: "Always pull the smallest current head across all lists — a heap gives you that.",
      approach:
        "Put the head of each list into a min-heap. Repeatedly pop the smallest, append it to the result, and push that node's next. Each of the N total nodes passes through the heap once: O(N log k).",
    },
  },
  backtracking: {
    Subsets: {
      hint: "At each element you make a binary choice: include it or don't.",
      approach:
        "DFS over the indices carrying a current subset: record it, then for each later index choose that element, recurse, and un-choose (pop) before the next — the choose / explore / un-choose loop. There are 2ⁿ subsets, so O(n·2ⁿ).",
    },
    "Combination Sum": {
      hint: "Allow reuse by recursing from the same index; avoid duplicate sets by never going backwards.",
      approach:
        "DFS tracking a running total and a start index. You may reuse the current candidate (recurse with the same index) or move on (advance it); prune when the total exceeds the target. The start index stops permutations of the same combination from being recounted.",
    },
    Permutations: {
      hint: "At each position, try every value not already used.",
      approach:
        "DFS building the arrangement position by position, marking values used as you place them and un-marking on backtrack. When the path is full, record it. n! leaves, so O(n·n!). A used[] array (or swap-in-place) tracks what's still available.",
    },
    "Word Search": {
      hint: "DFS from each cell, marking visited so you don't reuse a letter.",
      approach:
        "From every starting cell, DFS to neighbours matching the next character, temporarily marking the current cell visited (e.g. overwrite it) and restoring it on backtrack. Succeed when you consume the whole word. Worst case O(cells · 4^len).",
    },
    "N-Queens": {
      hint: "Place one queen per row; track attacked columns and diagonals as sets.",
      approach:
        "Recurse row by row, trying each column that isn't in the used column set or either diagonal set (col − row and col + row identify the two diagonals). Add to the sets, recurse, then remove on backtrack. The constant-time conflict check via sets makes the pruning efficient.",
    },
  },
  graphs: {
    "Number of Islands": {
      hint: "Each unvisited land cell is a new island — flood-fill it so you don't recount it.",
      approach:
        "Scan the grid; on an unvisited '1', increment the count and BFS/DFS out to all connected land, marking it visited (or sinking it to '0'). Every cell is touched a constant number of times: O(rows × cols).",
    },
    "Clone Graph": {
      hint: "Map each original node to its copy so shared neighbours aren't duplicated.",
      approach:
        "DFS/BFS keeping a hash map from original node → clone. When you first see a node, create its clone and recurse into its neighbours, wiring cloned neighbours via the map; the map both prevents infinite loops and ensures shared nodes are cloned once. O(V + E).",
    },
    "Course Schedule": {
      hint: "You can finish all courses iff the prerequisite graph has no cycle.",
      approach:
        "Build the directed graph and detect a cycle — either via Kahn's topological sort (repeatedly remove zero-in-degree nodes; a leftover means a cycle) or DFS with a recursion-stack 'in progress' marker. No cycle ⇒ a valid order exists. O(V + E).",
    },
    "Rotting Oranges": {
      hint: "Minutes elapsed = layers spreading outward at once. That's multi-source BFS.",
      approach:
        "Seed a queue with every rotten orange at minute 0, then BFS level by level, each level rotting fresh neighbours and counting as one minute. The answer is the number of levels, or −1 if any fresh orange is unreachable. BFS, not DFS, because you need the shortest spread time. O(cells).",
    },
    "Pacific Atlantic Water Flow": {
      hint: "Instead of asking where each cell drains, flood inland from both oceans.",
      approach:
        "Run a BFS/DFS from every Pacific-border cell and another from every Atlantic-border cell, moving to neighbours of equal-or-greater height (water flowing uphill, in reverse). Cells reachable from both searches are the answer. O(rows × cols), avoiding a per-cell flood.",
    },
  },
  "advanced-graphs": {
    "Network Delay Time": {
      hint: "Shortest time for a signal to reach every node = single-source shortest paths.",
      approach:
        "Run Dijkstra from the source over the weighted graph with a min-heap, relaxing edges to keep the shortest known time to each node. The answer is the maximum of those times (or −1 if a node is unreachable). O(E log V).",
    },
    "Course Schedule II": {
      hint: "A valid order exists iff the prerequisite graph is acyclic — topological sort.",
      approach:
        "Build the graph and in-degree counts; start a queue with all zero-in-degree nodes, then repeatedly pop one into the order and decrement its neighbours, enqueuing any that hit zero (Kahn's algorithm). Outputting every node gives the order; otherwise a cycle made it impossible. O(V + E).",
    },
    "Min Cost to Connect Points": {
      hint: "Connect all points at minimum total cost = minimum spanning tree.",
      approach:
        "Treat points as a complete graph weighted by Manhattan distance and build an MST with Prim's: grow a tree from any start, always adding the cheapest edge to an outside node via a min-heap. Summing the chosen edges gives the answer. O(n² log n) for the dense graph.",
    },
    "Redundant Connection": {
      hint: "The edge that closes a cycle is the one joining two already-connected nodes.",
      approach:
        "Process edges with union-find. For each edge, if its two endpoints are already in the same set, that edge created the cycle — return it; otherwise union them. Near-O(n) with path compression and union by rank.",
    },
    "Cheapest Flights K Stops": {
      hint: "Relax edges only k+1 times — that bounds the number of stops.",
      approach:
        "Use Bellman-Ford limited to k+1 rounds: each round relaxes all edges from a snapshot of the previous round's costs, so after r rounds you know cheapest costs using at most r edges. The stop limit is exactly what caps the rounds. O(k · E).",
    },
    "Swim in Rising Water": {
      hint: "Minimize the maximum elevation along a path — a 'minimize the bottleneck' search.",
      approach:
        "Dijkstra-style with a min-heap keyed by the worst (highest) elevation seen so far on the path to a cell; always expand the cell with the smallest such bottleneck. The bottleneck when you reach the bottom-right is the answer. (A binary-search-on-time + flood-fill also works.) O(n² log n).",
    },
  },
  "dp-1d": {
    "Climbing Stairs": {
      hint: "The ways to reach step n depend only on steps n−1 and n−2.",
      approach:
        "Ways(n) = Ways(n−1) + Ways(n−2) — it's Fibonacci. Iterate from the base cases keeping just the last two values: O(n) time, O(1) space. Recognising the fixed-window dependency is the core 1-D DP move.",
    },
    "House Robber": {
      hint: "At each house, choose: rob it (and skip the previous) or skip it.",
      approach:
        "dp[i] = max(dp[i−1], dp[i−2] + nums[i]) — either skip house i, or rob it and add the best up to i−2. Roll two variables forward for O(n) time and O(1) space.",
    },
    "Coin Change": {
      hint: "Best way to make amount a uses the best way to make a − coin.",
      approach:
        "dp[a] = min coins to make a, init to infinity except dp[0] = 0. For each a, try every coin c ≤ a: dp[a] = min(dp[a], dp[a−c] + 1). The answer is dp[amount], or −1 if still infinity. O(amount × coins).",
    },
    "Longest Increasing Subsequence": {
      hint: "Maintain the smallest possible tail for an increasing run of each length.",
      approach:
        "Keep a 'tails' array where tails[k] is the minimum ending value of an increasing subsequence of length k+1. For each number, binary-search its insertion point and overwrite that tail; the array's length is the LIS length. O(n log n) — beats the O(n²) dp[i] = max over earlier smaller elements.",
    },
    "Word Break": {
      hint: "A prefix is breakable if some earlier cut point is breakable and the gap is a word.",
      approach:
        "dp[i] = can the first i characters be segmented. dp[0] = true; dp[i] is true if some j < i has dp[j] true and s[j..i] is in the dictionary (a set). The answer is dp[n]. O(n² ) with O(1) word lookups.",
    },
    "Decode Ways": {
      hint: "At each position, a digit can stand alone or pair with the previous one (10–26).",
      approach:
        "dp[i] = ways to decode the first i characters. Add dp[i−1] if the single digit is 1–9, and dp[i−2] if the two-digit number is 10–26. Watch zeros carefully. Roll two variables for O(n) time, O(1) space.",
    },
  },
  "dp-2d": {
    "Unique Paths": {
      hint: "You can only arrive at a cell from above or from the left.",
      approach:
        "dp[i][j] = dp[i−1][j] + dp[i][j−1], with the first row and column all 1. Sweep the grid; dp[m−1][n−1] is the count. O(m × n) time, O(n) with a rolling row.",
    },
    "Longest Common Subsequence": {
      hint: "Compare the two strings on a grid; matches extend a diagonal.",
      approach:
        "dp[i][j] = LCS of the first i chars of A and first j of B. If A[i−1] == B[j−1], dp[i][j] = dp[i−1][j−1] + 1, else max(dp[i−1][j], dp[i][j−1]). The bottom-right cell is the answer. O(m × n), reducible to two rows.",
    },
    "Coin Change II": {
      hint: "Count combinations, not permutations — so iterate coins on the outside.",
      approach:
        "dp[a] = number of ways to make amount a, init dp[0] = 1. Loop coins in the outer loop and amounts inner, doing dp[a] += dp[a − coin]. Coins-outer is what stops {1,2} and {2,1} being counted twice. O(amount × coins).",
    },
    "Edit Distance": {
      hint: "Each cell is the cheapest of insert, delete, or replace from a smaller subproblem.",
      approach:
        "dp[i][j] = edits to turn A[:i] into B[:j]. If the last chars match, carry dp[i−1][j−1]; otherwise 1 + min(insert dp[i][j−1], delete dp[i−1][j], replace dp[i−1][j−1]). First row/column count pure insertions/deletions. O(m × n).",
    },
    "Distinct Subsequences": {
      hint: "When characters match you may either use the match or skip it in the source.",
      approach:
        "dp[i][j] = ways T[:j] appears as a subsequence of S[:i]. dp[i][j] = dp[i−1][j] (skip S's char) plus, if S[i−1] == T[j−1], dp[i−1][j−1] (use it). dp[i][0] = 1 (empty target). The corner is the answer. O(m × n).",
    },
  },
  greedy: {
    "Maximum Subarray": {
      hint: "At each element, decide: extend the current run, or start fresh from here?",
      approach:
        "Kadane's: cur = max(x, cur + x) — drop the past when it's dragging you negative — and track the best cur ever seen. One O(n) pass, O(1) space. A negative prefix can never help a later sum, which is the greedy insight.",
    },
    "Jump Game": {
      hint: "Track the furthest index you could possibly reach so far.",
      approach:
        "Sweep left to right maintaining the maximum reachable index; if your position ever exceeds that reach you're stuck (false), and if the reach covers the last index, return true. O(n) — greedily extending the frontier beats exploring every jump.",
    },
    "Gas Station": {
      hint: "If total gas ≥ total cost, a unique start exists — find where the tank never dips.",
      approach:
        "Track a running tank as you loop; whenever it goes negative, no station up to here can be the start, so reset the candidate start to the next station and zero the tank. If total gas ≥ total cost, the surviving candidate is the answer. O(n).",
    },
    "Partition Labels": {
      hint: "A label can't be split past the last occurrence of any character inside it.",
      approach:
        "Record each character's last index. Sweep, extending the current partition's end to the max last-index of the characters seen; when the cursor reaches that end, cut a partition and start a new one. O(n).",
    },
    "Hand of Straights": {
      hint: "Always start the next group from the smallest remaining card.",
      approach:
        "Count cards, then repeatedly take the smallest available card and greedily consume the next groupSize − 1 consecutive values, decrementing counts; fail if any is missing. A sorted map or min-heap drives the 'smallest first' order. O(n log n).",
    },
  },
  intervals: {
    "Insert Interval": {
      hint: "Intervals are pre-sorted, so handle before / overlapping / after in three phases.",
      approach:
        "Copy intervals ending before the new one starts, then merge every interval that overlaps the new one by widening its bounds, then copy the rest. One linear pass over the sorted list: O(n).",
    },
    "Merge Intervals": {
      hint: "Sort by start, then walk once — overlaps become adjacent.",
      approach:
        "Sort by start. Keep a 'current' interval; if the next starts within current's end, extend current's end to the max of the two, otherwise emit current and start anew. O(n log n), dominated by the sort.",
    },
    "Non-overlapping Intervals": {
      hint: "To keep the most intervals, always keep the one that ends earliest.",
      approach:
        "Sort by end time and greedily keep intervals whose start is ≥ the last kept end, counting the rest as removals. Earliest-finishing leaves the most room for what follows (the activity-selection argument). O(n log n).",
    },
    "Meeting Rooms": {
      hint: "Any overlap at all means a person is double-booked.",
      approach:
        "Sort meetings by start time, then check each consecutive pair: if one starts before the previous ends, they conflict and you return false. O(n log n).",
    },
    "Meeting Rooms II": {
      hint: "The answer is the maximum number of meetings happening at the same instant.",
      approach:
        "Separate and sort start and end times; sweep with two pointers, incrementing a counter on a start and decrementing on an end, tracking the peak. (Equivalently, a min-heap of end times sized to the max concurrency.) O(n log n).",
    },
  },
  "math-geometry": {
    "Rotate Image": {
      hint: "A 90° rotation = transpose, then reverse each row — in place.",
      approach:
        "Transpose the matrix (swap a[i][j] with a[j][i]), then reverse each row; that composition is exactly a clockwise quarter-turn, mutating in O(n²) time and O(1) extra space. Spotting the transform identity avoids fiddly index juggling.",
    },
    "Spiral Matrix": {
      hint: "Peel the matrix in layers: top row, right column, bottom row, left column.",
      approach:
        "Track four boundaries. Walk the top row left→right and shrink top; the right column top→bottom and shrink right; then bottom and left with guards so a collapsed layer isn't re-walked. Continue until the boundaries cross. O(rows × cols).",
    },
    "Set Matrix Zeroes": {
      hint: "Use the first row and column themselves as the 'should zero' markers.",
      approach:
        "First note whether row 0 / column 0 must be zeroed. Then, for each inner cell that's zero, mark its row's and column's header cell. In a second pass zero cells whose header is marked, and finally handle row 0 / column 0. O(m × n) time, O(1) extra space.",
    },
    "Pow(x, n)": {
      hint: "Square the base and halve the exponent — exponentiation by squaring.",
      approach:
        "Compute x^n by repeatedly squaring x and halving n, multiplying the result in whenever the current exponent bit is 1; handle negative n by inverting at the end. O(log n) multiplications instead of n.",
    },
    "Happy Number": {
      hint: "Iterating the digit-square-sum either reaches 1 or cycles — detect the cycle.",
      approach:
        "Repeatedly replace n with the sum of the squares of its digits. Use Floyd's slow/fast pointers (or a seen-set): if it reaches 1 it's happy, if the fast pointer cycles back without hitting 1 it isn't. O(log n) per step, constant extra space with the two-pointer trick.",
    },
  },
  "bit-manipulation": {
    "Single Number": {
      hint: "What operation makes equal pairs cancel to zero?",
      approach:
        "XOR every element together: identical numbers cancel (x ^ x = 0) and x ^ 0 = x, so the lone unpaired number is what's left. O(n) time, O(1) space — no hash set.",
    },
    "Number of 1 Bits": {
      hint: "n & (n − 1) erases the lowest set bit.",
      approach:
        "Repeatedly do n &= n − 1, counting iterations until n is 0 — each step clears exactly one set bit, so it runs as many times as there are 1s. Faster than checking all 32 bit positions.",
    },
    "Counting Bits": {
      hint: "The bit count of n relates to a smaller number you've already solved.",
      approach:
        "dp[i] = dp[i >> 1] + (i & 1): dropping the lowest bit gives a previously computed answer, and i & 1 adds back whether that bit was set. Fill 0..n in one O(n) pass instead of popcounting each number.",
    },
    "Reverse Bits": {
      hint: "Shift the answer left while shifting the input right, moving one bit across each step.",
      approach:
        "Loop 32 times: shift the result left by one, OR in the input's lowest bit (n & 1), then shift the input right. The bit pulled off the bottom of n lands at the top of the result. O(1) — a fixed 32 iterations.",
    },
    "Missing Number": {
      hint: "XOR all indices and values; the unpaired one is the missing number.",
      approach:
        "XOR together every index 0..n and every array value. Each present number cancels with its index, leaving only the missing one. (Equivalently, subtract the array sum from n(n+1)/2.) O(n), O(1) space, with no overflow risk using XOR.",
    },
  },
};

export function approachFor(patternId: string, problemName: string): Approach | undefined {
  return approaches[patternId]?.[problemName];
}
