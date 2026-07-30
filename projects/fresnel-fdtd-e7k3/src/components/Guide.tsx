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

      <h2>Open boundaries</h2>
      <p>
        A finite grid has walls, but real space doesn't. Fresnel wraps the domain in a graded
        lossy layer — conductivity ramping up cubically toward the edge, with electric and
        magnetic loss matched for low reflection — so outgoing waves are quietly absorbed and the
        domain reads as open space. It's the poor cousin of a Berenger PML, but cheap and stable.
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

      <h2>Things to try</h2>
      <ul>
        <li>Load <strong>Double slit</strong> and watch the interference fan build cell by cell.</li>
        <li>Load <strong>Convex lens</strong>, drop a probe past the lens, and find the focus on the scope.</li>
        <li>Paint a <strong>diamond</strong> block and shoot a beam at a shallow angle to see total internal reflection.</li>
        <li>Build your own waveguide bend from metal walls and route a pulse around a corner.</li>
      </ul>

      <p className="guide__foot">
        The physics runs on the CPU in typed arrays; WebGL2 only colour-maps and upscales the
        field. Everything is deterministic — same scene, same evolution, every time.
      </p>
    </article>
  );
}
