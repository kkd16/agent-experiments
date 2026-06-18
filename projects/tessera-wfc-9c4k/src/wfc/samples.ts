// Example bitmaps for the **overlapping** WFC model.
//
// The overlapping model doesn't take hand-authored tiles + edge codes; it *learns* its
// constraints from a small example image. Each sample below is a tiny indexed bitmap drawn as
// ASCII art with a colour legend — the algorithm slides an N×N window over it, harvests every
// pattern it sees (with optional rotations/reflections), counts how often each appears, and
// uses pattern-overlap agreement as its adjacency rule. The output is a brand-new, arbitrarily
// large image that locally looks like the input everywhere.

/** An indexed bitmap: a grid of palette indices plus the palette itself. */
export type Sample = {
  key: string;
  name: string;
  blurb: string;
  width: number;
  height: number;
  palette: string[]; // hex colours, indexed by the grid
  grid: Int32Array; // length width*height, values = palette indices
};

/**
 * Build a Sample from ASCII art. `legend` maps each character to a hex colour; the palette is
 * assembled in first-seen order. Rows are defensively normalised to a common width so a stray
 * typo degrades gracefully instead of crashing the studio.
 */
function fromArt(key: string, name: string, blurb: string, legend: Record<string, string>, rows: string[]): Sample {
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const height = rows.length;
  const palette: string[] = [];
  const indexOf = new Map<string, number>();
  const colorIndex = (hex: string): number => {
    let i = indexOf.get(hex);
    if (i === undefined) {
      i = palette.length;
      palette.push(hex);
      indexOf.set(hex, i);
    }
    return i;
  };
  // Ensure every legend colour exists in the palette even if a char goes unused.
  for (const ch of Object.keys(legend)) colorIndex(legend[ch]);
  const fallback = palette[0];
  const grid = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      const ch = x < row.length ? row[x] : row[row.length - 1] ?? ' ';
      const hex = legend[ch] ?? fallback;
      grid[y * width + x] = colorIndex(hex);
    }
  }
  return { key, name, blurb, width, height, palette, grid };
}

const flowers = fromArt(
  'flowers',
  'Flowers',
  'The classic WFC sample — flowers on stems rising from a strip of grass into open sky.',
  {
    B: '#9ad1ff',
    R: '#ef4444',
    Y: '#fbbf24',
    P: '#f472b6',
    S: '#3f9142',
    D: '#2f7d32',
    G: '#65a30d',
    T: '#7c4a17',
  },
  [
    'BBBBBBBBBBBBBB',
    'BBBBBBBBBBBBBB',
    'BBBRBBBBBBYBBB',
    'BBRRRBBBBYYYBB',
    'BBBRBBBBBBYBBB',
    'BBBSBBBBBBSBBB',
    'BBDSBBBBBBSDBB',
    'BBBSBBPBBBSBBB',
    'BBBSBPPPBBSBBB',
    'BBBSBBPBBBSBBB',
    'BBBSBBSBBBSBBB',
    'BBDSBBSBBBSDBB',
    'BBBSBBSBBBSBBB',
    'GGGGGGGGGGGGGG',
    'TTTTTTTTTTTTTT',
    'TTTTTTTTTTTTTT',
  ],
);

const maze = fromArt(
  'maze',
  'Maze',
  'One-wide corridors through thick walls. Looks great with full (8×) symmetry.',
  { W: '#0f172a', P: '#38bdf8' },
  [
    'WWWWWWWWWWWWW',
    'WPPPPPWPPPPPW',
    'WPWWWPWPWWWPW',
    'WPWPPPPPPPWPW',
    'WPWPWWWWWPWPW',
    'WPPPPWPWPPPPW',
    'WWWPWWPWWWPWW',
    'WPPPPWPWPPPPW',
    'WPWPWWWWWPWPW',
    'WPWPPPPPPPWPW',
    'WPWWWPWPWWWPW',
    'WPPPPPWPPPPPW',
    'WWWWWWWWWWWWW',
  ],
);

const rooms = fromArt(
  'rooms',
  'Rooms',
  'Dungeon rooms joined by doorways — walls, floors and the occasional door.',
  { '#': '#334155', F: '#cbd5e1', D: '#b45309' },
  [
    '#############',
    '#FFF#FFFFF#F#',
    '#FFF#FFFFFDF#',
    '#FFFDFFFFF#F#',
    '#FFF#FFFFF#F#',
    '##D####D#####',
    '#FFFFF#FFFFF#',
    '#FFFFFDFFFFF#',
    '#FFFFF#FFFFF#',
    '#FFFFF#FFFFF#',
    '#############',
  ],
);

const cave = fromArt(
  'cave',
  'Cave',
  'Organic rock and open ground — a two-tone cellular blob the solver keeps connected.',
  { R: '#1c1917', O: '#a8a29e', W: '#0e7490' },
  [
    'RRRRRRRRRRRRRR',
    'RRROOORRRRRRRR',
    'RROOOOOORRRRRR',
    'ROOOOOOOORRRRR',
    'ROOOWWOOOORRRR',
    'RROOWWWOOOORRR',
    'RRROOWWOOOOORR',
    'RRRROOOOOOORRR',
    'RRRRROOOOORRRR',
    'RRRRRROOORRRRR',
    'RRRRRRRRRRRRRR',
  ],
);

const skyline = fromArt(
  'skyline',
  'Skyline',
  'A night skyline: towers of two greys against a dark sky, lit windows glowing.',
  { B: '#111827', A: '#475569', C: '#64748b', w: '#fde047' },
  [
    'BBBBBBBBBBBBBB',
    'BBBBBBBBBBBBBB',
    'BBBBBAABBBBBBB',
    'BBBBBAwBBCCBBB',
    'BBAABAABBCwBBB',
    'BBAwBAwBBCCBBB',
    'BBAABAABBCwCBB',
    'BBAwBAwBBCCCBB',
    'AAAABAABCCwCBA',
    'AwAABAwBCCCCwA',
    'AAAABAABCwCCAA',
  ],
);

const island = fromArt(
  'island',
  'Island',
  'Concentric coastline: deep water, shallows, beach and a green interior.',
  { D: '#0c4a6e', W: '#0ea5e9', S: '#fde68a', G: '#4d7c0f' },
  [
    'DDDDDDDDDDDDDD',
    'DDDDDWWDDDDDDD',
    'DDDWWWWWWDDDDD',
    'DDWWWSSWWWDDDD',
    'DWWWSSSSWWWDDD',
    'DWWSSGGSSWWDDD',
    'DWWSGGGGSWWDDD',
    'DWWSSGGSSWWDDD',
    'DWWWSSSSWWWDDD',
    'DDWWWSSWWWDDDD',
    'DDDWWWWWWDDDDD',
    'DDDDDWWDDDDDDD',
    'DDDDDDDDDDDDDD',
  ],
);

const circuit = fromArt(
  'circuit',
  'Circuit',
  'A PCB: green traces and gold pads routed across a dark board.',
  { b: '#052e16', t: '#22c55e', p: '#eab308' },
  [
    'bbbbbbbbbbbbb',
    'bptttbpttttpb',
    'bbbbtbtbbbbtb',
    'bpbbtbtbbpbtb',
    'bbtttttttbbtb',
    'bbtbbbbbbbbtb',
    'bpttptbbptttb',
    'bbbbtbbbtbbbb',
    'bptbtbbbtbbpb',
    'bbtbtttttbbtb',
    'bbttttbbbtttb',
    'bpbbbbbbbbbpb',
    'bbbbbbbbbbbbb',
  ],
);

const chevron = fromArt(
  'chevron',
  'Chevron',
  'A purely geometric diagonal weave — handy for seeing how patterns recombine.',
  { A: '#7c3aed', B: '#06b6d4', C: '#f59e0b' },
  [
    'AABBCCAABBCC',
    'ABBCCAABBCCA',
    'BBCCAABBCCAA',
    'BCCAABBCCAAB',
    'CCAABBCCAABB',
    'CAABBCCAABBC',
    'AABBCCAABBCC',
    'ABBCCAABBCCA',
    'BBCCAABBCCAA',
    'BCCAABBCCAAB',
    'CCAABBCCAABB',
    'CAABBCCAABBC',
  ],
);

export const SAMPLES: Sample[] = [flowers, maze, rooms, cave, skyline, island, circuit, chevron];

export function sampleByKey(key: string): Sample {
  return SAMPLES.find((s) => s.key === key) ?? SAMPLES[0];
}

/** A small, friendly blank canvas for the editor to start from. */
export function blankSample(width = 12, height = 12, palette?: string[]): Sample {
  const pal = palette ?? ['#0b0f14', '#e2e8f0', '#ef4444', '#22c55e', '#3b82f6', '#fbbf24', '#a855f7', '#ec4899'];
  return {
    key: 'custom',
    name: 'Custom',
    blurb: 'Your own hand-drawn sample.',
    width,
    height,
    palette: pal.slice(),
    grid: new Int32Array(width * height),
  };
}
