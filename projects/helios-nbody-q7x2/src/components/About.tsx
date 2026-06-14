// An overlay explaining the physics and numerics behind the simulator.

interface Props {
  onClose: () => void
}

export function About({ onClose }: Props) {
  return (
    <div className="about-backdrop" onClick={onClose}>
      <div className="about" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="about-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <h1>Helios</h1>
        <p className="tagline">A real-time gravitational N-body studio, in your browser.</p>

        <h2>What you are looking at</h2>
        <p>
          Every glowing point is a body — a star, a clump of dark matter, a planet — moving under
          nothing but Newtonian gravity. There is no scripted animation: positions are integrated
          forward in time from the mutual gravitational pull of all the others.
        </p>

        <h2>Barnes–Hut: O(n log n) gravity</h2>
        <p>
          Computing every pairwise force is O(n²) — hopeless past a few thousand bodies. Helios
          builds a <strong>quadtree</strong> each frame and approximates distant clusters by their
          centre of mass. A node of width <code>s</code> seen at distance <code>d</code> is treated
          as a single point mass when <code>s/d &lt; θ</code>. Turn on <em>Show quadtree</em> to watch
          space subdivide around dense regions, and drag <em>θ</em> to trade accuracy for speed.
          Flip on <em>Potential field</em> to sample that same tree across the screen and paint the
          gravitational wells the bodies are falling into.
        </p>

        <h2>Symplectic integration</h2>
        <p>
          Orbits are a stiff test of numerical integrators. <strong>Velocity Verlet</strong> and{' '}
          <strong>Leapfrog</strong> are <em>symplectic</em>: they conserve a nearby "shadow" energy
          exactly, so the <em>Energy drift</em> trace stays flat for millions of steps. Switch to{' '}
          <strong>Explicit Euler</strong> and watch the same trace ramp away as the system unphysically
          gains energy — then to <strong>RK4</strong>, which is high-order yet still drifts because it
          is not symplectic. The conservation plots are computed independently of the force solver, so
          they are an honest report card.
        </p>

        <h2>Softening</h2>
        <p>
          Point masses produce infinite forces at zero separation. We use{' '}
          <strong>Plummer softening</strong>, replacing <code>1/r²</code> with{' '}
          <code>1/(r² + ε²)</code>. Larger <em>ε</em> yields smoother, more fluid-like dynamics; smaller
          ε resolves tight encounters but demands a smaller timestep.
        </p>

        <h2>Collisions &amp; accretion</h2>
        <p>
          Turn on <em>Collisions</em> and bodies that touch <strong>merge inelastically</strong>,
          conserving total mass, momentum and the centre of mass — the merged body inherits a
          larger capture radius <code>R = scale · m^(1/3)</code>, so a growing seed sweeps up its
          neighbours faster and faster. Neighbours are found with a uniform spatial hash, so the
          whole pass stays linear. Fling a heavy <em>Slingshot</em> body through a galaxy and watch
          it accrete a trail of stars.
        </p>

        <h2>Forecasting orbits</h2>
        <p>
          <em>Predict orbits</em> evolves a hidden copy of the entire system forward in time and
          draws the future paths of the heaviest bodies and whichever body you have selected. Because
          it integrates the real N-body forces, the forecast bends as the system does. Click any body
          to <strong>inspect</strong> its live mass, speed and two-body orbital energy relative to the
          system's primary.
        </p>

        <h2>Try this</h2>
        <ul>
          <li>Load <em>Galaxy Collision</em> and watch tidal tails and bridges form.</li>
          <li>Open <em>Figure-Eight</em>, turn on orbit prediction, then switch to <em>Explicit Euler</em> and watch the choreography unravel.</li>
          <li>Run the <em>Pythagorean 3-Body</em> problem — deterministic, yet it ends by ejecting a body and leaving a binary.</li>
          <li>Enable <em>Collisions</em> on <em>Cold Collapse</em> to watch a swarm accrete into a handful of massive clumps.</li>
          <li>Click a planet in <em>Solar System</em> to read its orbital energy, then <em>Share</em> a permalink to your setup.</li>
        </ul>

        <p className="about-foot">
          Built with React + TypeScript and a hand-rolled Barnes–Hut engine running on typed arrays.
          No WebGL, no physics library — just maths and a Canvas. Shortcuts: Space play/pause,
          <code>.</code> step, <code>f</code> fit, <code>t</code> trails, <code>c</code> collisions,
          <code>p</code> predict, <code>r</code> reseed, <code>s</code> share, <code>e</code> PNG.
        </p>
      </div>
    </div>
  )
}
