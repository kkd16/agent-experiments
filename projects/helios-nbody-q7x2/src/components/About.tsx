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
        <p>
          For long, accurate integrations Helios climbs the order ladder with <strong>Yoshida 4</strong>{' '}
          and <strong>Yoshida 6</strong> — symmetric compositions of three and seven leapfrog substeps
          (several stepping <em>backwards</em> in time) whose error terms cancel to leave O(Δt⁴) and
          O(Δt⁶) error while staying exactly symplectic. At equal Δt, Yoshida 6 conserves energy tens of
          thousands of times better than Yoshida 4, which is itself ~10⁴× better than Verlet — near
          machine precision. Every symplectic scheme here is also <strong>time-reversible</strong>:
          the self-test integrates an orbit forward, flips every velocity, and watches it retrace its
          path back to the start.
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

        <h2>Chaos: MEGNO &amp; Lyapunov exponents</h2>
        <p>
          Is an orbit <em>predictable</em> forever, or does it have a horizon? The{' '}
          <strong>Chaos Lab</strong> answers this from first principles. It evolves an infinitesimal
          deviation vector <code>δ</code> alongside the real trajectory under the{' '}
          <em>variational equations</em> — the linearised flow, whose force gradient is the analytic{' '}
          <strong>tidal tensor</strong> (verified against a finite difference in the self-test). Two
          numbers fall out. The maximal <strong>Lyapunov exponent</strong> <code>λ</code> (Benettin's
          method: renormalise <code>δ</code> each step, accumulate the log of its stretch) measures
          exponential divergence — <code>λ ≈ 0</code> is regular, <code>λ &gt; 0</code> is chaos with
          e-folding time <code>1/λ</code>. <strong>MEGNO</strong> <code>⟨Y⟩</code> (Cincotta &amp;
          Simó) converges far faster: it tends to exactly <code>2</code> for a quasi-periodic orbit and
          grows linearly as <code>(λ/2)·t</code> for a chaotic one. Run it on the{' '}
          <em>Figure-Eight</em> (regular, <code>⟨Y⟩ → 2</code>) and then the <em>Broken Eight</em> or{' '}
          <em>Pythagorean 3-body</em> (chaotic, <code>⟨Y⟩ ≫ 2</code>) to watch the indicator tell order
          from chaos in systems that look almost identical at first.
        </p>

        <h2>Frequency analysis: NAFF &amp; frequency maps</h2>
        <p>
          A bound orbit is <em>quasi-periodic</em>: its complex coordinate{' '}
          <code>z(t) = x + i·y</code> is a sum of pure tones whose frequencies are integer
          combinations of a few <strong>fundamental frequencies</strong>. The{' '}
          <strong>Spectral Lab</strong> recovers them with <strong>NAFF</strong> (Laskar's Numerical
          Analysis of Fundamental Frequencies). It evolves a shadow copy of the system to record a
          long, clean track of the selected body, multiplies it by a <em>Hann window</em> (so spectral
          leakage collapses and the windowed correlation's error falls as <code>1/T⁴</code> instead of
          the FFT's <code>1/T</code>), finds the dominant frequency with a hand-written{' '}
          <strong>FFT</strong> and then refines it <em>between</em> bins by a golden-section search —
          reaching frequencies to a part in <code>10⁸</code> of a bin width. Each tone is projected out
          and the search repeats, and the amplitudes are recovered jointly by solving the small complex
          Gram system. The result is the orbit's mean motion, its harmonic line spectrum, and the
          prograde/retrograde split — read straight off the dynamics.
        </p>
        <p>
          Measuring the fundamental on the <em>first</em> versus the <em>second</em> half of the track
          gives <strong>frequency-map analysis</strong> (Laskar 1990) — the chaos diagnostic that
          mapped the chaotic zones of the Solar System. A regular orbit sits on an invariant torus, so
          its frequency is frozen and the drift <code>|Δν/ν|</code> is essentially zero; a chaotic orbit
          wanders across resonances and its frequency drifts measurably. It is an independent,
          frequency-domain check on the Chaos Lab's time-domain MEGNO and Lyapunov verdict — and in the
          self-test the circular orbit's drift (<code>~10⁻¹⁶</code>) and the Pythagorean problem's
          (<code>~10⁰</code>) are sixteen orders of magnitude apart.
        </p>

        <h2>Poincaré surface-of-section</h2>
        <p>
          A trajectory is a tangle; its <strong>section</strong> is not. The{' '}
          <strong>Poincaré Lab</strong> watches a test particle in the{' '}
          <em>co-rotating frame</em> of the two heaviest bodies — where the primaries hang still — and
          stamps a dot every time it crosses the line <code>η = 0</code> moving upward, recording
          (<code>ξ</code>, <code>ξ̇</code>). The Poincaré–Birkhoff picture then reads straight off the
          scatter: a <strong>regular</strong> orbit lives on an invariant torus whose slice is a smooth
          closed curve, so the dots trace a loop; a <strong>chaotic</strong> orbit is hemmed in only by
          the Jacobi integral, so its dots fill a two-dimensional patch. The lab also reports the spread
          of the Jacobi constant across the crossings — near zero confirms the frame is a genuine
          restricted three-body problem (it is verified to machine level in the self-test). Try it on
          the <em>Three-Body Waltz</em> or <em>Horseshoe &amp; Tadpole</em>.
        </p>

        <h2>General relativity: the perihelion of Mercury</h2>
        <p>
          Newtonian gravity makes every bound orbit a perfectly closed ellipse. General
          relativity does not: it adds a tiny correction that makes the ellipse slowly{' '}
          <strong>rotate</strong>, advancing its periapsis a little every revolution. For
          Mercury this <em>perihelion advance</em> is the famous <strong>43 arc-seconds per
          century</strong> that, after every planetary tug is subtracted, Newtonian gravity
          simply could not account for — and whose exact prediction was general relativity's
          first triumph.
        </p>
        <p>
          Turn on <em>Relativity (1PN)</em> (key <code>g</code>) and Helios adds the leading{' '}
          <strong>first post-Newtonian</strong> correction about the heaviest body:{' '}
          <code>a₁ₚₙ = (μ/c²r³)[(4μ/r − v²)r + 4(r·v)v]</code>, with an equal-and-opposite
          reaction on the central mass so total momentum is conserved exactly. Dial the{' '}
          <em>speed of light c</em> down and the relativistic strength <code>∝ 1/c²</code>{' '}
          grows until the precession is visible in seconds — load <em>GR Precession</em> to
          watch two eccentric orbits wind into rotating <strong>rosettes</strong>, the inner
          one (deeper in the field) turning faster.
        </p>
        <p>
          The <strong>Relativity Lab</strong> makes it quantitative. It integrates a body
          around a central mass with the 1PN term on a 4th-order Runge–Kutta, detects each
          periapsis passage and averages the azimuthal advance, then checks the measured
          precession against the closed-form{' '}
          <code>Δϖ = 6πμ / (c²a(1 − e²))</code> per orbit. The agreement is exact in the weak
          field and departs by a known, growing fraction as <code>v/c</code> rises — the
          genuine higher-order post-Newtonian terms. Feed the very same formula Mercury's real
          numbers and it returns <strong>42.98″/century</strong>.
        </p>

        <h2>Run the numbers yourself</h2>
        <p>
          None of the above is taken on faith. The button below runs a battery of numerical checks in
          your browser — that the orbit solver recovers known elements, that Yoshida 4 beats Verlet and
          Yoshida 6 beats Yoshida 4 at energy conservation, that Verlet is time-reversible, that the
          tidal tensor is the exact gradient of the force, that the Lagrange points are genuine
          equilibria (<code>∇Ω ≈ 0</code>), that momentum is conserved, that the virial theorem holds,
          that MEGNO recognises a regular orbit (<code>⟨Y⟩ → 2</code>) yet flags the Pythagorean
          three-body problem as chaotic — and that the engine's relativistic precession matches the
          closed-form GR formula, reproducing Mercury's 43″/century.
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
          <li>Open the <em>Chaos Lab</em> and analyse the <em>Figure-Eight</em> (⟨Y⟩ → 2), then the <em>Broken Eight</em> — the same orbit nudged 0.4%, now chaotic. Watch MEGNO and λ tell them apart.</li>
          <li>Open <em>Kepler Showcase</em>, click a planet, open the <em>Spectral Lab</em> and press <code>n</code> — read its mean motion and harmonic spectrum, then compare the frequency-diffusion verdict against the same planet in a chaotic preset.</li>
          <li>Load <em>Three-Body Waltz</em>, open the <em>Poincaré Lab</em> and press <code>k</code> — watch the section dots trace a clean invariant curve, the signature of a regular orbit.</li>
          <li>Open <em>GR Precession</em>, turn on motion trails, and watch the eccentric orbits wind into rosettes — then press <code>g</code> to switch relativity off and see them snap back to closed ellipses.</li>
          <li>Open the <em>Relativity Lab</em>, lower <em>c</em>, and press <em>Measure precession</em> — read the integrated advance against the exact 6πμ/(c²a(1−e²)), and see Mercury's real 43″/century.</li>
          <li>Click a planet in <em>Solar System</em> to read its orbital energy, then <em>Share</em> a permalink to your setup.</li>
        </ul>

        <p className="about-foot">
          Built with React + TypeScript and a hand-rolled Barnes–Hut engine running on typed arrays.
          No WebGL, no physics library — just maths and a Canvas. Shortcuts: Space play/pause,
          <code>.</code> step, <code>f</code> fit, <code>t</code> trails, <code>c</code> collisions,
          <code>p</code> predict, <code>o</code> orbit, <code>l</code> Lagrange, <code>g</code> relativity,
          <code>y</code> chaos, <code>n</code> spectrum, <code>k</code> section, <code>r</code> reseed,
          <code>s</code> share, <code>e</code> PNG.
        </p>
      </div>
    </div>
  )
}
