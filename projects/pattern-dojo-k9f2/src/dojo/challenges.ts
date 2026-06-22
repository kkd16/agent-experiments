import type { Challenge } from "./types";

/**
 * The Code Dojo problem set.
 *
 * Each problem is a pure JSON-in / JSON-out function so the sandboxed judge can
 * deep-copy arguments and structurally compare the return value. Linked-list
 * problems are framed over plain arrays; tree problems pass a nested
 * `{ val, left, right }` node (or `null`). Every `reference` here is validated
 * against its own `tests` before shipping, so the judge never disagrees with
 * the answer key.
 */
export const challenges: Challenge[] = [
  // ---------------------------------------------------------------- arrays-hashing
  {
    id: "two-sum",
    patternId: "arrays-hashing",
    title: "Two Sum",
    difficulty: "easy",
    statement: [
      "Given an array of integers `nums` and an integer `target`, return the indices of the two numbers that add up to `target`.",
      "Each input has exactly one solution, and you may not use the same element twice. Return the indices in ascending order.",
    ],
    entry: "twoSum",
    params: ["nums: number[]", "target: number"],
    returns: "number[] — the two indices, ascending",
    starter: "function twoSum(nums, target) {\n  // your code here\n}\n",
    tests: [
      { args: [[2, 7, 11, 15], 9], expected: [0, 1], sample: true },
      { args: [[3, 2, 4], 6], expected: [1, 2], sample: true },
      { args: [[3, 3], 6], expected: [0, 1] },
      { args: [[-3, 4, 3, 90], 0], expected: [0, 2] },
      { args: [[0, 4, 3, 0], 0], expected: [0, 3] },
    ],
    reference:
      "function twoSum(nums, target) {\n  const seen = new Map();\n  for (let i = 0; i < nums.length; i++) {\n    const need = target - nums[i];\n    if (seen.has(need)) return [seen.get(need), i];\n    seen.set(nums[i], i);\n  }\n  return [];\n}\n",
    hints: [
      "Brute force is two nested loops, O(n²). Can you remember what you've already seen?",
      "For each value x, you need target − x. A hash map of value → index answers 'have I seen the complement?' in O(1).",
      "Store each number's index as you go; check for the complement *before* inserting so you never reuse one element.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },
  {
    id: "contains-duplicate",
    patternId: "arrays-hashing",
    title: "Contains Duplicate",
    difficulty: "easy",
    statement: [
      "Return `true` if any value appears at least twice in `nums`, and `false` if every element is distinct.",
    ],
    entry: "hasDuplicate",
    params: ["nums: number[]"],
    returns: "boolean",
    starter: "function hasDuplicate(nums) {\n  // your code here\n}\n",
    tests: [
      { args: [[1, 2, 3, 1]], expected: true, sample: true },
      { args: [[1, 2, 3, 4]], expected: false, sample: true },
      { args: [[]], expected: false },
      { args: [[1, 1, 1, 3, 3, 4, 3, 2, 4, 2]], expected: true },
      { args: [[0]], expected: false },
    ],
    reference:
      "function hasDuplicate(nums) {\n  const seen = new Set();\n  for (const n of nums) {\n    if (seen.has(n)) return true;\n    seen.add(n);\n  }\n  return false;\n}\n",
    hints: [
      "A Set remembers what you've already encountered.",
      "Walk once; the moment you try to add a value already in the set, you've found a duplicate.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },
  {
    id: "group-anagrams",
    patternId: "arrays-hashing",
    title: "Group Anagrams",
    difficulty: "medium",
    statement: [
      "Given an array of strings `strs`, group the anagrams together. Return a list of groups.",
      "The groups and the order of strings within them may be in **any order** — the judge compares them order-insensitively.",
    ],
    entry: "groupAnagrams",
    params: ["strs: string[]"],
    returns: "string[][] — groups of anagrams (any order)",
    starter: "function groupAnagrams(strs) {\n  // your code here\n}\n",
    compare: "unordered-deep",
    tests: [
      {
        args: [["eat", "tea", "tan", "ate", "nat", "bat"]],
        expected: [["bat"], ["nat", "tan"], ["ate", "eat", "tea"]],
        sample: true,
      },
      { args: [[""]], expected: [[""]], sample: true },
      { args: [["a"]], expected: [["a"]] },
      { args: [["abc", "bca", "xyz", "zzz"]], expected: [["abc", "bca"], ["xyz"], ["zzz"]] },
    ],
    reference:
      "function groupAnagrams(strs) {\n  const groups = new Map();\n  for (const s of strs) {\n    const key = s.split('').sort().join('');\n    if (!groups.has(key)) groups.set(key, []);\n    groups.get(key).push(s);\n  }\n  return [...groups.values()];\n}\n",
    hints: [
      "Two strings are anagrams iff they share the same multiset of letters.",
      "Build a canonical key for each string (its sorted letters, or a letter-count signature) and bucket by that key in a hash map.",
    ],
    complexity: { time: "O(n·k log k)", space: "O(n·k)" },
  },

  // ---------------------------------------------------------------- two-pointers
  {
    id: "valid-palindrome",
    patternId: "two-pointers",
    title: "Valid Palindrome",
    difficulty: "easy",
    statement: [
      "Return `true` if `s`, after lower-casing and removing all non-alphanumeric characters, reads the same forwards and backwards.",
      "An empty string (once cleaned) counts as a palindrome.",
    ],
    entry: "isPalindrome",
    params: ["s: string"],
    returns: "boolean",
    starter: "function isPalindrome(s) {\n  // your code here\n}\n",
    tests: [
      { args: ["A man, a plan, a canal: Panama"], expected: true, sample: true },
      { args: ["race a car"], expected: false, sample: true },
      { args: [" "], expected: true },
      { args: ["0P"], expected: false },
      { args: ["ab_a"], expected: true },
    ],
    reference:
      "function isPalindrome(s) {\n  const ok = (c) => /[a-z0-9]/.test(c);\n  s = s.toLowerCase();\n  let i = 0, j = s.length - 1;\n  while (i < j) {\n    while (i < j && !ok(s[i])) i++;\n    while (i < j && !ok(s[j])) j--;\n    if (s[i] !== s[j]) return false;\n    i++; j--;\n  }\n  return true;\n}\n",
    hints: [
      "Two pointers, one from each end, walking inward.",
      "Skip characters that aren't alphanumeric on either side, then compare the two letters; mismatch ⇒ not a palindrome.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "two-sum-ii",
    patternId: "two-pointers",
    title: "Two Sum II — Sorted Array",
    difficulty: "medium",
    statement: [
      "`numbers` is sorted in non-decreasing order. Return the **1-indexed** positions of the two values that sum to `target`.",
      "Exactly one solution exists; return the smaller index first.",
    ],
    entry: "twoSumSorted",
    params: ["numbers: number[] (sorted)", "target: number"],
    returns: "number[] — two 1-indexed positions",
    starter: "function twoSumSorted(numbers, target) {\n  // your code here\n}\n",
    tests: [
      { args: [[2, 7, 11, 15], 9], expected: [1, 2], sample: true },
      { args: [[2, 3, 4], 6], expected: [1, 3], sample: true },
      { args: [[-1, 0], -1], expected: [1, 2] },
      { args: [[1, 2, 3, 4, 4, 9, 56, 90], 8], expected: [4, 5] },
    ],
    reference:
      "function twoSumSorted(numbers, target) {\n  let i = 0, j = numbers.length - 1;\n  while (i < j) {\n    const sum = numbers[i] + numbers[j];\n    if (sum === target) return [i + 1, j + 1];\n    if (sum < target) i++; else j--;\n  }\n  return [];\n}\n",
    hints: [
      "The array is sorted — exploit that instead of hashing.",
      "Pointers at both ends: if the sum is too small move the left pointer up; too big, move the right pointer down.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },

  // ---------------------------------------------------------------- sliding-window
  {
    id: "best-time-stock",
    patternId: "sliding-window",
    title: "Best Time to Buy and Sell Stock",
    difficulty: "easy",
    statement: [
      "`prices[i]` is the price of a stock on day `i`. Buy on one day and sell on a later day to maximise profit.",
      "Return the maximum profit, or `0` if no profit is possible.",
    ],
    entry: "maxProfit",
    params: ["prices: number[]"],
    returns: "number — best achievable profit",
    starter: "function maxProfit(prices) {\n  // your code here\n}\n",
    tests: [
      { args: [[7, 1, 5, 3, 6, 4]], expected: 5, sample: true },
      { args: [[7, 6, 4, 3, 1]], expected: 0, sample: true },
      { args: [[1]], expected: 0 },
      { args: [[2, 4, 1]], expected: 2 },
      { args: [[3, 2, 6, 5, 0, 3]], expected: 4 },
    ],
    reference:
      "function maxProfit(prices) {\n  let min = Infinity, best = 0;\n  for (const p of prices) {\n    if (p < min) min = p;\n    else if (p - min > best) best = p - min;\n  }\n  return best;\n}\n",
    hints: [
      "Think of a window whose left edge is the cheapest day seen so far.",
      "Track the minimum price to the left of each day; the best profit is the largest (today − running min).",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "longest-substring",
    patternId: "sliding-window",
    title: "Longest Substring Without Repeating Characters",
    difficulty: "medium",
    statement: [
      "Return the length of the longest substring of `s` that contains no repeated character.",
    ],
    entry: "lengthOfLongestSubstring",
    params: ["s: string"],
    returns: "number",
    starter: "function lengthOfLongestSubstring(s) {\n  // your code here\n}\n",
    tests: [
      { args: ["abcabcbb"], expected: 3, sample: true },
      { args: ["bbbbb"], expected: 1, sample: true },
      { args: ["pwwkew"], expected: 3 },
      { args: [""], expected: 0 },
      { args: ["dvdf"], expected: 3 },
      { args: ["tmmzuxt"], expected: 5 },
    ],
    reference:
      "function lengthOfLongestSubstring(s) {\n  const last = new Map();\n  let start = 0, best = 0;\n  for (let i = 0; i < s.length; i++) {\n    const c = s[i];\n    if (last.has(c) && last.get(c) >= start) start = last.get(c) + 1;\n    last.set(c, i);\n    best = Math.max(best, i - start + 1);\n  }\n  return best;\n}\n",
    hints: [
      "Grow a window to the right; when a character repeats, shrink from the left.",
      "Remember each character's last index. On a repeat inside the window, jump `start` to just past that previous occurrence.",
    ],
    complexity: { time: "O(n)", space: "O(min(n, charset))" },
  },

  // ---------------------------------------------------------------- stack
  {
    id: "valid-parentheses",
    patternId: "stack",
    title: "Valid Parentheses",
    difficulty: "easy",
    statement: [
      "Given a string `s` of just the brackets `()[]{}`, return `true` if every bracket is closed by the matching type in the correct order.",
    ],
    entry: "isValid",
    params: ["s: string"],
    returns: "boolean",
    starter: "function isValid(s) {\n  // your code here\n}\n",
    tests: [
      { args: ["()"], expected: true, sample: true },
      { args: ["()[]{}"], expected: true, sample: true },
      { args: ["(]"], expected: false },
      { args: ["([])"], expected: true },
      { args: ["(("], expected: false },
      { args: ["]"], expected: false },
    ],
    reference:
      "function isValid(s) {\n  const close = { ')': '(', ']': '[', '}': '{' };\n  const stack = [];\n  for (const c of s) {\n    if (c === '(' || c === '[' || c === '{') stack.push(c);\n    else if (stack.pop() !== close[c]) return false;\n  }\n  return stack.length === 0;\n}\n",
    hints: [
      "A stack matches the most recent unclosed bracket first — last in, first out.",
      "Push opens; on a close, the top of the stack must be its matching open. Finish with an empty stack.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },
  {
    id: "daily-temperatures",
    patternId: "stack",
    title: "Daily Temperatures",
    difficulty: "medium",
    statement: [
      "Given `temperatures`, return an array `answer` where `answer[i]` is the number of days you must wait after day `i` for a warmer temperature.",
      "If no warmer day exists, `answer[i] = 0`.",
    ],
    entry: "dailyTemperatures",
    params: ["temperatures: number[]"],
    returns: "number[]",
    starter: "function dailyTemperatures(temperatures) {\n  // your code here\n}\n",
    tests: [
      { args: [[73, 74, 75, 71, 69, 72, 76, 73]], expected: [1, 1, 4, 2, 1, 1, 0, 0], sample: true },
      { args: [[30, 40, 50, 60]], expected: [1, 1, 1, 0], sample: true },
      { args: [[30, 60, 90]], expected: [1, 1, 0] },
      { args: [[90, 80, 70]], expected: [0, 0, 0] },
    ],
    reference:
      "function dailyTemperatures(temperatures) {\n  const res = new Array(temperatures.length).fill(0);\n  const stack = [];\n  for (let i = 0; i < temperatures.length; i++) {\n    while (stack.length && temperatures[i] > temperatures[stack[stack.length - 1]]) {\n      const j = stack.pop();\n      res[j] = i - j;\n    }\n    stack.push(i);\n  }\n  return res;\n}\n",
    hints: [
      "A monotonic decreasing stack of *indices* waiting for something warmer.",
      "When today is warmer than the temperature at the stack's top index, pop it and record the day gap; then push today.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },

  // ---------------------------------------------------------------- binary-search
  {
    id: "binary-search",
    patternId: "binary-search",
    title: "Binary Search",
    difficulty: "easy",
    statement: [
      "Given a `nums` array sorted in ascending order and a `target`, return the index of `target`, or `-1` if it is absent.",
    ],
    entry: "search",
    params: ["nums: number[] (sorted)", "target: number"],
    returns: "number — index or -1",
    starter: "function search(nums, target) {\n  // your code here\n}\n",
    tests: [
      { args: [[-1, 0, 3, 5, 9, 12], 9], expected: 4, sample: true },
      { args: [[-1, 0, 3, 5, 9, 12], 2], expected: -1, sample: true },
      { args: [[5], 5], expected: 0 },
      { args: [[5], -5], expected: -1 },
      { args: [[1, 2, 3, 4, 5, 6, 7, 8], 8], expected: 7 },
    ],
    reference:
      "function search(nums, target) {\n  let lo = 0, hi = nums.length - 1;\n  while (lo <= hi) {\n    const mid = (lo + hi) >> 1;\n    if (nums[mid] === target) return mid;\n    if (nums[mid] < target) lo = mid + 1;\n    else hi = mid - 1;\n  }\n  return -1;\n}\n",
    hints: [
      "Halve the search space each step.",
      "Keep an inclusive [lo, hi]; compare the midpoint and discard the half that cannot contain the target.",
    ],
    complexity: { time: "O(log n)", space: "O(1)" },
  },
  {
    id: "search-rotated",
    patternId: "binary-search",
    title: "Search in Rotated Sorted Array",
    difficulty: "medium",
    statement: [
      "`nums` was sorted ascending then rotated at an unknown pivot (all values distinct). Return the index of `target`, or `-1`.",
      "Do it in O(log n).",
    ],
    entry: "searchRotated",
    params: ["nums: number[] (rotated, distinct)", "target: number"],
    returns: "number — index or -1",
    starter: "function searchRotated(nums, target) {\n  // your code here\n}\n",
    tests: [
      { args: [[4, 5, 6, 7, 0, 1, 2], 0], expected: 4, sample: true },
      { args: [[4, 5, 6, 7, 0, 1, 2], 3], expected: -1, sample: true },
      { args: [[1], 0], expected: -1 },
      { args: [[5, 1, 3], 5], expected: 0 },
      { args: [[6, 7, 8, 1, 2, 3, 4, 5], 4], expected: 6 },
    ],
    reference:
      "function searchRotated(nums, target) {\n  let lo = 0, hi = nums.length - 1;\n  while (lo <= hi) {\n    const mid = (lo + hi) >> 1;\n    if (nums[mid] === target) return mid;\n    if (nums[lo] <= nums[mid]) {\n      if (nums[lo] <= target && target < nums[mid]) hi = mid - 1; else lo = mid + 1;\n    } else {\n      if (nums[mid] < target && target <= nums[hi]) lo = mid + 1; else hi = mid - 1;\n    }\n  }\n  return -1;\n}\n",
    hints: [
      "At any midpoint, at least one half is still sorted.",
      "Detect which half is sorted; if the target lies inside that sorted range, search it, otherwise search the other half.",
    ],
    complexity: { time: "O(log n)", space: "O(1)" },
  },

  // ---------------------------------------------------------------- linked-list
  {
    id: "reverse-list",
    patternId: "linked-list",
    title: "Reverse Linked List",
    difficulty: "easy",
    statement: [
      "A singly linked list is given to you as an array `values` (head first). Return the values of the **reversed** list, as an array.",
      "(We frame the list as an array so the function stays pure — the pointer-rewiring idea is identical.)",
    ],
    entry: "reverseList",
    params: ["values: number[] — list head→tail"],
    returns: "number[] — reversed list",
    starter: "function reverseList(values) {\n  // your code here\n}\n",
    tests: [
      { args: [[1, 2, 3, 4, 5]], expected: [5, 4, 3, 2, 1], sample: true },
      { args: [[1, 2]], expected: [2, 1], sample: true },
      { args: [[]], expected: [] },
      { args: [[7]], expected: [7] },
    ],
    reference:
      "function reverseList(values) {\n  const out = [];\n  for (let i = values.length - 1; i >= 0; i--) out.push(values[i]);\n  return out;\n}\n",
    hints: [
      "With real nodes you'd carry a `prev` pointer and flip each `next` to point backwards.",
      "Framed as an array, that's simply emitting the elements from tail to head.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },
  {
    id: "merge-two-lists",
    patternId: "linked-list",
    title: "Merge Two Sorted Lists",
    difficulty: "easy",
    statement: [
      "Two sorted singly linked lists are given as arrays `a` and `b`. Merge them into one sorted list and return its values as an array.",
    ],
    entry: "mergeTwoLists",
    params: ["a: number[] (sorted)", "b: number[] (sorted)"],
    returns: "number[] — merged sorted list",
    starter: "function mergeTwoLists(a, b) {\n  // your code here\n}\n",
    tests: [
      { args: [[1, 2, 4], [1, 3, 4]], expected: [1, 1, 2, 3, 4, 4], sample: true },
      { args: [[], []], expected: [], sample: true },
      { args: [[], [0]], expected: [0] },
      { args: [[5], [1, 2, 3]], expected: [1, 2, 3, 5] },
    ],
    reference:
      "function mergeTwoLists(a, b) {\n  const out = [];\n  let i = 0, j = 0;\n  while (i < a.length && j < b.length) {\n    if (a[i] <= b[j]) out.push(a[i++]); else out.push(b[j++]);\n  }\n  while (i < a.length) out.push(a[i++]);\n  while (j < b.length) out.push(b[j++]);\n  return out;\n}\n",
    hints: [
      "Two pointers, one per list, always taking the smaller head.",
      "When one list runs out, append the remainder of the other.",
    ],
    complexity: { time: "O(m + n)", space: "O(m + n)" },
  },

  // ---------------------------------------------------------------- trees
  {
    id: "max-depth",
    patternId: "trees",
    title: "Maximum Depth of Binary Tree",
    difficulty: "easy",
    statement: [
      "A binary tree is given as a nested node `{ val, left, right }`, where an absent child is `null` (and an empty tree is `null`).",
      "Return the maximum depth — the number of nodes on the longest root-to-leaf path.",
    ],
    entry: "maxDepth",
    params: ["root: {val,left,right} | null"],
    returns: "number",
    starter: "function maxDepth(root) {\n  // your code here\n}\n",
    tests: [
      {
        args: [{ val: 3, left: { val: 9, left: null, right: null }, right: { val: 20, left: { val: 15, left: null, right: null }, right: { val: 7, left: null, right: null } } }],
        expected: 3,
        sample: true,
      },
      { args: [null], expected: 0, sample: true },
      { args: [{ val: 1, left: null, right: { val: 2, left: null, right: null } }], expected: 2 },
      { args: [{ val: 5, left: null, right: null }], expected: 1 },
    ],
    reference:
      "function maxDepth(root) {\n  if (!root) return 0;\n  return 1 + Math.max(maxDepth(root.left), maxDepth(root.right));\n}\n",
    hints: [
      "The depth of a tree is 1 + the depth of its deeper subtree.",
      "Recurse; the base case is `null` ⇒ 0.",
    ],
    complexity: { time: "O(n)", space: "O(h)" },
  },
  {
    id: "inorder-traversal",
    patternId: "trees",
    title: "Binary Tree Inorder Traversal",
    difficulty: "easy",
    statement: [
      "Given the root of a binary tree as a nested `{ val, left, right }` node (or `null`), return the **in-order** traversal of its values (left, node, right).",
    ],
    entry: "inorderTraversal",
    params: ["root: {val,left,right} | null"],
    returns: "number[] — values in in-order",
    starter: "function inorderTraversal(root) {\n  // your code here\n}\n",
    tests: [
      {
        args: [{ val: 1, left: null, right: { val: 2, left: { val: 3, left: null, right: null }, right: null } }],
        expected: [1, 3, 2],
        sample: true,
      },
      { args: [null], expected: [], sample: true },
      {
        args: [{ val: 4, left: { val: 2, left: { val: 1, left: null, right: null }, right: { val: 3, left: null, right: null } }, right: { val: 7, left: null, right: null } }],
        expected: [1, 2, 3, 4, 7],
      },
    ],
    reference:
      "function inorderTraversal(root) {\n  const out = [];\n  const walk = (n) => {\n    if (!n) return;\n    walk(n.left);\n    out.push(n.val);\n    walk(n.right);\n  };\n  walk(root);\n  return out;\n}\n",
    hints: [
      "In-order means: fully visit the left subtree, then the node, then the right subtree.",
      "A small recursive helper that pushes `n.val` between the two recursive calls does it.",
    ],
    complexity: { time: "O(n)", space: "O(h)" },
  },

  // ---------------------------------------------------------------- heap-priority-queue
  {
    id: "kth-largest",
    patternId: "heap-priority-queue",
    title: "Kth Largest Element in an Array",
    difficulty: "medium",
    statement: [
      "Return the `k`-th largest element in `nums` (the k-th in sorted-descending order, not the k-th distinct).",
    ],
    entry: "findKthLargest",
    params: ["nums: number[]", "k: number"],
    returns: "number",
    starter: "function findKthLargest(nums, k) {\n  // your code here\n}\n",
    tests: [
      { args: [[3, 2, 1, 5, 6, 4], 2], expected: 5, sample: true },
      { args: [[3, 2, 3, 1, 2, 4, 5, 5, 6], 4], expected: 4, sample: true },
      { args: [[1], 1], expected: 1 },
      { args: [[7, 7, 7], 2], expected: 7 },
    ],
    reference:
      "function findKthLargest(nums, k) {\n  const sorted = [...nums].sort((a, b) => b - a);\n  return sorted[k - 1];\n}\n",
    hints: [
      "A min-heap of size k keeps the k largest seen so far; its root is the answer.",
      "Even a sort works — the point of the pattern is keeping only the top-k, which a heap of size k does in O(n log k).",
    ],
    complexity: { time: "O(n log k)", space: "O(k)" },
  },
  {
    id: "last-stone-weight",
    patternId: "heap-priority-queue",
    title: "Last Stone Weight",
    difficulty: "easy",
    statement: [
      "Each turn, smash the two heaviest stones together: if equal, both are destroyed; otherwise the lighter is destroyed and the heavier becomes the difference.",
      "Return the weight of the last remaining stone, or `0` if none remains.",
    ],
    entry: "lastStoneWeight",
    params: ["stones: number[]"],
    returns: "number",
    starter: "function lastStoneWeight(stones) {\n  // your code here\n}\n",
    tests: [
      { args: [[2, 7, 4, 1, 8, 1]], expected: 1, sample: true },
      { args: [[1]], expected: 1, sample: true },
      { args: [[2, 2]], expected: 0 },
      { args: [[3, 7, 2]], expected: 2 },
    ],
    reference:
      "function lastStoneWeight(stones) {\n  const h = [...stones];\n  while (h.length > 1) {\n    h.sort((a, b) => a - b);\n    const y = h.pop();\n    const x = h.pop();\n    if (y > x) h.push(y - x);\n  }\n  return h.length ? h[0] : 0;\n}\n",
    hints: [
      "You repeatedly need the two largest — a max-heap delivers them in O(log n).",
      "Pop the two biggest; if they differ, push the difference back. Stop when ≤ 1 stone remains.",
    ],
    complexity: { time: "O(n log n)", space: "O(n)" },
  },

  // ---------------------------------------------------------------- backtracking
  {
    id: "subsets",
    patternId: "backtracking",
    title: "Subsets",
    difficulty: "medium",
    statement: [
      "Given an array `nums` of distinct integers, return all possible subsets (the power set).",
      "The subsets and their internal order may be in **any order** — the judge compares order-insensitively.",
    ],
    entry: "subsets",
    params: ["nums: number[] (distinct)"],
    returns: "number[][] — every subset (any order)",
    starter: "function subsets(nums) {\n  // your code here\n}\n",
    compare: "unordered-deep",
    tests: [
      { args: [[1, 2, 3]], expected: [[], [1], [2], [3], [1, 2], [1, 3], [2, 3], [1, 2, 3]], sample: true },
      { args: [[0]], expected: [[], [0]], sample: true },
      { args: [[]], expected: [[]] },
      { args: [[4, 5]], expected: [[], [4], [5], [4, 5]] },
    ],
    reference:
      "function subsets(nums) {\n  const res = [];\n  const cur = [];\n  const dfs = (i) => {\n    if (i === nums.length) { res.push([...cur]); return; }\n    cur.push(nums[i]);\n    dfs(i + 1);\n    cur.pop();\n    dfs(i + 1);\n  };\n  dfs(0);\n  return res;\n}\n",
    hints: [
      "At each element you make a binary choice: include it or skip it.",
      "Backtrack: recurse with the element added, then recurse without it (remember to undo the add).",
    ],
    complexity: { time: "O(n·2ⁿ)", space: "O(n)" },
  },
  {
    id: "permutations",
    patternId: "backtracking",
    title: "Permutations",
    difficulty: "medium",
    statement: [
      "Given an array `nums` of distinct integers, return all of their permutations, in any order.",
    ],
    entry: "permute",
    params: ["nums: number[] (distinct)"],
    returns: "number[][] — every permutation (any order)",
    starter: "function permute(nums) {\n  // your code here\n}\n",
    compare: "unordered-deep",
    tests: [
      { args: [[1, 2, 3]], expected: [[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]], sample: true },
      { args: [[0, 1]], expected: [[0, 1], [1, 0]], sample: true },
      { args: [[1]], expected: [[1]] },
    ],
    reference:
      "function permute(nums) {\n  const res = [];\n  const cur = [];\n  const used = new Array(nums.length).fill(false);\n  const dfs = () => {\n    if (cur.length === nums.length) { res.push([...cur]); return; }\n    for (let i = 0; i < nums.length; i++) {\n      if (used[i]) continue;\n      used[i] = true;\n      cur.push(nums[i]);\n      dfs();\n      cur.pop();\n      used[i] = false;\n    }\n  };\n  dfs();\n  return res;\n}\n",
    hints: [
      "Build the permutation one slot at a time, choosing an unused element each time.",
      "Track which indices are used; recurse, then undo the choice before trying the next.",
    ],
    complexity: { time: "O(n·n!)", space: "O(n)" },
  },

  // ---------------------------------------------------------------- graphs
  {
    id: "num-islands",
    patternId: "graphs",
    title: "Number of Islands",
    difficulty: "medium",
    statement: [
      "Given a `grid` of `'1'` (land) and `'0'` (water) strings, count the islands. An island is land connected 4-directionally (up/down/left/right).",
    ],
    entry: "numIslands",
    params: ["grid: string[][] of '1'/'0'"],
    returns: "number",
    starter: "function numIslands(grid) {\n  // your code here\n}\n",
    tests: [
      {
        args: [[["1", "1", "0", "0"], ["1", "0", "0", "1"], ["0", "0", "1", "1"]]],
        expected: 2,
        sample: true,
      },
      { args: [[["1", "1", "1"], ["0", "1", "0"], ["1", "1", "1"]]], expected: 1, sample: true },
      { args: [[["0", "0"], ["0", "0"]]], expected: 0 },
      { args: [[["1"]]], expected: 1 },
    ],
    reference:
      "function numIslands(grid) {\n  const rows = grid.length, cols = grid[0] ? grid[0].length : 0;\n  let count = 0;\n  const sink = (r, c) => {\n    if (r < 0 || c < 0 || r >= rows || c >= cols || grid[r][c] !== '1') return;\n    grid[r][c] = '0';\n    sink(r + 1, c); sink(r - 1, c); sink(r, c + 1); sink(r, c - 1);\n  };\n  for (let r = 0; r < rows; r++)\n    for (let c = 0; c < cols; c++)\n      if (grid[r][c] === '1') { count++; sink(r, c); }\n  return count;\n}\n",
    hints: [
      "Each unvisited land cell starts a new island; flood-fill everything reachable from it.",
      "Scan the grid; on a '1', increment the count and DFS/BFS to sink (mark) the whole island so you don't recount it.",
    ],
    complexity: { time: "O(rows·cols)", space: "O(rows·cols)" },
  },
  {
    id: "course-schedule",
    patternId: "graphs",
    title: "Course Schedule",
    difficulty: "medium",
    statement: [
      "There are `numCourses` courses labelled `0..numCourses-1`. `prerequisites[i] = [a, b]` means you must take `b` before `a`.",
      "Return `true` if you can finish every course (i.e. the prerequisite graph has no cycle).",
    ],
    entry: "canFinish",
    params: ["numCourses: number", "prerequisites: number[][]"],
    returns: "boolean",
    starter: "function canFinish(numCourses, prerequisites) {\n  // your code here\n}\n",
    tests: [
      { args: [2, [[1, 0]]], expected: true, sample: true },
      { args: [2, [[1, 0], [0, 1]]], expected: false, sample: true },
      { args: [4, [[1, 0], [2, 1], [3, 2]]], expected: true },
      { args: [3, [[0, 1], [1, 2], [2, 0]]], expected: false },
      { args: [1, []], expected: true },
    ],
    reference:
      "function canFinish(numCourses, prerequisites) {\n  const adj = Array.from({ length: numCourses }, () => []);\n  const indeg = new Array(numCourses).fill(0);\n  for (const [a, b] of prerequisites) { adj[b].push(a); indeg[a]++; }\n  const q = [];\n  for (let i = 0; i < numCourses; i++) if (indeg[i] === 0) q.push(i);\n  let seen = 0;\n  while (q.length) {\n    const u = q.shift();\n    seen++;\n    for (const v of adj[u]) if (--indeg[v] === 0) q.push(v);\n  }\n  return seen === numCourses;\n}\n",
    hints: [
      "Finishing all courses ⇔ the dependency graph is a DAG (no cycle).",
      "Kahn's topological sort: repeatedly take a course with no remaining prereqs. If you can process all of them, there's no cycle.",
    ],
    complexity: { time: "O(V + E)", space: "O(V + E)" },
  },

  // ---------------------------------------------------------------- advanced-graphs
  {
    id: "network-delay",
    patternId: "advanced-graphs",
    title: "Network Delay Time",
    difficulty: "medium",
    statement: [
      "`times[i] = [u, v, w]` is a directed edge: a signal from `u` reaches `v` after `w` time. A signal starts at node `k` (nodes are labelled `1..n`).",
      "Return the time for **all** nodes to receive it, or `-1` if some node is unreachable.",
    ],
    entry: "networkDelayTime",
    params: ["times: number[][]", "n: number", "k: number"],
    returns: "number",
    starter: "function networkDelayTime(times, n, k) {\n  // your code here\n}\n",
    tests: [
      { args: [[[2, 1, 1], [2, 3, 1], [3, 4, 1]], 4, 2], expected: 2, sample: true },
      { args: [[[1, 2, 1]], 2, 1], expected: 1, sample: true },
      { args: [[[1, 2, 1]], 2, 2], expected: -1 },
      { args: [[[1, 2, 1], [2, 3, 2], [1, 3, 4]], 3, 1], expected: 3 },
    ],
    reference:
      "function networkDelayTime(times, n, k) {\n  const adj = Array.from({ length: n + 1 }, () => []);\n  for (const [u, v, w] of times) adj[u].push([v, w]);\n  const dist = new Array(n + 1).fill(Infinity);\n  dist[k] = 0;\n  const pq = [[0, k]];\n  while (pq.length) {\n    pq.sort((a, b) => b[0] - a[0]);\n    const [d, u] = pq.pop();\n    if (d > dist[u]) continue;\n    for (const [v, w] of adj[u]) {\n      if (d + w < dist[v]) { dist[v] = d + w; pq.push([dist[v], v]); }\n    }\n  }\n  let ans = 0;\n  for (let i = 1; i <= n; i++) {\n    if (dist[i] === Infinity) return -1;\n    ans = Math.max(ans, dist[i]);\n  }\n  return ans;\n}\n",
    hints: [
      "Shortest path from a single source with non-negative weights ⇒ Dijkstra.",
      "Relax edges out of the closest unfinished node (a priority queue). The answer is the largest finalised distance — or −1 if any stays infinite.",
    ],
    complexity: { time: "O(E log V)", space: "O(V + E)" },
  },

  // ---------------------------------------------------------------- dp-1d
  {
    id: "climb-stairs",
    patternId: "dp-1d",
    title: "Climbing Stairs",
    difficulty: "easy",
    statement: [
      "You climb a staircase of `n` steps, taking 1 or 2 steps at a time. Return how many distinct ways you can reach the top.",
    ],
    entry: "climbStairs",
    params: ["n: number"],
    returns: "number",
    starter: "function climbStairs(n) {\n  // your code here\n}\n",
    tests: [
      { args: [2], expected: 2, sample: true },
      { args: [3], expected: 3, sample: true },
      { args: [1], expected: 1 },
      { args: [5], expected: 8 },
      { args: [10], expected: 89 },
    ],
    reference:
      "function climbStairs(n) {\n  let a = 1, b = 1;\n  for (let i = 0; i < n; i++) { const t = a + b; a = b; b = t; }\n  return a;\n}\n",
    hints: [
      "Ways to reach step n = ways to reach (n−1) + ways to reach (n−2).",
      "That's Fibonacci; carry two running values instead of an array.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "house-robber",
    patternId: "dp-1d",
    title: "House Robber",
    difficulty: "medium",
    statement: [
      "`nums[i]` is the money in house `i`. You cannot rob two adjacent houses. Return the maximum you can rob.",
    ],
    entry: "rob",
    params: ["nums: number[]"],
    returns: "number",
    starter: "function rob(nums) {\n  // your code here\n}\n",
    tests: [
      { args: [[1, 2, 3, 1]], expected: 4, sample: true },
      { args: [[2, 7, 9, 3, 1]], expected: 12, sample: true },
      { args: [[]], expected: 0 },
      { args: [[5]], expected: 5 },
      { args: [[2, 1, 1, 2]], expected: 4 },
    ],
    reference:
      "function rob(nums) {\n  let prev = 0, cur = 0;\n  for (const n of nums) {\n    const next = Math.max(cur, prev + n);\n    prev = cur;\n    cur = next;\n  }\n  return cur;\n}\n",
    hints: [
      "At each house: skip it (keep the best so far) or rob it (its money + best up to two houses back).",
      "Carry two rolling maxima — the best including and excluding the previous house.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "coin-change",
    patternId: "dp-1d",
    title: "Coin Change",
    difficulty: "medium",
    statement: [
      "Given `coins` of distinct denominations and a total `amount`, return the fewest coins needed to make `amount`, or `-1` if it is impossible. You have unlimited coins of each kind.",
    ],
    entry: "coinChange",
    params: ["coins: number[]", "amount: number"],
    returns: "number",
    starter: "function coinChange(coins, amount) {\n  // your code here\n}\n",
    tests: [
      { args: [[1, 2, 5], 11], expected: 3, sample: true },
      { args: [[2], 3], expected: -1, sample: true },
      { args: [[1], 0], expected: 0 },
      { args: [[2, 5, 10, 1], 27], expected: 4 },
      { args: [[186, 419, 83, 408], 6249], expected: 20 },
    ],
    reference:
      "function coinChange(coins, amount) {\n  const dp = new Array(amount + 1).fill(Infinity);\n  dp[0] = 0;\n  for (let a = 1; a <= amount; a++) {\n    for (const c of coins) {\n      if (c <= a) dp[a] = Math.min(dp[a], dp[a - c] + 1);\n    }\n  }\n  return dp[amount] === Infinity ? -1 : dp[amount];\n}\n",
    hints: [
      "Best coins for amount a = 1 + the best for (a − c), minimised over each coin c.",
      "Bottom-up: fill dp[0..amount]; dp[0] = 0; an unreachable amount stays Infinity ⇒ −1.",
    ],
    complexity: { time: "O(amount·coins)", space: "O(amount)" },
  },

  // ---------------------------------------------------------------- dp-2d
  {
    id: "unique-paths",
    patternId: "dp-2d",
    title: "Unique Paths",
    difficulty: "medium",
    statement: [
      "A robot starts at the top-left of an `m × n` grid and may only move right or down. Return how many distinct paths reach the bottom-right corner.",
    ],
    entry: "uniquePaths",
    params: ["m: number (rows)", "n: number (cols)"],
    returns: "number",
    starter: "function uniquePaths(m, n) {\n  // your code here\n}\n",
    tests: [
      { args: [3, 7], expected: 28, sample: true },
      { args: [3, 2], expected: 3, sample: true },
      { args: [1, 1], expected: 1 },
      { args: [3, 3], expected: 6 },
      { args: [7, 3], expected: 28 },
    ],
    reference:
      "function uniquePaths(m, n) {\n  const row = new Array(n).fill(1);\n  for (let r = 1; r < m; r++)\n    for (let c = 1; c < n; c++)\n      row[c] += row[c - 1];\n  return row[n - 1];\n}\n",
    hints: [
      "Paths to a cell = paths from the cell above + paths from the cell to the left.",
      "The top row and left column are all 1; a single rolling row suffices.",
    ],
    complexity: { time: "O(m·n)", space: "O(n)" },
  },
  {
    id: "lcs",
    patternId: "dp-2d",
    title: "Longest Common Subsequence",
    difficulty: "medium",
    statement: [
      "Given two strings `text1` and `text2`, return the length of their longest common subsequence (characters in order, not necessarily contiguous), or `0` if there is none.",
    ],
    entry: "longestCommonSubsequence",
    params: ["text1: string", "text2: string"],
    returns: "number",
    starter: "function longestCommonSubsequence(text1, text2) {\n  // your code here\n}\n",
    tests: [
      { args: ["abcde", "ace"], expected: 3, sample: true },
      { args: ["abc", "abc"], expected: 3, sample: true },
      { args: ["abc", "def"], expected: 0 },
      { args: ["bsbininm", "jmjkbkjkv"], expected: 1 },
      { args: ["oxcpqrsvwf", "shmtulqrypy"], expected: 2 },
    ],
    reference:
      "function longestCommonSubsequence(text1, text2) {\n  const m = text1.length, n = text2.length;\n  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));\n  for (let i = 1; i <= m; i++)\n    for (let j = 1; j <= n; j++)\n      dp[i][j] = text1[i - 1] === text2[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);\n  return dp[m][n];\n}\n",
    hints: [
      "Compare the last characters: if they match, +1 on the LCS of both prefixes; otherwise drop one character from either string and take the best.",
      "A 2-D table dp[i][j] over prefixes of the two strings fills in O(m·n).",
    ],
    complexity: { time: "O(m·n)", space: "O(m·n)" },
  },

  // ---------------------------------------------------------------- greedy
  {
    id: "max-subarray",
    patternId: "greedy",
    title: "Maximum Subarray",
    difficulty: "medium",
    statement: [
      "Return the largest sum obtainable from a contiguous, non-empty subarray of `nums`.",
    ],
    entry: "maxSubArray",
    params: ["nums: number[]"],
    returns: "number",
    starter: "function maxSubArray(nums) {\n  // your code here\n}\n",
    tests: [
      { args: [[-2, 1, -3, 4, -1, 2, 1, -5, 4]], expected: 6, sample: true },
      { args: [[1]], expected: 1, sample: true },
      { args: [[5, 4, -1, 7, 8]], expected: 23 },
      { args: [[-1, -2, -3]], expected: -1 },
      { args: [[-2, -1]], expected: -1 },
    ],
    reference:
      "function maxSubArray(nums) {\n  let best = nums[0], cur = nums[0];\n  for (let i = 1; i < nums.length; i++) {\n    cur = Math.max(nums[i], cur + nums[i]);\n    best = Math.max(best, cur);\n  }\n  return best;\n}\n",
    hints: [
      "Kadane's: extend the running subarray, but never let it drag you below the current element alone.",
      "cur = max(nums[i], cur + nums[i]); track the best cur seen. Start from the first element so all-negative inputs work.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "jump-game",
    patternId: "greedy",
    title: "Jump Game",
    difficulty: "medium",
    statement: [
      "`nums[i]` is the maximum jump length from index `i`. Starting at index 0, return `true` if you can reach the last index.",
    ],
    entry: "canJump",
    params: ["nums: number[]"],
    returns: "boolean",
    starter: "function canJump(nums) {\n  // your code here\n}\n",
    tests: [
      { args: [[2, 3, 1, 1, 4]], expected: true, sample: true },
      { args: [[3, 2, 1, 0, 4]], expected: false, sample: true },
      { args: [[0]], expected: true },
      { args: [[2, 0, 0]], expected: true },
      { args: [[1, 0, 1, 0]], expected: false },
    ],
    reference:
      "function canJump(nums) {\n  let reach = 0;\n  for (let i = 0; i < nums.length; i++) {\n    if (i > reach) return false;\n    reach = Math.max(reach, i + nums[i]);\n  }\n  return true;\n}\n",
    hints: [
      "Track the furthest index reachable so far.",
      "If your current index ever exceeds that furthest reach, you're stuck. Otherwise extend the reach as you go.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },

  // ---------------------------------------------------------------- intervals
  {
    id: "merge-intervals",
    patternId: "intervals",
    title: "Merge Intervals",
    difficulty: "medium",
    statement: [
      "Given an array of `intervals` where `intervals[i] = [start, end]`, merge all overlapping intervals and return them **sorted by start**.",
    ],
    entry: "merge",
    params: ["intervals: number[][]"],
    returns: "number[][] — merged, sorted by start",
    starter: "function merge(intervals) {\n  // your code here\n}\n",
    tests: [
      { args: [[[1, 3], [2, 6], [8, 10], [15, 18]]], expected: [[1, 6], [8, 10], [15, 18]], sample: true },
      { args: [[[1, 4], [4, 5]]], expected: [[1, 5]], sample: true },
      { args: [[[1, 4], [0, 4]]], expected: [[0, 4]] },
      { args: [[[1, 4], [2, 3]]], expected: [[1, 4]] },
      { args: [[[1, 4]]], expected: [[1, 4]] },
    ],
    reference:
      "function merge(intervals) {\n  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);\n  const out = [];\n  for (const [s, e] of sorted) {\n    const last = out[out.length - 1];\n    if (last && s <= last[1]) last[1] = Math.max(last[1], e);\n    else out.push([s, e]);\n  }\n  return out;\n}\n",
    hints: [
      "Sort by start first — then overlaps are always adjacent.",
      "Sweep left to right; if the next interval starts at or before the current end, extend the end, otherwise start a new interval.",
    ],
    complexity: { time: "O(n log n)", space: "O(n)" },
  },
  {
    id: "insert-interval",
    patternId: "intervals",
    title: "Insert Interval",
    difficulty: "medium",
    statement: [
      "Given non-overlapping `intervals` sorted by start, insert `newInterval`, merging where necessary, and return the still-sorted result.",
    ],
    entry: "insert",
    params: ["intervals: number[][] (sorted, disjoint)", "newInterval: number[]"],
    returns: "number[][]",
    starter: "function insert(intervals, newInterval) {\n  // your code here\n}\n",
    tests: [
      { args: [[[1, 3], [6, 9]], [2, 5]], expected: [[1, 5], [6, 9]], sample: true },
      { args: [[[1, 2], [3, 5], [6, 7], [8, 10], [12, 16]], [4, 8]], expected: [[1, 2], [3, 10], [12, 16]], sample: true },
      { args: [[], [5, 7]], expected: [[5, 7]] },
      { args: [[[1, 5]], [2, 3]], expected: [[1, 5]] },
      { args: [[[1, 5]], [6, 8]], expected: [[1, 5], [6, 8]] },
    ],
    reference:
      "function insert(intervals, newInterval) {\n  const out = [];\n  let [s, e] = newInterval;\n  let i = 0;\n  const n = intervals.length;\n  while (i < n && intervals[i][1] < s) out.push(intervals[i++]);\n  while (i < n && intervals[i][0] <= e) {\n    s = Math.min(s, intervals[i][0]);\n    e = Math.max(e, intervals[i][1]);\n    i++;\n  }\n  out.push([s, e]);\n  while (i < n) out.push(intervals[i++]);\n  return out;\n}\n",
    hints: [
      "Three phases: intervals entirely before the new one, the overlapping band (merge into the new one), then the rest.",
      "Push everything ending before newInterval starts; absorb every interval that overlaps; then push the merged interval and the remainder.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },

  // ---------------------------------------------------------------- math-geometry
  {
    id: "rotate-image",
    patternId: "math-geometry",
    title: "Rotate Image",
    difficulty: "medium",
    statement: [
      "Given an `n × n` `matrix`, rotate it 90° clockwise and **return** the rotated matrix.",
    ],
    entry: "rotate",
    params: ["matrix: number[][] (n×n)"],
    returns: "number[][] — rotated 90° clockwise",
    starter: "function rotate(matrix) {\n  // your code here\n}\n",
    tests: [
      { args: [[[1, 2, 3], [4, 5, 6], [7, 8, 9]]], expected: [[7, 4, 1], [8, 5, 2], [9, 6, 3]], sample: true },
      { args: [[[1]]], expected: [[1]], sample: true },
      { args: [[[1, 2], [3, 4]]], expected: [[3, 1], [4, 2]] },
      {
        args: [[[5, 1, 9, 11], [2, 4, 8, 10], [13, 3, 6, 7], [15, 14, 12, 16]]],
        expected: [[15, 13, 2, 5], [14, 3, 4, 1], [12, 6, 8, 9], [16, 7, 10, 11]],
      },
    ],
    reference:
      "function rotate(matrix) {\n  const n = matrix.length;\n  const out = Array.from({ length: n }, () => new Array(n).fill(0));\n  for (let r = 0; r < n; r++)\n    for (let c = 0; c < n; c++)\n      out[c][n - 1 - r] = matrix[r][c];\n  return out;\n}\n",
    hints: [
      "Where does cell (r, c) land after a clockwise turn? Column c becomes the new row, and the row index flips.",
      "(r, c) → (c, n−1−r). In-place, the same effect comes from transpose + reverse-each-row.",
    ],
    complexity: { time: "O(n²)", space: "O(n²)" },
  },
  {
    id: "spiral-order",
    patternId: "math-geometry",
    title: "Spiral Matrix",
    difficulty: "medium",
    statement: [
      "Return all elements of the `m × n` `matrix` in spiral order (clockwise, starting top-left).",
    ],
    entry: "spiralOrder",
    params: ["matrix: number[][]"],
    returns: "number[]",
    starter: "function spiralOrder(matrix) {\n  // your code here\n}\n",
    tests: [
      { args: [[[1, 2, 3], [4, 5, 6], [7, 8, 9]]], expected: [1, 2, 3, 6, 9, 8, 7, 4, 5], sample: true },
      { args: [[[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]]], expected: [1, 2, 3, 4, 8, 12, 11, 10, 9, 5, 6, 7], sample: true },
      { args: [[[1]]], expected: [1] },
      { args: [[[1, 2], [3, 4]]], expected: [1, 2, 4, 3] },
    ],
    reference:
      "function spiralOrder(matrix) {\n  const out = [];\n  let top = 0, bottom = matrix.length - 1;\n  let left = 0, right = matrix[0].length - 1;\n  while (top <= bottom && left <= right) {\n    for (let c = left; c <= right; c++) out.push(matrix[top][c]);\n    top++;\n    for (let r = top; r <= bottom; r++) out.push(matrix[r][right]);\n    right--;\n    if (top <= bottom) { for (let c = right; c >= left; c--) out.push(matrix[bottom][c]); bottom--; }\n    if (left <= right) { for (let r = bottom; r >= top; r--) out.push(matrix[r][left]); left++; }\n  }\n  return out;\n}\n",
    hints: [
      "Peel the matrix like an onion: top row →, right column ↓, bottom row ←, left column ↑, then shrink the borders.",
      "Maintain top/bottom/left/right bounds; after walking each edge, move that bound inward and guard the two later edges so a thin strip isn't double-counted.",
    ],
    complexity: { time: "O(m·n)", space: "O(1)" },
  },
  {
    id: "powx-n",
    patternId: "math-geometry",
    title: "Pow(x, n)",
    difficulty: "medium",
    statement: [
      "Implement `pow(x, n)`, i.e. `x` raised to the integer power `n` (which may be negative).",
      "Answers are compared with a small floating-point tolerance.",
    ],
    entry: "myPow",
    params: ["x: number", "n: number (integer)"],
    returns: "number",
    starter: "function myPow(x, n) {\n  // your code here\n}\n",
    compare: "approx",
    tests: [
      { args: [2, 10], expected: 1024, sample: true },
      { args: [2.1, 3], expected: 9.261, sample: true },
      { args: [2, -2], expected: 0.25 },
      { args: [1, 2147483647], expected: 1 },
      { args: [0.5, 4], expected: 0.0625 },
    ],
    reference:
      "function myPow(x, n) {\n  let N = n;\n  if (N < 0) { x = 1 / x; N = -N; }\n  let result = 1;\n  while (N > 0) {\n    if (N & 1) result *= x;\n    x *= x;\n    N = Math.floor(N / 2);\n  }\n  return result;\n}\n",
    hints: [
      "Naïve multiplication is O(n) and times out for huge n — use fast exponentiation.",
      "Square x and halve n each step (x^n = (x²)^(n/2)); multiply the result in when the current bit of n is set. Handle negative n by inverting x.",
    ],
    complexity: { time: "O(log n)", space: "O(1)" },
  },

  // ---------------------------------------------------------------- bit-manipulation
  {
    id: "single-number",
    patternId: "bit-manipulation",
    title: "Single Number",
    difficulty: "easy",
    statement: [
      "Every element of `nums` appears twice except one. Return that single element. Aim for O(1) extra space.",
    ],
    entry: "singleNumber",
    params: ["nums: number[]"],
    returns: "number",
    starter: "function singleNumber(nums) {\n  // your code here\n}\n",
    tests: [
      { args: [[2, 2, 1]], expected: 1, sample: true },
      { args: [[4, 1, 2, 1, 2]], expected: 4, sample: true },
      { args: [[1]], expected: 1 },
      { args: [[7, 3, 5, 5, 3]], expected: 7 },
    ],
    reference:
      "function singleNumber(nums) {\n  let x = 0;\n  for (const n of nums) x ^= n;\n  return x;\n}\n",
    hints: [
      "XOR has a magic property: a ^ a = 0 and a ^ 0 = a.",
      "XOR everything together; the pairs cancel and only the lonely number survives.",
    ],
    complexity: { time: "O(n)", space: "O(1)" },
  },
  {
    id: "counting-bits",
    patternId: "bit-manipulation",
    title: "Counting Bits",
    difficulty: "easy",
    statement: [
      "Given an integer `n`, return an array `ans` of length `n + 1` where `ans[i]` is the number of `1` bits in the binary representation of `i`.",
    ],
    entry: "countBits",
    params: ["n: number"],
    returns: "number[] — popcounts of 0..n",
    starter: "function countBits(n) {\n  // your code here\n}\n",
    tests: [
      { args: [2], expected: [0, 1, 1], sample: true },
      { args: [5], expected: [0, 1, 1, 2, 1, 2], sample: true },
      { args: [0], expected: [0] },
      { args: [8], expected: [0, 1, 1, 2, 1, 2, 2, 3, 1] },
    ],
    reference:
      "function countBits(n) {\n  const dp = new Array(n + 1).fill(0);\n  for (let i = 1; i <= n; i++) dp[i] = dp[i >> 1] + (i & 1);\n  return dp;\n}\n",
    hints: [
      "popcount(i) relates to popcount of i with its last bit dropped.",
      "dp[i] = dp[i >> 1] + (i & 1): the bits of i/2 plus whether i is odd.",
    ],
    complexity: { time: "O(n)", space: "O(n)" },
  },
];

export const challengeById = (id: string): Challenge | undefined =>
  challenges.find((c) => c.id === id);

export const challengesForPattern = (patternId: string): Challenge[] =>
  challenges.filter((c) => c.patternId === patternId);

export const patternIdOfChallenge = (challengeId: string): string | undefined =>
  challengeById(challengeId)?.patternId;
