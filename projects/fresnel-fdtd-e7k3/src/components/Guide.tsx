export function Guide() {
  return (
    <article className="guide">
      <h1>How Fresnel works</h1>
      <p className="guide__lede">
        Fresnel is a real, if miniature, computational-electromagnetics engine. It integrates
        Maxwell's curl equations directly in time on a staggered grid — the same{' '}
        <strong>Finite-Difference Time-Domain</strong> (FDTD) method used to design antennas,
        photonic chips, and metamaterials.
      </p>

      <h2>The equations</h2>
      <p>
        In a source-free, non-magnetic medium, Maxwell's curl equations in 2D “TMz” polarization
        reduce to three coupled fields — one electric component <code>Ez</code> and two magnetic
        components <code>Hx</code>, <code>Hy</code>:
      </p>
      <pre className="guide__eq">
{`∂Hx/∂t = −(1/μ) ∂Ez/∂y
∂Hy/∂t = +(1/μ) ∂Ez/∂x
∂Ez/∂t = (1/ε)(∂Hy/∂x − ∂Hx/∂y) − (σ/ε) Ez`}
      </pre>
      <p>
        The last term with conductivity <code>σ</code> is loss: it turns field energy into heat,
        which is how absorbers — and the invisible boundary layer around the domain — work.
      </p>

      <h2>The Yee grid</h2>
      <p>
        Kane Yee's 1966 insight was to stagger the fields in space and time. <code>Ez</code> lives
        at cell nodes; <code>Hx</code> and <code>Hy</code> live on the edges between them, offset
        by half a cell. Each field is updated from the spatial differences of the other, leapfrog
        style, so a centered second-order-accurate scheme falls out of first-order differences.
        The timestep is bounded by the <strong>Courant condition</strong> — light may not cross
        more than one cell per step — which here fixes <code>Sc = c·Δt/Δx = 0.7 ≤ 1/√2</code>.
      </p>

      <h2>Materials</h2>
      <p>
        Every cell carries a relative permittivity <code>εr</code>. The wave slows to{' '}
        <code>c/√εr</code> inside it, so the optical index is <code>n = √εr</code> — glass is{' '}
        <code>εr ≈ 2.25</code> (n ≈ 1.5). Painting a lens, prism, or waveguide simply stamps a
        region of higher <code>εr</code>; refraction, focusing, and total internal reflection then
        emerge from the update rule with no extra code. “Metal” cells are perfect electric
        conductors that pin <code>Ez = 0</code>, reflecting the wave entirely.
      </p>

      <h2>Dispersive metals — Drude &amp; Lorentz</h2>
      <p>
        A fixed <code>εr</code> can't describe a real metal, whose permittivity depends on
        frequency. Fresnel carries two frequency-dispersive material models, advanced by the{' '}
        <strong>Auxiliary Differential Equation</strong> (ADE) method — the same trick production
        photonics solvers use. Each dispersive cell gets an extra <em>polarization current</em>{' '}
        <code>J</code> integrated alongside the Yee update:
      </p>
      <pre className="guide__eq">
{`Drude:    ε(ω) = ε∞ − ωp²/(ω² + iγω)
Lorentz:  ε(ω) = ε∞ + Δε·ω0²/(ω0² − ω² + iγω)`}
      </pre>
      <p>
        Below its <strong>plasma wavelength</strong> a Drude metal has <code>ε &lt; 0</code>: the
        wave can't propagate, so it reflects like a mirror (try <em>Drude mirror</em>). Right at the
        plasma frequency <code>ε ≈ 0</code> — the wavelength inside stretches out and the phase goes
        flat (<em>ε-near-zero</em>). And where <code>ε ≈ −1</code> at a metal surface, light binds to
        the interface as a <strong>surface plasmon polariton</strong> (<em>Surface plasmon</em>,{' '}
        <em>Plasmonic particle</em>). The <em>Gold</em>, <em>Silver</em> and <em>Resonator</em>{' '}
        brushes paint these materials directly.
      </p>

      <h2>Open boundaries — sponge &amp; CPML</h2>
      <p>
        A finite grid has walls, but real space doesn't. Fresnel offers two absorbing boundaries.
        The cheap <strong>Sponge</strong> is a graded lossy layer — conductivity ramping up cubically
        toward the edge — that reflects a few percent. The <strong>CPML</strong> (a Roden–Gedney{' '}
        <em>convolutional perfectly-matched layer</em>) instead warps space with a complex
        coordinate stretch, absorbing outgoing waves at every angle and frequency with{' '}
        <strong>no impedance mismatch</strong>. The Measurement lab shows it running ~35&nbsp;dB
        (≈55×) quieter than the sponge — essentially reflection-free.
      </p>

      <h2>Sources</h2>
      <ul>
        <li>
          <strong>Sine</strong> — a continuous monochromatic emitter; wavelength is set in grid
          cells and drives the temporal period <code>T = λ/Sc</code>.
        </li>
        <li>
          <strong>Pulse</strong> — a Gaussian burst, useful for watching a single wavefront
          propagate and reflect.
        </li>
        <li>
          <strong>Ricker</strong> — the second derivative of a Gaussian, a broadband wavelet
          borrowed from seismic imaging.
        </li>
      </ul>
      <p>
        All are injected as <em>soft</em> sources (added to the field rather than overwriting it),
        so waves pass through the source point undisturbed.
      </p>

      <h2>Field, intensity &amp; flux</h2>
      <p>
        The <strong>Field</strong> view shows the instantaneous, signed <code>Ez</code> — the
        wave crests and troughs sweeping through space. The <strong>Intensity</strong> view is a
        long exposure: it accumulates the time-average <code>⟨Ez²⟩</code> at every cell, so the
        flickering wave settles into a still image of where energy actually concentrates.
        Interference fringes, a lens's focal spot, and cavity mode patterns all snap into sharp
        relief. The <strong>Flux</strong> view shows the time-averaged{' '}
        <strong>Poynting vector</strong> <code>⟨S⟩ = ⟨E × H⟩</code> — the actual direction and rate
        of energy flow — as a magnitude map with flow arrows, so you can watch energy stream into a
        focus or circulate around a scatterer. Hit <em>Reset</em> after changing the scene to start
        a fresh average.
      </p>

      <h2>The Measurement lab</h2>
      <p>
        Pretty waves are easy; a <em>correct</em> solver is not. The <strong>Measure</strong> tab
        runs the real engine headlessly and checks each result against a closed-form answer derived
        independently from electromagnetic theory: the Fresnel reflection at a glass interface, the
        Drude permittivity recovered from a reflectance spectrum, the CPML-vs-sponge reflection in
        decibels, the Yee grid's numerical phase velocity against its exact dispersion relation, and
        energy conservation in a lossless cavity. Green means the code agrees with Maxwell to the
        stated tolerance — measured, not asserted.
      </p>

      <h2>Things to try</h2>
      <ul>
        <li>Load <strong>Double slit</strong> and watch the interference fan build cell by cell.</li>
        <li>Load <strong>Convex lens</strong>, drop a probe past the lens, and find the focus on the scope.</li>
        <li>Paint a <strong>diamond</strong> block and shoot a beam at a shallow angle to see total internal reflection.</li>
        <li>Build your own waveguide bend from metal walls and route a pulse around a corner.</li>
        <li>Load <strong>Surface plasmon</strong> and switch to <strong>Flux</strong> to watch energy ride along the metal surface.</li>
        <li>Open <strong>Measure</strong> and hit <em>Run all</em> — watch the solver reproduce Fresnel, Drude and the FDTD dispersion relation.</li>
      </ul>

      <p className="guide__foot">
        The physics runs on the CPU in typed arrays; WebGL2 only colour-maps and upscales the
        field. Everything is deterministic — same scene, same evolution, every time.
      </p>
    </article>
  );
}
