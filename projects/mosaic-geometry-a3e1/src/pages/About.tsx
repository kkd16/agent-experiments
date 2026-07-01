export default function About() {
  return (
    <div className="about">
      <article className="prose">
        <h1>Mosaic</h1>
        <p className="lead">
          A computational-geometry studio. Scatter points across the plane and watch the classic
          structures of the field assemble in real time — convex hulls, Delaunay triangulations,
          Voronoi diagrams, proximity graphs — then relax them into living tessellations.
        </p>

        <h2>What you can build</h2>
        <ul>
          <li>
            <strong>Voronoi diagram</strong> — every point of the plane is colored by its nearest
            site. Computed exactly by intersecting half-planes (perpendicular bisectors), so each
            cell is a clean convex polygon clipped to the frame.
          </li>
          <li>
            <strong>Delaunay triangulation</strong> — the dual of the Voronoi diagram and the
            triangulation that maximizes the smallest angle. Built incrementally with the
            Bowyer-Watson algorithm and the in-circle predicate.
          </li>
          <li>
            <strong>Fortune's sweep-line Voronoi</strong> — the same diagram by a wholly different
            route: a line sweeps the plane while a <em>beach line</em> of parabolas tracks the
            emerging cells, processing site and circle events out of a binary heap. Watch it animate
            on the Algorithms tab; its Delaunay dual is verified to match Bowyer-Watson edge-for-edge.
          </li>
          <li>
            <strong>Convex hull</strong> — the tightest convex boundary, by two independent
            algorithms: Andrew's monotone chain (sort + left-turn sweep) and{' '}
            <strong>Quickhull</strong> (divide-and-conquer on the farthest point from each edge). The
            two are verified to agree on every scene; step through Quickhull's recursion on the
            Algorithms tab.
          </li>
          <li>
            <strong>Proximity-graph family</strong> — a tidy nesting that all lives inside the
            Delaunay edges: the <em>nearest-neighbor graph</em> ⊆ <em>Euclidean MST</em> ⊆{' '}
            <em>relative-neighborhood graph</em> ⊆ <em>Urquhart graph</em> ⊆ <em>Gabriel graph</em> ⊆
            Delaunay. Toggle them together to watch each one thin the last.
          </li>
          <li>
            <strong>β-skeleton family</strong> — one knob that sweeps a whole family of proximity
            graphs. The lune-based β-skeleton keeps edge (a,b) when the intersection of two disks
            sized by β is empty; β = 1 reproduces the Gabriel graph and β = 2 the
            relative-neighborhood graph, with a continuum in between.
          </li>
          <li>
            <strong>k-nearest-neighbor graph</strong> — connect each site to its k closest
            neighbours and take the undirected union. Slide k from 1 (the nearest-neighbor graph)
            upward to watch the connectivity thicken.
          </li>
          <li>
            <strong>Alpha shapes</strong> — a one-parameter "concave hull". Picture an eraser disk of
            radius α rolling over the points; drop the Delaunay triangles it can swallow and the
            boundary that's left hugs the cloud, opening up concavities and holes. Slide α from a
            tight outline up to the full convex hull — or hit <em>Sweep α</em> to animate it.
          </li>
          <li>
            <strong>Ruppert's quality mesh</strong> — Delaunay <em>refinement</em>: split encroached
            boundary edges and insert circumcenters of skinny triangles until every angle clears a
            bound you choose. A raw cloud with 1° slivers becomes a clean mesh with a guaranteed
            minimum angle; the inserted Steiner points show as amber dots.
          </li>
          <li>
            <strong>Constrained Delaunay</strong> — force chosen segments to appear as edges. Pick
            two points to pin a constraint; the triangulation flips edges (Lawson's algorithm) until
            the segment is present, then restores the Delaunay property everywhere else. The pinned
            edges stay put even when they cut against what Delaunay would prefer.
          </li>
          <li>
            <strong>Convex layers</strong> — peel the hull, recurse on what's inside, repeat. The
            nested rings ("onion peeling") underlie convex-hull depth in robust statistics.
          </li>
          <li>
            <strong>Lloyd relaxation</strong> — iteratively move each site to its cell's centroid to
            reach a centroidal Voronoi tessellation: the even, organic "soap-film" pattern.
          </li>
        </ul>

        <h2>Weighted &amp; farthest geometry</h2>
        <p>
          A second axis: drop the assumption that every site counts the same, or flip "nearest" to
          "farthest". Both are still built from the one robust half-plane-intersection routine — only
          the line that splits two sites changes.
        </p>
        <ul>
          <li>
            <strong>Power (Laguerre) diagram</strong> — give each site a weight <em>w</em> and measure
            distance by the <em>power</em> |x − s|² − w. The wall between two sites is their{' '}
            <em>radical axis</em> (still straight, just shifted toward the lighter site), so the cells
            stay convex. Heavy sites swell, light ones shrink, and an out-weighted site can vanish
            entirely — a <em>hidden</em> site, drawn as a hollow ring. With equal weights it collapses
            back to the ordinary Voronoi diagram. Watch one cell get clipped against each radical axis
            on the Algorithms tab, or run <em>Power-Lloyd</em> to relax toward a centroidal power
            tessellation.
          </li>
          <li>
            <strong>Regular (weighted Delaunay) triangulation</strong> — the straight-line dual of the
            power diagram, read off the cell adjacencies. It reduces to the Delaunay triangulation
            exactly when all weights are equal.
          </li>
          <li>
            <strong>Farthest-point Voronoi diagram</strong> — the inside-out twin: each region is keyed
            to its <em>farthest</em> site. Only convex-hull vertices own a (non-empty) cell, and the
            diagram has no bounded faces — it is a tree. A lovely consequence is highlighted live: the
            centre of the smallest enclosing circle sits on this diagram.
          </li>
        </ul>

        <h2>Measurements</h2>
        <p>
          The <strong>Measure</strong> panel overlays single, exact shapes computed from the same
          backbone:
        </p>
        <ul>
          <li>
            <strong>Closest pair</strong> — always a Delaunay edge, so the shortest edge is the
            answer; no O(n²) scan needed.
          </li>
          <li>
            <strong>Diameter &amp; minimum width</strong> — the farthest two points and the thinnest
            parallel-line slab, both swept off the hull by <em>rotating calipers</em> in O(h).
          </li>
          <li>
            <strong>Smallest enclosing circle</strong> — Welzl's randomized algorithm, expected
            linear time, pinned by two or three points. Step through it on the Algorithms tab.
          </li>
          <li>
            <strong>Largest empty circle</strong> — the biggest site-free disk centred inside the
            hull. Its centre is a Voronoi vertex, i.e. a Delaunay circumcentre, so it's just the
            fattest circumcircle whose centre lands inside the hull.
          </li>
        </ul>

        <h2>Spatial search &amp; hierarchies</h2>
        <p>
          A third axis: not <em>constructing</em> a structure but <em>querying</em> one. The{' '}
          <strong>Search</strong> tab is an interactive playground — overlay a partition, move the
          probe, and every answer is checked live against an O(n) brute-force scan, with the
          nodes-touched count showing the speed-up.
        </p>
        <ul>
          <li>
            <strong>k-d tree</strong> — a balanced binary tree that splits the points at the median
            along an axis that alternates with depth. Each node owns a slab of the plane, so{' '}
            <em>nearest-neighbour</em>, <em>k-nearest</em> and <em>orthogonal range</em> queries can
            prune any subtree that can't beat the best-so-far (or misses the window) — touching only a
            handful of the n points instead of all of them.
          </li>
          <li>
            <strong>Point-region quadtree</strong> — where the k-d tree splits at the data, the
            quadtree splits at <em>space</em>: a cell that overflows divides into four equal
            quadrants. The grid is fine where points cluster and coarse where they're sparse.
          </li>
          <li>
            <strong>Point location</strong> — "which triangle contains this point?" answered by the{' '}
            <em>jump-and-walk</em>: start at a triangle and step across whichever edge the query lies
            outside of, until one contains it. On a Delaunay mesh the oriented walk always terminates,
            and the dashed trail shows the path it took.
          </li>
          <li>
            <strong>Approximate nearest neighbour</strong> — exact NN can be forced to unwind most of
            the tree; <em>best-bin-first</em> instead explores subtrees in order of how close their
            region is to the query (a priority queue keyed by region distance) and stops as soon as no
            unopened region can beat the best found by more than a (1+ε) factor. The answer is provably
            within (1+ε) of the true nearest — for a fraction of the visits. Toggle it on in the{' '}
            <strong>Search</strong> tab and watch the amber marker track the exact green one as you
            trade ε for speed.
          </li>
          <li>
            <strong>Range tree with fractional cascading</strong> — orthogonal range <em>reporting</em>{' '}
            in O(log n + k): a balanced BST on x, each node carrying its subtree's points sorted by y.
            Fractional cascading threads a pointer from every y-entry to the first ≥-entry of each
            child, so the y-search happens <em>once</em> at the top of the query path and is then
            followed downward for free — collapsing the naïve O(log² n) to O(log n). The Search tab's
            range mode shows how few canonical subtrees it opens next to the k-d tree's region scan.
          </li>
          <li>
            <strong>Geometric spanners</strong> — sparse graphs that still approximate every distance.
            A <em>t-spanner</em> keeps each pair's shortest path within t× the straight line. The{' '}
            <em>Yao</em> and <em>Θ</em> graphs keep one edge per direction-cone; the <em>greedy</em>{' '}
            spanner adds edges shortest-first only where the graph can't already get within t; and the{' '}
            <em>WSPD-spanner</em> draws one edge per well-separated pair for a linear-size t-spanner.
            The realized <em>dilation</em> is measured by all-pairs shortest path and shown live.
          </li>
        </ul>

        <h2>Space-filling curves</h2>
        <p>
          The <strong>Curves</strong> tab is a fourth axis: turning 2-D proximity into a 1-D order. A
          space-filling curve visits every cell of a 2ⁿ×2ⁿ grid exactly once, and sorting a point
          cloud along it gives a cache-friendly linear layout whose consecutive hops stay short.
        </p>
        <ul>
          <li>
            <strong>Morton (Z-order)</strong> — interleave the bits of x and y. Trivial to compute and
            the backbone of quadtrees and geohashes, but its "Z" jumps leak locality: cells adjacent on
            the curve can be far apart in the plane.
          </li>
          <li>
            <strong>Hilbert</strong> — a recursively rotated "U" whose consecutive indices are{' '}
            <em>always</em> grid-neighbours, so it never jumps. Raise the order to watch it subdivide;
            switch to the point tour to see it thread a real cloud, and read the locality metric — the
            total tour length — confirm Hilbert beats Morton every time.
          </li>
        </ul>

        <h2>The predicates</h2>
        <p>
          Everything rests on two determinants. The <em>orientation</em> test tells whether three
          points turn left, right, or stay collinear — it drives the hull's left-turn rule and keeps
          triangles consistently wound. The <em>in-circle</em> test asks whether a fourth point lies
          inside the circumcircle of a triangle — the single check that makes a triangulation
          Delaunay. Both are evaluated in coordinates relative to the query point to keep
          floating-point error small.
        </p>

        <h2>Why it stays fast</h2>
        <p>
          The Delaunay mesh is the backbone: the triangulation gives the Voronoi topology, the
          minimum spanning tree is computed over Delaunay edges (a known superset of the EMST) with
          Kruskal and a union-find, the proximity graphs and alpha shapes are filters on the same
          edges or triangles, and the closest pair and largest empty circle read straight off them.
          Only the cheap O(n)/O(h) measurements recompute every frame; the heavier graph layers are
          built lazily, the moment you toggle them on. Point generation offers uniform,
          jittered-grid, and Bridson blue-noise (Poisson-disk) distributions, all seeded for
          reproducibility.
        </p>

        <h2>Share &amp; import</h2>
        <p>
          Every layout is portable. <strong>Copy link</strong> packs the points into a compact,
          URL-safe token (each axis quantized to 12 bits, two per three bytes) so a link rebuilds the
          exact scene; <strong>Copy coords</strong> exports plain text. Paste your own coordinates in
          any delimiters — values outside the unit square are fit into the frame with their aspect
          ratio preserved, so raw pixel or data coordinates just work.
        </p>

        <h2>Tips</h2>
        <ul>
          <li>Click empty space to drop a point; drag to move it and watch every structure follow.</li>
          <li>Shift-click or right-click a point to remove it.</li>
          <li>Turn on Delaunay + Voronoi together to see the dual relationship.</li>
          <li>Stack the proximity graphs (NNG → MST → RNG → Urquhart → Gabriel) to see each refine the last.</li>
          <li>Enable the alpha shape and sweep its slider to morph a concave hull into the convex one.</li>
          <li>Generate blue noise, then hit <em>Animate</em> to relax it into a honeycomb.</li>
          <li>Slide β from 1 to 2 to morph the Gabriel graph into the relative-neighborhood graph.</li>
          <li>In the <strong>Mesh</strong> panel, pick an angle bound and hit <em>Refine mesh</em> to watch Ruppert clean up the slivers.</li>
          <li>Turn on <strong>Power cells</strong>, hit <em>Randomize weights</em>, and add the regular triangulation to see Voronoi's weighted cousin and its dual.</li>
          <li>Enable the <strong>Farthest-point</strong> diagram to see the hull-vertex tree and the enclosing-circle centre that rides on it.</li>
          <li>Open the <strong>Algorithms</strong> tab to step through the hull, Quickhull, Delaunay, enclosing-circle, Fortune sweep, power-cell, k-d tree, and quadtree builds.</li>
          <li>Open the <strong>Search</strong> tab, turn on the k-d partition, and move the probe to watch nearest-neighbour search prune — then flip on <em>Approximate</em> and raise ε to trade accuracy for visits, or drag a window to race the range tree's canonical subtrees against the k-d scan.</li>
          <li>Open the <strong>Curves</strong> tab, hit <em>Play</em> to sweep a Hilbert curve through the grid, then switch to the point tour and compare its locality against Z-order.</li>
        </ul>

        <p className="colophon">
          Built with React + TypeScript and an HTML5 canvas. No geometry libraries — every algorithm
          here is implemented from scratch and exercised by an in-repo test suite of 161 checks.
        </p>
      </article>
    </div>
  )
}
