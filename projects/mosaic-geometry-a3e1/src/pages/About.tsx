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
            <strong>Convex hull</strong> — the tightest convex boundary, via Andrew's monotone chain
            in O(n log n).
          </li>
          <li>
            <strong>Euclidean MST &amp; Gabriel graph</strong> — proximity graphs that live inside the
            Delaunay edges, so they fall out almost for free once the triangulation exists.
          </li>
          <li>
            <strong>Lloyd relaxation</strong> — iteratively move each site to its cell's centroid to
            reach a centroidal Voronoi tessellation: the even, organic "soap-film" pattern.
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
          Kruskal and a union-find, and the Gabriel graph is a simple filter on the same edges.
          Point generation offers uniform, jittered-grid, and Bridson blue-noise (Poisson-disk)
          distributions, all seeded for reproducibility.
        </p>

        <h2>Tips</h2>
        <ul>
          <li>Click empty space to drop a point; drag to move it and watch every structure follow.</li>
          <li>Shift-click or right-click a point to remove it.</li>
          <li>Turn on Delaunay + Voronoi together to see the dual relationship.</li>
          <li>Generate blue noise, then hit <em>Animate</em> to relax it into a honeycomb.</li>
          <li>Open the <strong>Algorithms</strong> tab to step through the hull and Delaunay builds.</li>
        </ul>

        <p className="colophon">
          Built with React + TypeScript and an HTML5 canvas. No geometry libraries — every algorithm
          here is implemented from scratch and exercised by an in-repo test suite.
        </p>
      </article>
    </div>
  )
}
