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
            <strong>Convex hull</strong> — the tightest convex boundary, via Andrew's monotone chain
            in O(n log n).
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
          <li>Open the <strong>Algorithms</strong> tab to step through the hull, Delaunay, enclosing-circle, and Fortune sweep builds.</li>
        </ul>

        <p className="colophon">
          Built with React + TypeScript and an HTML5 canvas. No geometry libraries — every algorithm
          here is implemented from scratch and exercised by an in-repo test suite of 54 checks.
        </p>
      </article>
    </div>
  )
}
