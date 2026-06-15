// An overlay explaining the physics and numerics behind the simulator, with a
// built-in self-test that re-derives Helios's physical claims at runtime.

import { useState } from 'react'
import { runSelfTest } from '../sim/selftest'
import type { SelfTestReport } from '../sim/selftest'

interface Props {
  onClose: () => void
}

export function About({ onClose }: Props) {
  const [report, setReport] = useState<SelfTestReport | null>(null)
  const [running, setRunning] = useState(false)

  const runTests = () => {
    setRunning(true)
    // Defer so the button can paint its "running" state before the sync work.
    setTimeout(() => {
      setReport(runSelfTest())
      setRunning(false)
    }, 20)
  }

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
          to <strong>inspect</strong> its live mass, speed and full Kepler orbit relative to the
          system's primary.
        </p>

        <h2>Osculating orbits</h2>
        <p>
          Select a body and Helios reconstructs the <strong>osculating orbit</strong> it rides right
          now — the Kepler ellipse it would follow forever if every other perturbation vanished. From
          the relative state vector it solves the <em>eccentricity vector</em> (shape and orientation)
          and the <em>vis-viva</em> energy (size), then draws the conic with ticks at periapsis and
          apoapsis. Watch a perturbed orbit drift frame-to-frame against its own osculating ellipse —
          that drift <em>is</em> orbital precession. Try <em>Kepler Showcase</em> with the overlay on.
        </p>

        <h2>Lagrange points &amp; Hill regions</h2>
        <p>
          Turn on <em>Lagrange &amp; Hill curves</em> and Helios treats the two heaviest bodies as the
          primaries of the <strong>restricted three-body problem</strong>. It solves the five
          equilibrium points — collinear <code>L1–L3</code> as roots of the co-rotating effective
          potential, triangular <code>L4/L5</code> at the equilateral apices — and traces the
          <em>zero-velocity (Hill-region) curves</em> of the Jacobi integral. Load <em>Horseshoe &amp;
          Tadpole</em> or <em>Trojan Swarms</em> to see particles trapped in exactly those wells.
          Click any test particle and the inspector reports its <strong>Jacobi constant</strong> —
          the single integral of motion the restricted problem conserves.
        </p>

        <h2>Run the numbers yourself</h2>
        <p>
          None of the above is taken on faith. The button below runs a battery of numerical checks in
          your browser — that the orbit solver recovers known elements, that Yoshida 4 beats Verlet at
          energy conservation, that the Lagrange points are genuine equilibria (<code>∇Ω ≈ 0</code>),
          that momentum is conserved and that the virial theorem holds.
        </p>
        <div className="selftest">
          <button type="button" className="btn primary" onClick={runTests} disabled={running}>
            {running ? 'Running…' : '▶ Run physics self-test'}
          </button>
          {report && (
            <div className="selftest-results">
              <div className={`selftest-summary ${report.ok ? 'good' : 'bad'}`}>
                {report.passed}/{report.total} checks passed {report.ok ? '✓' : '✗'}
              </div>
              {report.cases.map((c) => (
                <div key={c.name} className="selftest-case">
                  <span className={`selftest-mark ${c.pass ? 'good' : 'bad'}`}>{c.pass ? '✓' : '✗'}</span>
                  <span className="selftest-name">{c.name}</span>
                  <span className="selftest-detail">{c.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <h2>Try this</h2>
        <ul>
          <li>Load <em>Galaxy Collision</em> and watch tidal tails and bridges form.</li>
          <li>Open <em>Figure-Eight</em>, turn on orbit prediction, then switch to <em>Explicit Euler</em> and watch the choreography unravel.</li>
          <li>Run the <em>Pythagorean 3-Body</em> problem — deterministic, yet it ends by ejecting a body and leaving a binary.</li>
          <li>Enable <em>Collisions</em> on <em>Cold Collapse</em> to watch a swarm accrete into a handful of massive clumps.</li>
          <li>Open <em>Kepler Showcase</em>, enable the <em>Osculating orbit</em> overlay, and click each planet to see its ellipse and elements.</li>
          <li>Load <em>Horseshoe &amp; Tadpole</em>, press <code>l</code> for the Lagrange overlay, and watch particles librate around L4/L5.</li>
          <li>Run the <em>Three-Body Waltz</em> on Yoshida 4 — a hierarchical triple that stays bound indefinitely.</li>
          <li>Click a planet in <em>Solar System</em> to read its orbital energy, then <em>Share</em> a permalink to your setup.</li>
        </ul>

        <p className="about-foot">
          Built with React + TypeScript and a hand-rolled Barnes–Hut engine running on typed arrays.
          No WebGL, no physics library — just maths and a Canvas. Shortcuts: Space play/pause,
          <code>.</code> step, <code>f</code> fit, <code>t</code> trails, <code>c</code> collisions,
          <code>p</code> predict, <code>o</code> orbit, <code>l</code> Lagrange, <code>r</code> reseed,
          <code>s</code> share, <code>e</code> PNG.
        </p>
      </div>
    </div>
  )
}
