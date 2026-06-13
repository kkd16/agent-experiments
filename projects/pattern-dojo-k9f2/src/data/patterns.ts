import type { Pattern } from "./types";

/**
 * The 18 patterns behind the NeetCode 150. The focus is on *transferable
 * intuition* — how to recognize a pattern and why it works — not on memorizing
 * individual problem solutions.
 */
export const patterns: Pattern[] = [
  {
    id: "arrays-hashing",
    name: "Arrays & Hashing",
    icon: "🗂️",
    color: "#6ea8fe",
    tagline: "Trade memory for time — remember what you've seen.",
    order: 1,
    level: "foundational",
    intuition: [
      "Most brute-force solutions are slow because they keep re-asking the same question: \"have I seen this value before?\" Each time they answer it by scanning the array again, which is O(n) work repeated n times.",
      "A hash map turns that repeated O(n) scan into a single O(1) lookup. You walk the data once, and as you go you write down what you've seen in a structure that can answer \"seen it?\" instantly.",
      "The whole pattern is a trade: you spend extra memory (the map/set) to buy back time. Almost any \"find a pair / duplicate / count of something\" problem collapses from O(n²) to O(n) once you ask \"what would I need to have already stored to answer this in one pass?\"",
    ],
    mentalModel:
      "A coat-check counter. Instead of searching the whole cloakroom every time, you hand over a ticket (the key) and get your coat back instantly.",
    recognize: [
      "\"Find two numbers that…\", \"contains a duplicate\", \"count occurrences of…\"",
      "You catch yourself writing a nested loop just to check membership or equality.",
      "Order doesn't matter, but identity/frequency does (anagrams, group-by).",
      "You need O(1) lookup of \"have I seen X\" or \"how many X so far\".",
    ],
    howItWorks: [
      "Pick what the *key* should be: the value itself, a frequency signature, a sorted string, etc.",
      "Iterate once. For each element, first CHECK the map for the answer you need.",
      "Then UPDATE the map with the current element so future iterations can use it.",
      "The check-before-update order is what lets you find pairs without comparing an element to itself.",
    ],
    template: {
      lang: "python",
      label: "Two Sum — check, then store",
      code: `def two_sum(nums, target):
    seen = {}                  # value -> index
    for i, x in enumerate(nums):
        need = target - x
        if need in seen:       # CHECK before storing
            return [seen[need], i]
        seen[x] = i            # UPDATE for future iterations
    return []`,
    },
    complexity: [
      { approach: "Brute force (nested loop)", time: "O(n²)", space: "O(1)" },
      { approach: "Hash map (one pass)", time: "O(n)", space: "O(n)" },
    ],
    pitfalls: [
      "Updating the map BEFORE checking — you can match an element with itself.",
      "Using a value as a key when duplicates exist and you needed indices (store lists).",
      "Forgetting that dict iteration order ≠ sorted order if you later need ordering.",
    ],
    problems: [
      { name: "Two Sum", difficulty: "easy", note: "complement lookup" },
      { name: "Contains Duplicate", difficulty: "easy", note: "set membership" },
      { name: "Valid Anagram", difficulty: "easy", note: "frequency map" },
      { name: "Group Anagrams", difficulty: "medium", note: "sorted-string key" },
      { name: "Top K Frequent Elements", difficulty: "medium", note: "count + bucket" },
      { name: "Longest Consecutive Sequence", difficulty: "medium", note: "set + walk runs" },
    ],
    related: ["two-pointers", "sliding-window", "heap-priority-queue"],
    visualizer: "hashmap",
  },

  {
    id: "two-pointers",
    name: "Two Pointers",
    icon: "👉👈",
    color: "#4ade80",
    tagline: "Two indices crawling a sorted/symmetric structure — no nested loop.",
    order: 2,
    level: "foundational",
    intuition: [
      "When data is sorted (or symmetric, like a palindrome), you don't need to try every pair. The sortedness tells you which direction to move: if the current pair's sum is too big, the only way to shrink it is to move the right pointer left.",
      "Each pointer moves monotonically and never backtracks, so together they touch each element at most once — O(n) instead of O(n²). You're using the structure of the data to throw away whole ranges of impossible answers in one step.",
      "The trick is realizing that moving a pointer is a *decision*: it permanently discards every pair that pointer could have formed on that side. That's only safe when sortedness guarantees those pairs can't be the answer.",
    ],
    mentalModel:
      "Two people walking toward each other across a sorted shelf, each step ruling out everything behind them.",
    recognize: [
      "Input is sorted, or you can sort it cheaply.",
      "You want pairs/triplets with a target sum, or to compare ends inward (palindrome).",
      "\"Remove duplicates in place\", \"move zeroes\", partitioning around a value.",
      "Brute force is O(n²) pairs but sortedness gives a direction to prune.",
    ],
    howItWorks: [
      "Place pointers at the two ends (converging) or both at the start (fast/slow, same direction).",
      "Evaluate the pair. Compare against the target / condition.",
      "Move the pointer that makes progress: too small → move left up; too big → move right down.",
      "Stop when pointers cross. For triplets, fix one element and two-pointer the rest.",
    ],
    template: {
      lang: "python",
      label: "Two Sum II (sorted) — converging pointers",
      code: `def two_sum_sorted(nums, target):
    lo, hi = 0, len(nums) - 1
    while lo < hi:
        s = nums[lo] + nums[hi]
        if s == target:
            return [lo, hi]
        elif s < target:
            lo += 1            # need bigger → move left pointer up
        else:
            hi -= 1            # need smaller → move right pointer down
    return []`,
    },
    complexity: [
      { approach: "Brute force pairs", time: "O(n²)", space: "O(1)" },
      { approach: "Two pointers (sorted)", time: "O(n)", space: "O(1)" },
      { approach: "3Sum (fix one + 2pt)", time: "O(n²)", space: "O(1)" },
    ],
    pitfalls: [
      "Forgetting to skip duplicates in 3Sum → repeated triplets.",
      "Using two pointers on UNSORTED data when the logic relies on order.",
      "Off-by-one at the crossing condition (`lo < hi` vs `lo <= hi`).",
    ],
    problems: [
      { name: "Valid Palindrome", difficulty: "easy", note: "ends inward" },
      { name: "Two Sum II", difficulty: "medium", note: "converging on sorted" },
      { name: "3Sum", difficulty: "medium", note: "fix one + two-pointer" },
      { name: "Container With Most Water", difficulty: "medium", note: "greedy width vs height" },
      { name: "Trapping Rain Water", difficulty: "hard", note: "max-from-each-side" },
    ],
    related: ["arrays-hashing", "sliding-window", "binary-search"],
    visualizer: "twopointers",
  },

  {
    id: "sliding-window",
    name: "Sliding Window",
    icon: "🪟",
    color: "#fbbf24",
    tagline: "A contiguous range that grows and shrinks instead of restarting.",
    order: 3,
    level: "core",
    intuition: [
      "Problems about the best/longest/shortest *contiguous* subarray scream O(n²): try every start, extend every end. But notice that when you slide a window forward by one, most of it is unchanged — only one element enters and one leaves.",
      "So instead of recomputing the window from scratch, you maintain a running summary (a sum, a count, a frequency map) and update it incrementally. The window's left and right edges each move forward at most n times total → O(n).",
      "The art is the shrink condition: you grow the right edge greedily, and the moment the window becomes invalid (sum too big, a duplicate appeared) you shrink from the left until it's valid again. Both edges only ever move right.",
    ],
    mentalModel:
      "A camera panning across a row of houses: as it reveals a new house on the right it loses one on the left — you never re-scan the whole street.",
    recognize: [
      "\"Longest/shortest/maximum substring or subarray that satisfies…\".",
      "The answer is CONTIGUOUS (a window), not an arbitrary subset.",
      "A constraint you can maintain incrementally: sum ≤ k, ≤ k distinct chars, no repeats.",
      "Brute force enumerates all subarrays — but adjacent windows overlap heavily.",
    ],
    howItWorks: [
      "Two pointers `left` and `right` define `[left, right]`. Both start at 0.",
      "Expand: move `right` and add the new element to your running state.",
      "Contract: while the window is invalid, remove `nums[left]` and move `left` up.",
      "After each step the window is valid — record its size/sum as a candidate answer.",
    ],
    template: {
      lang: "python",
      label: "Longest substring w/o repeats — variable window",
      code: `def longest_unique(s):
    seen = set()
    left = best = 0
    for right, ch in enumerate(s):
        while ch in seen:          # invalid → shrink from left
            seen.remove(s[left])
            left += 1
        seen.add(ch)               # window [left..right] now valid
        best = max(best, right - left + 1)
    return best`,
    },
    complexity: [
      { approach: "Brute force (all subarrays)", time: "O(n²) – O(n³)", space: "O(1)" },
      { approach: "Sliding window", time: "O(n)", space: "O(k) state" },
    ],
    pitfalls: [
      "Shrinking with `if` when you need `while` — one removal may not restore validity.",
      "Recording the answer before re-validating the window.",
      "Fixed-size windows: forgetting to pop the element leaving on the left.",
    ],
    problems: [
      { name: "Best Time to Buy/Sell Stock", difficulty: "easy", note: "min-so-far window" },
      { name: "Longest Substring Without Repeats", difficulty: "medium", note: "variable window" },
      { name: "Longest Repeating Char Replacement", difficulty: "medium", note: "window − maxFreq ≤ k" },
      { name: "Permutation in String", difficulty: "medium", note: "fixed window + counts" },
      { name: "Minimum Window Substring", difficulty: "hard", note: "expand then minimize" },
    ],
    related: ["two-pointers", "arrays-hashing"],
    visualizer: "slidingwindow",
  },

  {
    id: "stack",
    name: "Stack",
    icon: "🥞",
    color: "#fb7185",
    tagline: "Defer work until you have the context to resolve it (LIFO).",
    order: 4,
    level: "core",
    intuition: [
      "A stack shines when the thing you're processing now can only be *resolved later*, and the most-recently-deferred item is always the first you'll be able to close. That last-in-first-out order matches nesting: the last opening bracket is the first that must close.",
      "For \"next greater element\" style problems, a monotonic stack keeps a tidy list of candidates still waiting for their answer. When a new element arrives it resolves every smaller pending candidate at once, then waits its own turn.",
      "The payoff: each element is pushed and popped at most once, so even though it *feels* like nested searching, the total work is O(n).",
    ],
    mentalModel:
      "A stack of plates — or a pile of unanswered emails where you always reply to the newest one first because it unblocks the older ones.",
    recognize: [
      "Matching / nesting: parentheses, tags, undo history.",
      "\"Next greater / next smaller / nearest …\" → monotonic stack.",
      "You need to remember a sequence of pending items and pop the latest.",
      "Evaluating expressions, simplifying paths, or simulating recursion iteratively.",
    ],
    howItWorks: [
      "Iterate left to right, pushing items (or indices) you can't resolve yet.",
      "On each new item, decide: does it close / resolve what's on top of the stack?",
      "If yes, pop and resolve — repeat while the top is resolvable (monotonic case).",
      "Whatever remains on the stack at the end never found its match/answer.",
    ],
    template: {
      lang: "python",
      label: "Next Greater Element — monotonic decreasing stack",
      code: `def next_greater(nums):
    res = [-1] * len(nums)
    stack = []                     # holds indices waiting for a bigger value
    for i, x in enumerate(nums):
        while stack and nums[stack[-1]] < x:
            res[stack.pop()] = x   # x is the answer for everything smaller
        stack.append(i)
    return res`,
    },
    complexity: [
      { approach: "Brute force (scan ahead)", time: "O(n²)", space: "O(1)" },
      { approach: "Monotonic stack", time: "O(n)", space: "O(n)" },
    ],
    pitfalls: [
      "Pushing values when you actually need indices (for distances/positions).",
      "Wrong monotonic direction (increasing vs decreasing) for the comparison you want.",
      "Forgetting to handle the leftover stack after the loop.",
    ],
    problems: [
      { name: "Valid Parentheses", difficulty: "easy", note: "matching pairs" },
      { name: "Min Stack", difficulty: "medium", note: "track min alongside" },
      { name: "Evaluate RPN", difficulty: "medium", note: "operand stack" },
      { name: "Daily Temperatures", difficulty: "medium", note: "monotonic indices" },
      { name: "Largest Rectangle in Histogram", difficulty: "hard", note: "increasing stack" },
    ],
    related: ["arrays-hashing", "trees"],
    visualizer: "stack",
  },

  {
    id: "binary-search",
    name: "Binary Search",
    icon: "🎯",
    color: "#22d3ee",
    tagline: "Halve the search space every step — O(log n).",
    order: 5,
    level: "core",
    intuition: [
      "If you can answer \"is the answer ≤ this guess?\" and that answer is *monotonic* (false, false, …, true, true), you never need to check every value. One probe in the middle tells you which half to throw away.",
      "Binary search isn't just for sorted arrays. The real requirement is a monotonic predicate over a range. \"Minimum capacity to ship in D days\", \"smallest divisor\", \"can we split into k parts\" — all are binary search on the *answer*, not the input.",
      "Every step halves the candidates, so even a billion-element space resolves in ~30 probes. The hard part is never the halving — it's defining the predicate and getting the boundary updates exactly right.",
    ],
    mentalModel:
      "Guessing a number 1–100 where each guess is told 'higher' or 'lower'. You'd never guess linearly — you'd halve.",
    recognize: [
      "Sorted input, or a value range with a monotonic yes/no property.",
      "\"Find the minimum/maximum X such that condition holds\".",
      "Time limit demands O(log n) — n is huge but the answer space is bounded.",
      "Rotated sorted array, find peak, search a matrix.",
    ],
    howItWorks: [
      "Define `lo`, `hi` over the search space and a predicate `ok(mid)`.",
      "Loop while `lo < hi`: compute `mid` (guard overflow with `lo + (hi-lo)//2`).",
      "If `ok(mid)`, the answer is at `mid` or left → `hi = mid`; else `lo = mid + 1`.",
      "When `lo == hi` you've cornered the boundary — that's your answer.",
    ],
    template: {
      lang: "python",
      label: "Binary search on the answer (lower bound)",
      code: `def lower_bound(lo, hi, ok):
    # smallest x in [lo, hi] with ok(x) True; predicate is monotonic
    while lo < hi:
        mid = lo + (hi - lo) // 2
        if ok(mid):
            hi = mid           # answer is mid or to the left
        else:
            lo = mid + 1       # mid too small, go right
    return lo`,
    },
    complexity: [
      { approach: "Linear scan", time: "O(n)", space: "O(1)" },
      { approach: "Binary search", time: "O(log n)", space: "O(1)" },
      { approach: "Binary search on answer", time: "O(n log(range))", space: "O(1)" },
    ],
    pitfalls: [
      "Infinite loop from `lo = mid` without a `+1` (mid can equal lo).",
      "Mixing `<` and `<=` inconsistently between the loop and updates.",
      "Searching values when you should search the answer space (capacity/threshold problems).",
    ],
    problems: [
      { name: "Binary Search", difficulty: "easy", note: "the canonical form" },
      { name: "Search a 2D Matrix", difficulty: "medium", note: "flatten to 1D index" },
      { name: "Koko Eating Bananas", difficulty: "medium", note: "search on answer" },
      { name: "Find Min in Rotated Array", difficulty: "medium", note: "compare to ends" },
      { name: "Median of Two Sorted Arrays", difficulty: "hard", note: "partition search" },
    ],
    related: ["two-pointers", "arrays-hashing"],
    visualizer: "binarysearch",
  },

  {
    id: "linked-list",
    name: "Linked List",
    icon: "🔗",
    color: "#a78bfa",
    tagline: "Rewire pointers in place — and let two speeds reveal structure.",
    order: 6,
    level: "core",
    intuition: [
      "A linked list gives you no random access — only \"next\". So the moves are all about pointer surgery: to reverse, you flip each `next` to point backward while carefully holding onto the node you'd otherwise lose.",
      "The fast/slow (tortoise & hare) trick is the second superpower. Move one pointer twice as fast as the other and geometry does the rest: the slow one lands on the middle, and if there's a cycle the fast one *must* eventually lap it.",
      "A dummy/sentinel head node removes nearly all the edge-case pain (empty list, deleting the head) because every real node now has a predecessor to point at.",
    ],
    mentalModel:
      "A scavenger hunt where each clue points to the next location. A reverse is rewriting every clue to point back; two runners at different speeds find the midpoint and detect loops.",
    recognize: [
      "Reverse a list / sublist, reorder, merge sorted lists.",
      "\"Find the middle\", \"detect a cycle\", \"nth node from the end\".",
      "In-place O(1) space pointer manipulation is required.",
      "Edge cases around the head suggest a dummy node.",
    ],
    howItWorks: [
      "Reversal: keep `prev`, `curr`; each step save `nxt = curr.next`, set `curr.next = prev`, advance both.",
      "Fast/slow: advance `slow` by 1 and `fast` by 2; when `fast` hits the end, `slow` is the middle.",
      "Cycle: if fast ever equals slow, there's a loop; reset one to head to find the entry.",
      "Use a dummy node when the head itself may be inserted/removed.",
    ],
    template: {
      lang: "python",
      label: "Reverse a linked list (iterative)",
      code: `def reverse(head):
    prev, curr = None, head
    while curr:
        nxt = curr.next        # save the rest of the list
        curr.next = prev       # flip the pointer backward
        prev = curr            # advance window
        curr = nxt
    return prev                # new head`,
    },
    complexity: [
      { approach: "Reverse / traverse", time: "O(n)", space: "O(1)" },
      { approach: "Fast & slow (mid/cycle)", time: "O(n)", space: "O(1)" },
    ],
    pitfalls: [
      "Losing the rest of the list by overwriting `next` before saving it.",
      "Off-by-one with fast/slow (`fast and fast.next` guard) on even-length lists.",
      "Not using a dummy head and then special-casing the first node everywhere.",
    ],
    problems: [
      { name: "Reverse Linked List", difficulty: "easy", note: "prev/curr/next" },
      { name: "Merge Two Sorted Lists", difficulty: "easy", note: "dummy + splice" },
      { name: "Linked List Cycle", difficulty: "easy", note: "Floyd's tortoise/hare" },
      { name: "Reorder List", difficulty: "medium", note: "mid + reverse + merge" },
      { name: "LRU Cache", difficulty: "medium", note: "hashmap + doubly list" },
    ],
    related: ["two-pointers", "trees"],
    visualizer: "linkedlist",
  },

  {
    id: "trees",
    name: "Trees & BSTs",
    icon: "🌳",
    color: "#34d399",
    tagline: "Recurse: solve a node by trusting the answers from its children.",
    order: 7,
    level: "core",
    intuition: [
      "A tree is self-similar: each subtree is itself a tree. So almost every tree problem reduces to one question — \"if my children already gave me their answers, how do I combine them into mine?\" That's the recursive leap of faith.",
      "Traversal order is the second axis. DFS (pre/in/post-order) dives deep first; BFS (level-order) sweeps breadth-first with a queue. In-order on a BST is special: it visits nodes in sorted order, which unlocks validation and kth-smallest.",
      "Because a BST keeps left < node < right, you can binary-search it: at each node you discard an entire subtree, turning O(n) searches into O(h).",
    ],
    mentalModel:
      "A company org chart: to total a department's headcount you ask each direct report for their subtree's count and add them up — you never count individuals yourself.",
    recognize: [
      "Hierarchical data, parent/child relationships.",
      "\"Depth/height\", \"path sum\", \"is balanced\", \"lowest common ancestor\".",
      "Sorted-order needs on a BST → in-order traversal.",
      "\"Level by level\" / \"shortest path in unweighted tree\" → BFS.",
    ],
    howItWorks: [
      "Define the recursion on a node: base case is usually `None` (return 0 / True / etc.).",
      "Recurse into left and right, getting their results.",
      "Combine: e.g. `height = 1 + max(left, right)`; `valid = left and right and node-check`.",
      "For BFS, push the root in a queue and process one full level per outer iteration.",
    ],
    template: {
      lang: "python",
      label: "Max depth (post-order DFS)",
      code: `def max_depth(node):
    if not node:
        return 0
    left = max_depth(node.left)    # trust the children
    right = max_depth(node.right)
    return 1 + max(left, right)    # combine into my answer`,
    },
    complexity: [
      { approach: "DFS / BFS traversal", time: "O(n)", space: "O(h) – O(n)" },
      { approach: "BST search / insert", time: "O(h) ≈ O(log n) balanced", space: "O(h)" },
    ],
    pitfalls: [
      "Missing the `None` base case → crash on leaves' children.",
      "Validating a BST by comparing only parent–child, not carrying min/max bounds.",
      "Recursion depth blowing the stack on skewed trees (consider iterative).",
    ],
    problems: [
      { name: "Invert Binary Tree", difficulty: "easy", note: "swap + recurse" },
      { name: "Maximum Depth", difficulty: "easy", note: "post-order combine" },
      { name: "Validate BST", difficulty: "medium", note: "min/max bounds" },
      { name: "Level Order Traversal", difficulty: "medium", note: "BFS queue" },
      { name: "Lowest Common Ancestor", difficulty: "medium", note: "split point" },
      { name: "Binary Tree Max Path Sum", difficulty: "hard", note: "gain vs through-path" },
    ],
    related: ["tries", "graphs", "backtracking", "heap-priority-queue"],
    visualizer: "treetraversal",
  },

  {
    id: "tries",
    name: "Tries (Prefix Trees)",
    icon: "🌲",
    color: "#f472b6",
    tagline: "Share common prefixes so lookups cost word length, not count.",
    order: 8,
    level: "advanced",
    intuition: [
      "If you store words in a set, asking \"which words start with 'app'?\" forces you to scan every word. A trie instead branches one character at a time, so all words sharing a prefix share the same path — the prefix is stored once.",
      "Each node is a junction with up to 26 children and a flag for \"a word ends here\". Walking down k characters costs O(k) regardless of how many words are in the structure. Insert, search, and prefix-match all become O(word length).",
      "Tries turn 'autocomplete', 'spell-check', and 'wildcard match' from set-scans into tree-walks, and they pair beautifully with DFS/backtracking for board-search problems.",
    ],
    mentalModel:
      "A library where books are filed letter-by-letter down the hallways; everything starting with 'AP' lives down the same corridor, so finding a shelf never depends on how many books exist.",
    recognize: [
      "Many strings sharing prefixes; repeated prefix/word queries.",
      "\"Implement autocomplete / startsWith / wildcard search\".",
      "Word-search on a grid where you prune dead prefixes early.",
      "You'd otherwise re-scan a whole dictionary per query.",
    ],
    howItWorks: [
      "Each node holds a map `children[char] → node` and `is_end` flag.",
      "Insert: walk/create a child per character, set `is_end` on the last node.",
      "Search: walk the children; a missing child = not present. Word needs `is_end`.",
      "Prefix query: same walk, but you don't require `is_end` at the end.",
    ],
    template: {
      lang: "python",
      label: "Trie insert + search",
      code: `class Trie:
    def __init__(self):
        self.root = {}

    def insert(self, word):
        node = self.root
        for ch in word:
            node = node.setdefault(ch, {})
        node["#"] = True           # word-end marker

    def search(self, word, prefix=False):
        node = self.root
        for ch in word:
            if ch not in node:
                return False
            node = node[ch]
        return True if prefix else "#" in node`,
    },
    complexity: [
      { approach: "Set / list of words scan", time: "O(N·k) per query", space: "O(N·k)" },
      { approach: "Trie", time: "O(k) per op", space: "O(total chars)" },
    ],
    pitfalls: [
      "Forgetting the end-of-word marker → 'app' falsely matches when only 'apple' was added.",
      "Confusing `search` (needs end flag) with `startsWith` (doesn't).",
      "Memory blowup if you allocate a fixed 26-array per node for sparse data.",
    ],
    problems: [
      { name: "Implement Trie", difficulty: "medium", note: "insert/search/startsWith" },
      { name: "Design Add & Search Words", difficulty: "medium", note: "'.' wildcard via DFS" },
      { name: "Word Search II", difficulty: "hard", note: "trie + grid backtracking" },
    ],
    related: ["trees", "backtracking", "arrays-hashing"],
    visualizer: "trie",
  },

  {
    id: "heap-priority-queue",
    name: "Heap / Priority Queue",
    icon: "⛏️",
    color: "#f59e0b",
    tagline: "Always grab the current min/max in O(log n) without full sorting.",
    order: 9,
    level: "core",
    intuition: [
      "When you only ever need the *single smallest or largest* element right now — and the set keeps changing — fully sorting is overkill. A heap keeps just enough order to surface the extreme in O(1) and re-balance after a pop in O(log n).",
      "For \"top K\" problems the move is counter-intuitive: to find the K largest, keep a min-heap of size K. The smallest of your current top-K sits at the root, so any new element only has to beat *that* to earn a spot. You never sort the whole input.",
      "Heaps also power 'merge K sorted lists' and streaming medians — anywhere you repeatedly pull the next-best item from a shifting pool.",
    ],
    mentalModel:
      "An ER triage queue: patients aren't fully sorted, but the most urgent one is always next, and inserting a new patient just bubbles them to the right depth.",
    recognize: [
      "\"Top K\", \"K closest\", \"K largest/smallest\", \"Kth element\".",
      "\"Merge K sorted …\" or repeatedly pull the next-smallest from many sources.",
      "Running/streaming median, scheduling by priority.",
      "You need the extreme repeatedly, but a full sort each time is too slow.",
    ],
    howItWorks: [
      "Push items onto a binary heap (Python's `heapq` is a min-heap).",
      "For max-heap behavior, push negatives (or use a key wrapper).",
      "Top-K: maintain a size-K min-heap; if it exceeds K, pop the smallest.",
      "Merge-K: seed the heap with each list's head, pop the min, push that list's next.",
    ],
    template: {
      lang: "python",
      label: "K largest — size-K min-heap",
      code: `import heapq

def k_largest(nums, k):
    heap = []                      # min-heap of the best k so far
    for x in nums:
        heapq.heappush(heap, x)
        if len(heap) > k:
            heapq.heappop(heap)    # drop the smallest of the top-k
    return heap                    # heap[0] is the kth largest`,
    },
    complexity: [
      { approach: "Sort then slice", time: "O(n log n)", space: "O(n)" },
      { approach: "Size-K heap", time: "O(n log k)", space: "O(k)" },
      { approach: "Heapify all", time: "O(n) build + O(k log n) pops", space: "O(n)" },
    ],
    pitfalls: [
      "Forgetting Python's heap is a MIN-heap; negate for max behavior.",
      "Letting the heap grow to size n when size k suffices (loses the win).",
      "Comparing un-orderable tuples — add a tiebreaker index.",
    ],
    problems: [
      { name: "Kth Largest in a Stream", difficulty: "easy", note: "size-K heap" },
      { name: "Last Stone Weight", difficulty: "easy", note: "max-heap sim" },
      { name: "K Closest Points to Origin", difficulty: "medium", note: "heap by distance" },
      { name: "Task Scheduler", difficulty: "medium", note: "greedy + counts" },
      { name: "Find Median from Data Stream", difficulty: "hard", note: "two heaps" },
      { name: "Merge K Sorted Lists", difficulty: "hard", note: "heap of heads" },
    ],
    related: ["arrays-hashing", "greedy", "trees"],
    visualizer: "heap",
  },

  {
    id: "backtracking",
    name: "Backtracking",
    icon: "🧭",
    color: "#c084fc",
    tagline: "Build candidates incrementally; undo and try the next branch.",
    order: 10,
    level: "advanced",
    intuition: [
      "Backtracking is brute force that's polite about it: you build a solution one choice at a time, and the instant a partial choice can't possibly lead to a valid answer, you abandon that whole branch instead of finishing it.",
      "Picture a decision tree. At each node you 'choose' an option, recurse deeper, then 'un-choose' it before trying the next option. That choose → explore → un-choose rhythm is the entire pattern; the un-choose is what lets one shared state object visit every branch.",
      "Pruning is where it earns its keep. Skipping duplicates, bounding by a target, or checking validity early can cut the tree from exponential-in-practice to manageable.",
    ],
    mentalModel:
      "Exploring a maze with chalk: you mark your path, hit a dead end, then erase back to the last junction and try a different turn.",
    recognize: [
      "\"Generate all subsets / permutations / combinations\".",
      "\"Find all solutions that…\", constraint puzzles (N-Queens, Sudoku).",
      "Partitioning a string, word search on a grid, combination sum.",
      "The answer is a *set of arrangements*, not a single number.",
    ],
    howItWorks: [
      "Define state: the partial candidate (a path) and what choices remain.",
      "Base case: path is complete → record a copy of it.",
      "Loop over choices: make a choice (append), recurse, then undo (pop).",
      "Prune: skip choices that violate constraints or duplicate earlier branches.",
    ],
    template: {
      lang: "python",
      label: "Subsets — choose / explore / un-choose",
      code: `def subsets(nums):
    res, path = [], []
    def backtrack(start):
        res.append(path[:])            # record a copy of current subset
        for i in range(start, len(nums)):
            path.append(nums[i])       # choose
            backtrack(i + 1)           # explore
            path.pop()                 # un-choose
    backtrack(0)
    return res`,
    },
    complexity: [
      { approach: "Subsets", time: "O(n·2ⁿ)", space: "O(n) depth" },
      { approach: "Permutations", time: "O(n·n!)", space: "O(n) depth" },
      { approach: "With pruning", time: "≪ worst case in practice", space: "O(n)" },
    ],
    pitfalls: [
      "Appending the path itself instead of a COPY (`path[:]`) — all results alias.",
      "Forgetting to undo the choice → state leaks into sibling branches.",
      "Not sorting + skipping duplicates when the output must be unique.",
    ],
    problems: [
      { name: "Subsets", difficulty: "medium", note: "include/exclude tree" },
      { name: "Combination Sum", difficulty: "medium", note: "reuse + prune by target" },
      { name: "Permutations", difficulty: "medium", note: "used[] set" },
      { name: "Word Search", difficulty: "medium", note: "grid DFS + visited" },
      { name: "N-Queens", difficulty: "hard", note: "column/diagonal constraints" },
    ],
    related: ["trees", "tries", "graphs", "dp-1d"],
    visualizer: "backtracking",
  },

  {
    id: "graphs",
    name: "Graphs (BFS / DFS)",
    icon: "🕸️",
    color: "#60a5fa",
    tagline: "Explore nodes and edges — flood fill, reachability, shortest hops.",
    order: 11,
    level: "advanced",
    intuition: [
      "A graph is just nodes connected by edges, and grids/matrices are graphs in disguise (each cell links to its neighbors). Most problems boil down to one question: starting here, what can I reach — and how do I avoid going in circles?",
      "DFS dives down one path as far as it can, great for connectivity, counting components, and flood fill. BFS expands in rings of equal distance, which makes it the tool for shortest path in an *unweighted* graph: the first time you reach a node is via the fewest edges.",
      "The single most important detail is the `visited` set. Without it you revisit nodes forever; with it, every node and edge is touched once → O(V + E).",
    ],
    mentalModel:
      "Spilling water on a floor: BFS is the ripple spreading out in even circles; DFS is following one crack as deep as it goes before backing up.",
    recognize: [
      "Grids/matrices ('islands', 'rotting oranges', 'flood fill').",
      "\"Number of connected components / regions\".",
      "Shortest path in steps on an UNWEIGHTED graph → BFS.",
      "Reachability, course prerequisites (later: topological sort).",
    ],
    howItWorks: [
      "Model the graph: adjacency list, or compute neighbors on the fly for grids.",
      "Pick BFS (queue, level rings) for shortest hops; DFS (stack/recursion) for reach/components.",
      "Mark a node visited when you enqueue/visit it — never after, or you double-count.",
      "Process neighbors; multi-source BFS seeds the queue with several starts at once.",
    ],
    template: {
      lang: "python",
      label: "BFS shortest path on a grid",
      code: `from collections import deque

def bfs(grid, start):
    R, C = len(grid), len(grid[0])
    q = deque([(start, 0)])            # (cell, distance)
    seen = {start}
    while q:
        (r, c), d = q.popleft()
        for dr, dc in ((1,0),(-1,0),(0,1),(0,-1)):
            nr, nc = r + dr, c + dc
            if 0 <= nr < R and 0 <= nc < C and (nr,nc) not in seen \\
               and grid[nr][nc] == 0:
                seen.add((nr, nc))     # mark on enqueue
                q.append(((nr, nc), d + 1))
    return seen`,
    },
    complexity: [
      { approach: "BFS / DFS traversal", time: "O(V + E)", space: "O(V)" },
      { approach: "Grid (R×C)", time: "O(R·C)", space: "O(R·C)" },
    ],
    pitfalls: [
      "Marking visited too late (after dequeue) → same node enqueued many times.",
      "Using DFS for shortest path in an unweighted graph (use BFS).",
      "Off-grid index errors — bounds-check neighbors before access.",
    ],
    problems: [
      { name: "Number of Islands", difficulty: "medium", note: "flood fill components" },
      { name: "Clone Graph", difficulty: "medium", note: "DFS + hashmap copy" },
      { name: "Rotting Oranges", difficulty: "medium", note: "multi-source BFS" },
      { name: "Course Schedule", difficulty: "medium", note: "cycle detect / topo" },
      { name: "Pacific Atlantic Water Flow", difficulty: "medium", note: "reverse BFS from edges" },
    ],
    related: ["trees", "advanced-graphs", "backtracking"],
    visualizer: "graph",
  },

  {
    id: "advanced-graphs",
    name: "Advanced Graphs",
    icon: "🛰️",
    color: "#818cf8",
    tagline: "Weighted shortest paths, MST, topological order, union-find.",
    order: 12,
    level: "advanced",
    intuition: [
      "Once edges have *weights* or you need global structure, plain BFS/DFS isn't enough. Dijkstra generalizes BFS by always expanding the closest-so-far node (a min-heap replaces the queue) — it's BFS that respects edge cost.",
      "Topological sort orders tasks so every prerequisite comes first; it's just repeatedly taking nodes with no remaining incoming edges (Kahn's algorithm) or a post-order DFS. Union-Find (DSU) answers \"are these in the same group?\" and underlies Kruskal's MST.",
      "These are recipes more than insights: recognize the sub-problem (shortest weighted path, min spanning tree, ordering with dependencies, dynamic connectivity) and reach for the matching tool.",
    ],
    mentalModel:
      "A subway map with travel times: Dijkstra is the ticket machine always extending the cheapest route first; topological sort is the morning checklist where you can't pour coffee before boiling water.",
    recognize: [
      "Weighted edges + shortest/cheapest path → Dijkstra (no negatives) / Bellman-Ford.",
      "Dependencies / ordering / 'can finish all courses' → topological sort.",
      "\"Connect all at min cost\", redundant connection → MST / Union-Find.",
      "Repeated 'are these connected?' merges → Union-Find (DSU).",
    ],
    howItWorks: [
      "Dijkstra: min-heap of (dist, node); pop the closest, relax its neighbors, skip stale entries.",
      "Topo (Kahn): compute in-degrees, queue all zero-in-degree, pop & decrement neighbors.",
      "Union-Find: `find` with path compression, `union` by rank; same root ⇒ connected.",
      "Kruskal: sort edges, add the cheapest that doesn't form a cycle (via DSU).",
    ],
    template: {
      lang: "python",
      label: "Dijkstra — shortest weighted path",
      code: `import heapq

def dijkstra(graph, src):              # graph: node -> [(nbr, weight)]
    dist = {src: 0}
    pq = [(0, src)]                    # (distance, node)
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, float('inf')):
            continue                   # stale entry
        for v, w in graph[u]:
            nd = d + w
            if nd < dist.get(v, float('inf')):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    return dist`,
    },
    complexity: [
      { approach: "Dijkstra (heap)", time: "O(E log V)", space: "O(V)" },
      { approach: "Topological sort", time: "O(V + E)", space: "O(V)" },
      { approach: "Union-Find (amortized)", time: "≈ O(α(n)) per op", space: "O(n)" },
    ],
    pitfalls: [
      "Using Dijkstra with negative edges (use Bellman-Ford instead).",
      "Forgetting to skip stale heap entries → wrong/slow results.",
      "Topological sort on a graph with a cycle — detect it (count processed < V).",
    ],
    problems: [
      { name: "Network Delay Time", difficulty: "medium", note: "Dijkstra" },
      { name: "Course Schedule II", difficulty: "medium", note: "topological order" },
      { name: "Min Cost to Connect Points", difficulty: "medium", note: "MST / Prim" },
      { name: "Redundant Connection", difficulty: "medium", note: "union-find cycle" },
      { name: "Cheapest Flights K Stops", difficulty: "medium", note: "Bellman-Ford / BFS" },
      { name: "Swim in Rising Water", difficulty: "hard", note: "Dijkstra on max-edge" },
    ],
    related: ["graphs", "heap-priority-queue", "greedy"],
    visualizer: "dijkstra",
  },

  {
    id: "dp-1d",
    name: "1-D Dynamic Programming",
    icon: "📈",
    color: "#2dd4bf",
    tagline: "Cache overlapping subproblems along a single dimension.",
    order: 13,
    level: "advanced",
    intuition: [
      "DP applies when a problem has *overlapping subproblems* (the same smaller question gets asked again and again) and *optimal substructure* (the best answer is built from best answers to those smaller questions). Plain recursion re-solves them; DP solves each once and remembers it.",
      "The whole craft is finding the recurrence: `dp[i]` in terms of earlier `dp` values. Climbing stairs is `dp[i] = dp[i-1] + dp[i-2]`; house robber is `dp[i] = max(dp[i-1], dp[i-2] + nums[i])`. Define what `dp[i]` *means* in words first, then the transition usually falls out.",
      "Start top-down (recursion + memo) because it mirrors the natural problem statement, then optionally flip to bottom-up (a loop filling a table) for speed and to drop recursion overhead — often collapsing space to a couple of variables.",
    ],
    mentalModel:
      "Climbing stairs while writing each step's count on a sticky note, so you never recount how many ways reach a step you've already solved.",
    recognize: [
      "\"In how many ways…\", \"max/min total…\", \"can you reach/make…\".",
      "Choices at each step with overlapping futures (take it or skip it).",
      "A naive recursion is exponential and recomputes the same arguments.",
      "Linear input where state depends on the previous one or two positions.",
    ],
    howItWorks: [
      "Define `dp[i]` precisely in English — half the battle.",
      "Write the recurrence: how does `dp[i]` use `dp[i-1]`, `dp[i-2]`, …?",
      "Set base cases (`dp[0]`, `dp[1]`) and the iteration direction.",
      "Optimize space: if only the last k entries are used, keep k variables.",
    ],
    template: {
      lang: "python",
      label: "House Robber — take or skip, O(1) space",
      code: `def rob(nums):
    prev2 = prev1 = 0              # best up to i-2 and i-1
    for x in nums:
        # either skip i (prev1) or take i + best up to i-2
        prev2, prev1 = prev1, max(prev1, prev2 + x)
    return prev1`,
    },
    complexity: [
      { approach: "Naive recursion", time: "O(2ⁿ)", space: "O(n)" },
      { approach: "Memoized / tabulated", time: "O(n)", space: "O(n)" },
      { approach: "Rolling variables", time: "O(n)", space: "O(1)" },
    ],
    pitfalls: [
      "Vague `dp[i]` definition → you can't write a correct recurrence.",
      "Wrong base cases (off-by-one on `dp[0]`/`dp[1]`).",
      "Iterating the wrong direction so a needed value isn't computed yet.",
    ],
    problems: [
      { name: "Climbing Stairs", difficulty: "easy", note: "Fibonacci recurrence" },
      { name: "House Robber", difficulty: "medium", note: "take/skip" },
      { name: "Coin Change", difficulty: "medium", note: "min coins, unbounded" },
      { name: "Longest Increasing Subsequence", difficulty: "medium", note: "dp + binary search" },
      { name: "Word Break", difficulty: "medium", note: "dp over split points" },
      { name: "Decode Ways", difficulty: "medium", note: "one/two digit choices" },
    ],
    related: ["dp-2d", "backtracking", "greedy"],
    visualizer: "dp1d",
  },

  {
    id: "dp-2d",
    name: "2-D Dynamic Programming",
    icon: "🧮",
    color: "#5eead4",
    tagline: "A grid of subproblems — two changing dimensions.",
    order: 14,
    level: "advanced",
    intuition: [
      "When the state needs *two* indices to describe — position in string A and string B, row and column, item index and remaining capacity — the DP table becomes a grid. Each cell `dp[i][j]` answers the subproblem for that pair.",
      "The recurrence relates a cell to its neighbors: typically the cell above, to the left, and/or the diagonal. Edit distance and LCS compare `A[i]` with `B[j]`; if they match you extend the diagonal, otherwise you take the best of skipping one character.",
      "Drawing the grid and filling a tiny example by hand is the fastest way to *see* the transition. Once the dependencies are clear, the loop order and base row/column follow directly — and you can often compress to a single row.",
    ],
    mentalModel:
      "Aligning two sequences on graph paper: each square asks 'do these two letters match?' and inherits the best score from its top, left, or diagonal neighbor.",
    recognize: [
      "Two strings/arrays compared (LCS, edit distance, interleaving).",
      "Grid path counting / min path sum with movement constraints.",
      "Knapsack-style: item index × remaining capacity.",
      "State genuinely needs two coordinates, not one.",
    ],
    howItWorks: [
      "Define `dp[i][j]` in words — the answer using A[..i] and B[..j].",
      "Write the recurrence from neighbors (top/left/diagonal) and a match test.",
      "Initialize the first row/column (empty-prefix base cases).",
      "Fill in an order that respects dependencies; read the answer at a corner.",
    ],
    template: {
      lang: "python",
      label: "Longest Common Subsequence",
      code: `def lcs(a, b):
    m, n = len(a), len(b)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            if a[i-1] == b[j-1]:
                dp[i][j] = dp[i-1][j-1] + 1        # extend the diagonal
            else:
                dp[i][j] = max(dp[i-1][j], dp[i][j-1])
    return dp[m][n]`,
    },
    complexity: [
      { approach: "Naive recursion", time: "O(2^(m+n))", space: "O(m+n)" },
      { approach: "2-D table", time: "O(m·n)", space: "O(m·n)" },
      { approach: "Rolling row", time: "O(m·n)", space: "O(min(m,n))" },
    ],
    pitfalls: [
      "Index confusion between string position and dp index (the +1 offset).",
      "Forgetting to initialize the base row/column.",
      "Compressing to 1-D but overwriting a value still needed this iteration.",
    ],
    problems: [
      { name: "Unique Paths", difficulty: "medium", note: "grid path count" },
      { name: "Longest Common Subsequence", difficulty: "medium", note: "diagonal/match" },
      { name: "Coin Change II", difficulty: "medium", note: "count combinations" },
      { name: "Edit Distance", difficulty: "hard", note: "insert/delete/replace" },
      { name: "Distinct Subsequences", difficulty: "hard", note: "match/skip counts" },
    ],
    related: ["dp-1d", "backtracking"],
    visualizer: "dp2d",
  },

  {
    id: "greedy",
    name: "Greedy",
    icon: "🪙",
    color: "#facc15",
    tagline: "Take the locally best choice — when it's provably globally optimal.",
    order: 15,
    level: "advanced",
    intuition: [
      "Greedy makes the choice that looks best *right now* and never reconsiders. That sounds reckless, and often is — but for certain problems a local optimum is guaranteed to be part of the global optimum, and then greedy is both simplest and fastest.",
      "The classic moves: track a running best (max subarray / Kadane: extend or restart), reach as far as possible (jump game), or sort then sweep. The recurring idea is that a single forward pass with one well-chosen invariant suffices.",
      "The danger is assuming greedy works when it doesn't (coin systems where it fails, knapsack). The discipline is to articulate *why* the local choice can't hurt — an exchange argument — or fall back to DP.",
    ],
    mentalModel:
      "Filling a jar with the biggest rocks first when you can prove the big rocks always fit better — but knowing some puzzles punish that hubris.",
    recognize: [
      "\"Maximum/minimum …\" solvable in one forward sweep.",
      "Kadane-style running max (max subarray), jump/reach problems.",
      "Sort-then-process (activity selection, partition labels).",
      "A clean argument exists that the local optimum stays optimal.",
    ],
    howItWorks: [
      "Identify the greedy choice and the invariant it maintains.",
      "Often: sort the input so the best candidate comes first.",
      "Sweep once, updating a running best / farthest-reach / current group.",
      "Convince yourself (exchange argument) it's optimal — else switch to DP.",
    ],
    template: {
      lang: "python",
      label: "Maximum subarray (Kadane)",
      code: `def max_subarray(nums):
    best = cur = nums[0]
    for x in nums[1:]:
        # extend the current run, or restart fresh at x
        cur = max(x, cur + x)
        best = max(best, cur)
    return best`,
    },
    complexity: [
      { approach: "Greedy single pass", time: "O(n)", space: "O(1)" },
      { approach: "Sort then sweep", time: "O(n log n)", space: "O(1)–O(n)" },
    ],
    pitfalls: [
      "Applying greedy where it's NOT optimal (e.g. coin change with odd denominations).",
      "Forgetting to sort when the greedy order depends on it.",
      "Not proving correctness — greedy that 'seems right' can be subtly wrong.",
    ],
    problems: [
      { name: "Maximum Subarray", difficulty: "medium", note: "Kadane" },
      { name: "Jump Game", difficulty: "medium", note: "farthest reach" },
      { name: "Gas Station", difficulty: "medium", note: "running tank + restart" },
      { name: "Partition Labels", difficulty: "medium", note: "last-seen index" },
      { name: "Hand of Straights", difficulty: "medium", note: "greedy grouping" },
    ],
    related: ["dp-1d", "intervals", "heap-priority-queue"],
    visualizer: "greedy",
  },

  {
    id: "intervals",
    name: "Intervals",
    icon: "📊",
    color: "#fb923c",
    tagline: "Sort by an endpoint, then sweep and compare neighbors.",
    order: 16,
    level: "core",
    intuition: [
      "Interval problems feel tangled until you sort. Once intervals are ordered by start time, overlap becomes a purely local check: an interval can only overlap the one right before it, so a single left-to-right sweep handles merging, counting, and conflict detection.",
      "Two intervals `[a,b]` and `[c,d]` overlap exactly when `a <= d and c <= b`. Memorize that and most logic reduces to comparing the current interval's start with the previous interval's end.",
      "For 'how many rooms / resources at once', sort starts and ends separately (or use a heap of end times) and sweep — the max concurrent count is your answer. It's all sorting plus a tidy invariant.",
    ],
    mentalModel:
      "Booking a meeting room from a calendar: line up requests by start time, then walk down checking only whether each new meeting collides with the one currently in the room.",
    recognize: [
      "Input is a list of `[start, end]` pairs.",
      "\"Merge overlapping\", \"insert interval\", \"can attend all meetings\".",
      "\"Minimum rooms / max concurrent\", \"remove fewest to make non-overlapping\".",
      "Scheduling, calendars, ranges on a number line.",
    ],
    howItWorks: [
      "Sort intervals by start (sometimes by end for greedy removal).",
      "Walk through; keep the 'current' merged interval or last end time.",
      "Overlap? extend the current end (merge) or count a conflict.",
      "No overlap? close the current interval and start a new one.",
    ],
    template: {
      lang: "python",
      label: "Merge overlapping intervals",
      code: `def merge(intervals):
    intervals.sort(key=lambda iv: iv[0])      # sort by start
    merged = [intervals[0]]
    for s, e in intervals[1:]:
        if s <= merged[-1][1]:                # overlaps previous
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged`,
    },
    complexity: [
      { approach: "Sort + sweep", time: "O(n log n)", space: "O(n)" },
      { approach: "Min-rooms (heap of ends)", time: "O(n log n)", space: "O(n)" },
    ],
    pitfalls: [
      "Forgetting to sort first — overlap logic assumes order.",
      "Boundary cases: do touching intervals `[1,2],[2,3]` count as overlapping?",
      "Merging into the wrong end — use `max` for the new end.",
    ],
    problems: [
      { name: "Insert Interval", difficulty: "medium", note: "before/overlap/after" },
      { name: "Merge Intervals", difficulty: "medium", note: "sort + sweep" },
      { name: "Non-overlapping Intervals", difficulty: "medium", note: "greedy by end" },
      { name: "Meeting Rooms", difficulty: "easy", note: "any overlap?" },
      { name: "Meeting Rooms II", difficulty: "medium", note: "min concurrent / heap" },
    ],
    related: ["greedy", "heap-priority-queue", "two-pointers"],
    visualizer: "intervals",
  },

  {
    id: "math-geometry",
    name: "Math & Geometry",
    icon: "📐",
    color: "#a3e635",
    tagline: "Exploit structure: in-place index tricks, simulation, number theory.",
    order: 17,
    level: "core",
    intuition: [
      "These problems reward seeing the hidden structure rather than a single named technique. Rotating a matrix in place, spiraling through it, or detecting overflow are about carefully reasoning over indices and invariants.",
      "Common tools: transform coordinates (rotate = transpose then reverse rows), simulate a process with clear boundaries (spiral with shrinking limits), or use number theory (GCD, digit math, modular arithmetic) and clever array indexing to hit O(1) space.",
      "The meta-skill is converting a visual or numeric operation into precise index arithmetic, then handling boundaries meticulously — small examples on paper beat cleverness here.",
    ],
    mentalModel:
      "A Rubik's-cube mindset: the transformation is mechanical once you find the right sequence of swaps, but you must track every index exactly.",
    recognize: [
      "Matrix rotation/spiral/transpose, set-zeroes-in-place.",
      "Digit manipulation, palindromes of numbers, overflow handling.",
      "GCD/LCM, primes, modular arithmetic, fast power.",
      "\"Do it in O(1) extra space\" via index encoding.",
    ],
    howItWorks: [
      "Find the structural identity (rotate = transpose + reverse each row).",
      "For simulation, define strict boundaries and shrink them as you consume cells.",
      "For O(1) space, encode markers in the array itself (sign bit, first row/col).",
      "Work a 3×3 or small numeric example by hand to nail the index math.",
    ],
    template: {
      lang: "python",
      label: "Rotate matrix 90° in place",
      code: `def rotate(matrix):
    n = len(matrix)
    # 1) transpose across the main diagonal
    for i in range(n):
        for j in range(i + 1, n):
            matrix[i][j], matrix[j][i] = matrix[j][i], matrix[i][j]
    # 2) reverse each row
    for row in matrix:
        row.reverse()`,
    },
    complexity: [
      { approach: "Matrix op (n×n)", time: "O(n²)", space: "O(1) in place" },
      { approach: "Fast exponentiation", time: "O(log n)", space: "O(1)" },
    ],
    pitfalls: [
      "Index errors in transpose (start inner loop at `i+1`, not 0).",
      "Integer overflow when reversing numbers (clamp to 32-bit range).",
      "Mutating while iterating without an in-place plan.",
    ],
    problems: [
      { name: "Rotate Image", difficulty: "medium", note: "transpose + reverse" },
      { name: "Spiral Matrix", difficulty: "medium", note: "shrinking boundaries" },
      { name: "Set Matrix Zeroes", difficulty: "medium", note: "first row/col markers" },
      { name: "Pow(x, n)", difficulty: "medium", note: "fast exponentiation" },
      { name: "Happy Number", difficulty: "easy", note: "cycle detection" },
    ],
    related: ["arrays-hashing", "bit-manipulation"],
    visualizer: "rotate",
  },

  {
    id: "bit-manipulation",
    name: "Bit Manipulation",
    icon: "🔢",
    color: "#38bdf8",
    tagline: "Operate on the binary representation for O(1) tricks.",
    order: 18,
    level: "core",
    intuition: [
      "Numbers are bit patterns, and the bitwise operators (AND, OR, XOR, shifts) let you manipulate all bits at once. The standout is XOR: it's its own inverse (`a ^ a = 0`) and order-independent, so XOR-ing a list cancels every value that appears twice, leaving the unique one.",
      "A handful of idioms cover most problems: `n & (n-1)` clears the lowest set bit (count bits, check powers of two), `n & 1` reads the last bit, and shifting walks across bit positions. These run in O(1) or O(#bits).",
      "The intuition is to ask 'what would the bits do?' — many counting/uniqueness/subset problems have a slick bit answer that sidesteps extra memory entirely.",
    ],
    mentalModel:
      "A row of light switches: XOR is the toggle (flip it twice and you're back), AND/OR are gates, and `n & (n-1)` snuffs out the rightmost lit switch.",
    recognize: [
      "\"Single number\" / find the element that doesn't pair up → XOR.",
      "Count set bits, check power of two, swap without temp.",
      "Generate all subsets via a bitmask, missing number in 0..n.",
      "Constraints scream O(1) space and the data is integer-shaped.",
    ],
    howItWorks: [
      "XOR all elements to cancel pairs and isolate a unique value.",
      "Use `n & (n-1)` to drop the lowest set bit (counting / power-of-two test).",
      "Shift (`<<`, `>>`) to inspect or set a specific bit position.",
      "Treat an integer 0..2ⁿ−1 as a subset mask to enumerate combinations.",
    ],
    template: {
      lang: "python",
      label: "Single Number — XOR cancels pairs",
      code: `def single_number(nums):
    acc = 0
    for x in nums:
        acc ^= x          # pairs cancel to 0; the lone value remains
    return acc

def count_bits(n):
    c = 0
    while n:
        n &= n - 1        # clear lowest set bit
        c += 1
    return c`,
    },
    complexity: [
      { approach: "XOR sweep", time: "O(n)", space: "O(1)" },
      { approach: "Bit count via n&(n-1)", time: "O(#set bits)", space: "O(1)" },
      { approach: "Subset bitmask enumerate", time: "O(2ⁿ·n)", space: "O(1)" },
    ],
    pitfalls: [
      "Operator precedence: parenthesize (`(n & 1) == 0`) to avoid surprises.",
      "Signed-integer / overflow quirks in languages with fixed-width ints.",
      "Confusing logical (`and`/`or`) with bitwise (`&`/`|`).",
    ],
    problems: [
      { name: "Single Number", difficulty: "easy", note: "XOR all" },
      { name: "Number of 1 Bits", difficulty: "easy", note: "n & (n-1)" },
      { name: "Counting Bits", difficulty: "easy", note: "dp + lowbit" },
      { name: "Reverse Bits", difficulty: "easy", note: "shift & build" },
      { name: "Missing Number", difficulty: "easy", note: "XOR indices/values" },
    ],
    related: ["math-geometry", "arrays-hashing"],
    visualizer: "bitxor",
  },
];

export const patternById = (id: string) => patterns.find((p) => p.id === id);

export const levelLabel: Record<Pattern["level"], string> = {
  foundational: "Foundational",
  core: "Core",
  advanced: "Advanced",
};
