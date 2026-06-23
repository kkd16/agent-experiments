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

        <h2>Gravitational waves: the inspiral chirp</h2>
        <p>
          The relativity above is <em>conservative</em> — it makes the orbit precess but never
          decay. The other half of relativistic two-body motion is <em>dissipative</em>: an
          orbiting pair radiates <strong>gravitational waves</strong>, bleeds orbital energy and
          angular momentum, and slowly spirals together. This is the signal LIGO first heard from
          two merging black holes in 2015.
        </p>
        <p>
          The <strong>Wave Lab</strong> makes it concrete. It integrates the relative two-body
          orbit with the leading <strong>2.5PN radiation-reaction</strong> force
          <code> a_RR = (8/5)(G²Mμ/c⁵r³)[(3v²+17/3·GM/r)ṙ n̂ − (v²+3GM/r)v]</code> — an effect of
          order <code>(v/c)⁵</code> — and watches the orbit inspiral. From the trajectory it
          evaluates Einstein's <strong>quadrupole formula</strong> for the transverse-traceless wave
          strain <code>hⱼₖ = (2G/c⁴D)·Ïⱼₖ</code>, projected onto the observer's polarisation basis at
          your chosen inclination, and draws the emitted <strong>chirp</strong>: a waveform whose
          amplitude and frequency both sweep upward as the orbit tightens, with the GW frequency
          locked at exactly twice the orbital frequency. Crank the eccentricity up and watch the
          orbit <strong>circularise</strong> — gravitational radiation sheds eccentricity even faster
          than it sheds energy. You can even <strong>hear it</strong>: the lab sonifies the frequency
          track into the audible band, the rising "whoop" of a binary coalescence.
        </p>
        <p>
          And it is checked. The integrated merger time is compared head-to-head with{' '}
          <strong>Peters' (1964)</strong> closed form <code>t_c = 5c⁵a⁴/(256 G³m₁m₂M)</code> (and its
          eccentric generalisation) — the radiation-reaction force and the merger-time formula are
          derived independently, so their agreement to a fraction of a percent validates both. The
          lab stops at the edge of the post-Newtonian regime: the final plunge, merger and{' '}
          <strong>ringdown</strong> belong to the strong field, where only numerical relativity can
          honestly take over.
        </p>

        <h2>Strong-field gravity: the black-hole shadow</h2>
        <p>
          The relativity above is all <em>weak field</em> — post-Newtonian expansions valid only
          where <code>v/c ≪ 1</code>, far outside any horizon. The <strong>Black-Hole Lab</strong>{' '}
          goes to the strong field, but honestly: it integrates the <em>exact</em> null geodesics of
          the Schwarzschild metric, which for light in a plane collapse to one strikingly simple
          equation in the inverse radius <code>u = 1/r</code>:
        </p>
        <p style={{ textAlign: 'center' }}>
          <code>d²u/dφ² = −u + 3M u²</code>
        </p>
        <p>
          The lone nonlinear term <code>3M u²</code> <em>is</em> general relativity — drop it and you
          recover Newton's straight line. Keep it and light bends, orbits precess, and a{' '}
          <strong>photon sphere</strong> appears at <code>r = 3M</code> where light can circle the
          hole. From this one equation fall the deflection of starlight (Einstein's{' '}
          <code>4M/b</code> far out, diverging <em>logarithmically</em> as the impact parameter
          approaches the critical <code>b_c = 3√3 M</code>), the precession of a near-circular orbit
          (<code>2π(1/√(1−6M/r) − 1)</code> per turn, diverging at the innermost stable orbit{' '}
          <code>r = 6M</code>), and the size of a black hole's <strong>shadow</strong>.
        </p>
        <p>
          The lab is a <strong>reverse ray tracer</strong>. For every pixel it shoots a photon
          backward into the curved spacetime and integrates that geodesic: photons that cross the
          horizon paint the black shadow; those that escape sample a procedural sky, so the
          background is gravitationally <strong>lensed</strong> — the grid bends and an Einstein ring
          forms. A thin <strong>accretion disc</strong> of gas on circular geodesics is gathered
          along the way, with the <em>exact</em> relativistic frequency shift{' '}
          <code>g = √(1−3M/r)/(1−Ωℓ)</code> beaming the side that rotates toward you far brighter
          (<code>I ∝ g⁴</code>) — and the disc's far side lensed up over the top of the hole. The
          bright ring hugging the shadow is the <strong>photon ring</strong>, light that looped the
          photon sphere before escaping, fixed at <code>b_c = 3√3 M</code> for any observer.
        </p>
        <p>
          A <strong>rotating</strong> (Kerr) black hole drags space around itself, so its shadow is
          not a circle but a <strong>D-shape</strong>, flattened and displaced on the co-rotating
          side. The Black-Hole Lab draws that boundary in closed form from the unstable spherical
          photon orbits (Bardeen 1973), reducing to the <code>3√3 M</code> circle as the spin
          vanishes.
        </p>

        <h2>Kerr: the spinning black hole, ray-traced</h2>
        <p>
          The <strong>Kerr Lab</strong> stops drawing the rotating shadow and starts{' '}
          <em>integrating</em> it. Spherical symmetry is gone, so the planar <code>u(φ)</code> trick
          fails: frame dragging twists each photon's plane around the spin axis. Instead the lab
          integrates the genuine 3-D null geodesic by stepping <strong>Hamilton's equations</strong>{' '}
          for <code>H = ½ gᵘᵛ pᵤpᵥ = 0</code> in Boyer–Lindquist coordinates. Because the Kerr metric
          ignores <code>t</code> and <code>φ</code>, the energy <code>E = −p_t</code> and the axial
          angular momentum <code>L_z = p_φ</code> are conserved automatically — and Kerr hides a{' '}
          <em>fourth</em> integral, <strong>Carter's constant</strong>{' '}
          <code>Q = p_θ² + cos²θ(L_z²/sin²θ − a²E²)</code>, which makes the geometry separable. None
          of these are built into the stepper, so their constancy along an independently-integrated
          ray is the proof the geodesic is right (the self-test holds <code>H</code> and <code>Q</code>{' '}
          to a part in <code>10⁷</code>).
        </p>
        <p>
          Per pixel we invert Bardeen's image-plane relations <code>α = −ξ/sin ι</code>,{' '}
          <code>β = ±√(η + a²cos²ι − ξ²cot²ι)</code> to launch a photon and trace it inward. One that
          crosses the horizon <code>r₊ = M + √(M²−a²)</code> paints the black shadow; one that
          escapes reads its outgoing direction off a procedural sky, gravitationally{' '}
          <strong>lensed</strong> into an off-centre Einstein ring. Disc gas rides prograde circular
          geodesics at <code>Ω = √M/(r^{'{'}3/2{'}'}+a√M)</code>, beamed by the full relativistic
          shift <code>g = √(−(g_tt+2Ωg_tφ+Ω²g_φφ))/(1−Ωξ)</code> (which reduces exactly to the
          Schwarzschild <code>√(1−3M/r)/(1−Ωℓ)</code> as the spin vanishes). The result is the famous
          asymmetric <strong>D-shaped shadow</strong>: the prograde edge — the side dragged toward you
          — is pushed inward, the retrograde edge outward, so the whole shadow is displaced. The
          dashed curve laid over the image is the closed-form Bardeen/Teo rim; the integrated boundary
          (found by bisecting the ray tracer) lands right on it.
        </p>

        <h2>Symplectic planetary dynamics: integrating exactly the right thing</h2>
        <p>
          Every integrator above is <em>agnostic</em> — it knows nothing about the problem it
          advances. But a <strong>planetary system</strong> has structure worth exploiting: the
          motion is <em>nearly Keplerian</em>, a dominant star with the other planets a faint
          perturbation. A brute-force stepper integrates the <em>whole</em> force — including the
          huge, fast-curving stellar pull — approximately, so its error tracks the full dynamics.{' '}
          <strong>Wisdom &amp; Holman (1991)</strong> instead <em>split</em> the Hamiltonian into a
          Keplerian part and a small interaction, integrate the Kepler part{' '}
          <strong>exactly</strong>, and only approximate the perturbation.
        </p>
        <p>
          The exact part is a <strong>universal-variable Kepler propagator</strong>: it advances a
          body along its osculating ellipse analytically for any eccentricity (and either time
          direction), via the Stumpff functions and a bisection-safeguarded Newton solve for the
          universal anomaly — its internal Lagrange coefficients satisfy{' '}
          <code>f·ġ − ḟ·g = 1</code> to a part in <code>10¹³</code>, the signature of an exact
          symplectic map. The <strong>Symplectic Lab</strong> then races Wisdom–Holman (2nd order,
          and a 4th-order Yoshida triple-jump of it) against velocity Verlet and Runge–Kutta 4 on the{' '}
          <em>identical</em> unsoftened Hamiltonian at one deliberately coarse step. The energy-error
          plot tells the whole story: WH stays flat and <em>bounded</em> — roughly{' '}
          <strong>10,000× under Verlet</strong> — while the 4th-order-accurate-but-non-symplectic RK4
          drifts secularly away. This is precisely why long-term Solar-System integrations (SWIFT,
          MERCURY, REBOUND) are all built on the Wisdom–Holman map.
        </p>

        <h2>Frequency-map analysis: the resonance web</h2>
        <p>
          The <strong>Chaos Lab</strong> and <strong>Spectral Lab</strong> each judge <em>one</em>{' '}
          orbit. The <strong>Resonance Atlas</strong> sweeps that judgement across a whole{' '}
          <em>family</em> of orbits — and the structure it paints is the most celebrated portrait in
          modern celestial mechanics: <strong>Laskar's frequency-map analysis</strong> (1990), the
          technique behind the diffusion map of the Solar System and the asteroid belt's resonance
          web — the <em>Arnold web</em>.
        </p>
        <p>
          The principle is exact. A regular (quasi-periodic) orbit lives on an invariant torus, so
          its fundamental frequency is <em>frozen</em>; a chaotic orbit wanders across resonances, so
          its frequency <em>drifts</em>. Measure the frequency on the first half of an orbit versus
          the second (with <strong>NAFF</strong>, super-resolved between FFT bins) and the relative
          drift <code>log₁₀|Δn/n|</code> is an exquisitely sensitive chaos indicator — near sampling
          precision (<code>≲ −6</code>) on a torus, large (<code>≳ −2</code>) in the chaotic zones.
        </p>
        <p>
          The Atlas computes this in the canonical testbed — the <strong>planar circular restricted
          three-body problem</strong> in the rotating frame of a Sun–Jupiter pair — independent of
          the live engine, so it is exactly reproducible. Each pixel launches a test particle from
          its own osculating ellipse <code>(a, e)</code>, integrates it (RK4, conserving the Jacobi
          constant to a part in <code>10⁹</code>), and records the inertial signal{' '}
          <code>Z(t) = (x+iy)·e^{'{'}i t{'}'}</code> whose dominant NAFF frequency is the orbit's mean
          motion <code>n</code> (the Keplerian limit <code>n = a^{'{'}−3/2{'}'}</code> is recovered
          to a part in <code>10⁶</code>). Coloured by <strong>frequency</strong> the map shows the
          resonance plateaus; coloured by <strong>diffusion</strong> it shows the bright chaotic
          threads where mean-motion resonances <code>n/n_J = p/q</code> live and overlap (Chirikov's
          route to chaos, the mechanism behind the Kirkwood gaps). Click any cell to drill into that
          orbit's <strong>time-frequency spectrogram</strong> — a regular orbit draws dead-straight
          spectral lines; a chaotic one draws a wandering, smeared ridge: frequency diffusion made
          directly visible.
        </p>

        <h2>The Three-Body Atlas: the Agekyan–Anosova map</h2>
        <p>
          The Resonance Atlas maps the <em>restricted</em> problem — a massless test particle in a
          fixed binary's field. The <strong>Three-Body Atlas</strong> maps the <em>full</em>,
          unrestricted three-body problem, the original home of deterministic chaos. Three{' '}
          <strong>equal masses are released from rest</strong> from a triangle, and gravity does the
          rest: a chaotic sequence of close passages — the <em>interplay</em> — that almost always
          ends the same way, with one body <strong>ejected</strong> and the other two left as a bound
          binary. Which body escapes, and how long the dance lasts, depends so sensitively on the
          starting triangle that a map of the outcome is a <strong>fractal</strong>.
        </p>
        <p>
          Each pixel is one release configuration: <code>m₁, m₂</code> pinned at{' '}
          <code>(∓½, 0)</code> and the third body placed across the canonical{' '}
          <strong>region D</strong> (Agekyan &amp; Anosova 1968) — the patch of the plane that
          represents every distinct free-fall triangle up to symmetry and scale. Behind every pixel
          the full problem is integrated by a <strong>4th-order Hermite predictor–corrector</strong>{' '}
          (Makino–Aarseth) that uses the analytic <em>jerk</em> (<code>da/dt</code>) and the standard
          adaptive timestep — the gold-standard small-N scheme, conserving energy through a violent
          scattering to a part in <code>10³–10⁴</code>. Colour the map by <strong>lifetime</strong>{' '}
          (the fractal escape-time portrait), by <strong>escaper</strong> (three interleaved basins),
          by the surviving <strong>binary's size</strong>, or by the <strong>interplay count</strong>.
          The bright islands are <em>long-lived</em> resonant triples — the algebraic tail of the
          three-body lifetime distribution.
        </p>
        <p>
          Because the system starts at rest its total <strong>angular momentum is exactly zero</strong>{' '}
          and its centre of mass is fixed — exact invariants the self-test verifies, alongside two
          beautiful special triangles: an <strong>isosceles</strong> release stays mirror-symmetric to
          machine precision forever, and a perfect <strong>equilateral</strong> release collapses{' '}
          <em>homothetically</em>, staying equilateral all the way down (the Lagrange central
          configuration). Click any pixel to replay <em>the dance behind it</em> — the actual
          trajectory and the pairwise-distance history — or send it straight into the live studio with{' '}
          <strong>Launch in Studio</strong> and watch it scatter full-screen.
        </p>

        <h2>Run the numbers yourself</h2>
        <p>
          None of the above is taken on faith. The button below runs a battery of numerical checks in
          your browser — that the orbit solver recovers known elements, that Yoshida 4 beats Verlet and
          Yoshida 6 beats Yoshida 4 at energy conservation, that Verlet is time-reversible, that the
          tidal tensor is the exact gradient of the force, that the Lagrange points are genuine
          equilibria (<code>∇Ω ≈ 0</code>), that momentum is conserved, that the virial theorem holds,
          that MEGNO recognises a regular orbit (<code>⟨Y⟩ → 2</code>) yet flags the Pythagorean
          three-body problem as chaotic, that the engine's relativistic precession matches the
          closed-form GR formula reproducing Mercury's 43″/century — and that a radiation-reaction
          inspiral reproduces Peters' gravitational-wave merger time, radiates at twice the orbital
          frequency, circularises an eccentric orbit on schedule, and carries the quadrupole
          formula's exact <code>(1+cos²ι)</code> polarisation pattern. The strong-field battery adds
          the rest: that the shadow's critical impact parameter is <code>3√3 M</code> (the closed
          form cross-checked against a bisection of the ray tracer itself), that the photon sphere
          sits at <code>3M</code> and the ISCO at <code>6M</code>, that light deflection tends to
          Einstein's <code>4M/b</code> and diverges logarithmically (matching Bozza 2002) at{' '}
          <code>b_c</code>, that the exact orbit equation reproduces the <code>2π(1/√(1−6M/r)−1)</code>{' '}
          precession, that the disc redshift is exactly <code>√½</code> at the ISCO, and that the
          Kerr shadow collapses to the <code>3√3 M</code> circle as its spin vanishes. The Kerr
          battery proves the rotating ray tracer outright: that the contravariant metric is the exact
          inverse of the covariant one, that the null condition <code>H ≈ 0</code> and{' '}
          <strong>Carter's constant Q</strong> hold along an integrated geodesic, that the ray-traced
          shadow reproduces the analytic Bardeen rim and is displaced by frame dragging into a D, that
          the Bardeen ISCO is <code>6M</code> at <code>a=0</code> and <code>M</code>/<code>9M</code>{' '}
          at <code>a=M</code>, and that the Kerr disc redshift reduces to the Schwarzschild formula as
          the spin vanishes. And the symplectic battery: that the universal-variable Kepler propagator
          matches the analytic{' '}
          <code>E − e·sinE</code> solution to machine precision, that its Lagrange coefficients
          satisfy <code>f·ġ − ḟ·g = 1</code>, that Wisdom–Holman is exact for two bodies and beats
          Verlet on energy by <code>~10⁴×</code> (with RK4's secular drift as a control), that its
          4th-order composition beats the 2nd, and that the map is time-reversible and conserves
          linear and angular momentum.
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
          <li>Open the <em>Wave Lab</em>, press <em>Generate inspiral</em>, and watch two bodies spiral together as they radiate — then press <em>Hear the chirp</em> to listen to the merger. Push the eccentricity up and watch the orbit circularise; check the measured merger time against Peters' formula.</li>
          <li>Open the <em>Black Hole Lab</em>, press <em>Render black hole</em>, and watch the shadow, the lensed sky grid and the Doppler-beamed disc trace out row by row — then set the inclination near 90° to see the disc's far side lensed up over the top, the <em>Interstellar</em> image.</li>
          <li>In the <em>Black Hole Lab</em>, drag the Kerr <em>spin</em> up toward 1 and watch the shadow morph from a circle into the lopsided D-shape, flattening on the side space is dragged toward you.</li>
          <li>Open the <em>Kerr Lab</em>, push the <em>spin</em> toward 1 at 90° inclination, and press <em>Render</em> — watch the integrated shadow slide off-centre and flatten into a D, with the dashed analytic rim sitting right on the boundary. Then press <em>Measure shadow edges</em> to read the prograde/retrograde displacement straight off the ray tracer.</li>
          <li>Open the <em>Symplectic Lab</em>, pick <em>Four inner planets</em>, push Δt up and press <em>Run the race</em> — on the log-scale energy-error plot watch Wisdom–Holman stay flat while Verlet ripples far above it and RK4 climbs off the top. Toggle <em>WH 4th order</em> to drop the green curve another decade.</li>
          <li>Open the <em>Resonance Atlas</em>, press <em>Compute Atlas</em> and watch the resonance web fill in row by row. Switch <em>Strong perturber</em> and flip <em>Colour by</em> to <em>Frequency</em> to see the resonance plateaus, then back to <em>Chaos</em> for the Arnold web — and click a bright thread to watch its spectrogram ridge wander.</li>
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
