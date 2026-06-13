export interface AlgorithmData {
  id: string;
  name: string;
  type: 'Data Structure' | 'Sorting Algorithm' | 'Graph Algorithm';
  timeComplexity: {
    best: string;
    average: string;
    worst: string;
  };
  spaceComplexity: string;
}

export const csData: AlgorithmData[] = [
  {
    id: 'ds-array',
    name: 'Array',
    type: 'Data Structure',
    timeComplexity: {
      best: 'O(1)', // Access
      average: 'O(n)', // Search/Insertion/Deletion
      worst: 'O(n)',
    },
    spaceComplexity: 'O(n)',
  },
  {
    id: 'ds-linkedlist',
    name: 'Singly-Linked List',
    type: 'Data Structure',
    timeComplexity: {
      best: 'O(1)', // Insertion at head
      average: 'O(n)', // Search
      worst: 'O(n)',
    },
    spaceComplexity: 'O(n)',
  },
  {
    id: 'ds-hash',
    name: 'Hash Table',
    type: 'Data Structure',
    timeComplexity: {
      best: 'O(1)', // Search/Insertion/Deletion
      average: 'O(1)',
      worst: 'O(n)', // Collisions
    },
    spaceComplexity: 'O(n)',
  },
  {
    id: 'ds-bst',
    name: 'Binary Search Tree',
    type: 'Data Structure',
    timeComplexity: {
      best: 'O(log n)', // Search/Insertion/Deletion
      average: 'O(log n)',
      worst: 'O(n)', // Unbalanced
    },
    spaceComplexity: 'O(n)',
  },
  {
    id: 'sort-bubble',
    name: 'Bubble Sort',
    type: 'Sorting Algorithm',
    timeComplexity: {
      best: 'O(n)',
      average: 'O(n^2)',
      worst: 'O(n^2)',
    },
    spaceComplexity: 'O(1)',
  },
  {
    id: 'sort-merge',
    name: 'Merge Sort',
    type: 'Sorting Algorithm',
    timeComplexity: {
      best: 'O(n log n)',
      average: 'O(n log n)',
      worst: 'O(n log n)',
    },
    spaceComplexity: 'O(n)',
  },
  {
    id: 'sort-quick',
    name: 'Quick Sort',
    type: 'Sorting Algorithm',
    timeComplexity: {
      best: 'O(n log n)',
      average: 'O(n log n)',
      worst: 'O(n^2)',
    },
    spaceComplexity: 'O(log n)',
  },
  {
    id: 'graph-bfs',
    name: 'Breadth-First Search (BFS)',
    type: 'Graph Algorithm',
    timeComplexity: {
      best: 'O(V + E)',
      average: 'O(V + E)',
      worst: 'O(V + E)',
    },
    spaceComplexity: 'O(V)',
  },
  {
    id: 'graph-dfs',
    name: 'Depth-First Search (DFS)',
    type: 'Graph Algorithm',
    timeComplexity: {
      best: 'O(V + E)',
      average: 'O(V + E)',
      worst: 'O(V + E)',
    },
    spaceComplexity: 'O(V)',
  }
];