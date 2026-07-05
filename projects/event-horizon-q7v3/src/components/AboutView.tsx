export default function AboutView() {
  return (
    <div className="about">
      <div className="about__inner">
        <h1>How Event Horizon works</h1>
        <p className="lead">
          Nothing here is a texture of a black hole. Every frame of the main view is a physics
          simulation: for each pixel we launch a ray of light from the camera and integrate its
          path through the curved spacetime around a non-rotating (Schwarzschild) black hole,
          then colour the pixel by whatever that ray eventually hits.
        </p>

        <h2>Tracing light backwards</h2>
        <p>
          Light travels along <em>null geodesics</em> — the straightest possible paths through
          curved geometry. We trace them in reverse, from the eye outward, which is exactly
          equivalent by time-symmetry and far cheaper than following every photon a disk emits.
        </p>
        <p>
          Working in units where the Schwarzschild radius <code>rs = 1</code> (so the mass{' '}
          <code>M = ½</code>), a photon's orbit obeys the shape equation
        </p>
        <pre className="eq">d²u/dφ² + u = 3M·u²   (u = 1/r)</pre>
        <p>
          Because the deflecting force is purely radial, a ray's angular momentum{' '}
          <code>L = r⃗ × v⃗</code> is conserved. That lets us write the whole thing as a simple
          Cartesian acceleration and march it with a 4th-order Runge–Kutta integrator:
        </p>
        <pre className="eq">a⃗ = −1.5 · |L|² · r⃗ / r⁵</pre>
        <p>
          A ray that reaches <code>r &lt; 1</code> has crossed the horizon — it is captured and the
          pixel is black. That black disc is bigger than the horizon itself: the boundary is the{' '}
          <strong>photon sphere</strong> at <code>1.5 rs</code>, where light can orbit. Rays that
          escape sample a procedural, gravitationally-lensed starfield along their final heading,
          so the background genuinely warps into an <strong>Einstein ring</strong> around the hole.
        </p>

        <h2>The accretion disk</h2>
        <p>
          A thin disk of gas orbits in the equatorial plane. Where a ray crosses that plane between
          the inner and outer radius, we emit light coloured by an approximate{' '}
          <strong>black-body</strong> spectrum — hotter and bluer toward the innermost stable orbit
          (<code>ISCO = 3 rs</code>). Two relativistic effects give the disk its signature look:
        </p>
        <ul>
          <li>
            <strong>Doppler beaming.</strong> The gas orbits at a large fraction of light speed. The
            side sweeping toward you is brighter and bluer; the receding side is dimmer and redder.
            The brightness boost scales roughly as the Doppler factor cubed.
          </li>
          <li>
            <strong>Gravitational redshift.</strong> Light climbing out of the gravity well loses
            energy, so material deep near the hole looks dimmer and redder — a factor of{' '}
            <code>√(1 − rs/r)</code>.
          </li>
        </ul>
        <p>
          Toggle either effect in the control panel to see how much of the disk's asymmetry each one
          is responsible for.
        </p>

        <h2>Reading the controls</h2>
        <ul>
          <li>
            <strong>Inclination</strong> tilts your view. Near edge-on, lensing lifts the far side of
            the disk into an arc over the top of the shadow — the famous double image.
          </li>
          <li>
            <strong>Integration steps</strong> and <strong>step size</strong> trade accuracy for
            speed. Too few steps and sharply-bent rays near the photon sphere get ragged.
          </li>
          <li>
            <strong>Render scale</strong> lowers the internal resolution — the quickest way to buy
            framerate on a modest GPU.
          </li>
        </ul>

        <h2>Honest caveats</h2>
        <p className="muted">
          This is a real-time approximation, not a research code. The hole is non-spinning (no Kerr
          frame-dragging), the disk is an infinitely thin emissive plane rather than a volumetric
          flow, we integrate coordinate paths without a full parallel-transport of the observed
          spectrum, and the starfield is procedural. The qualitative geometry — the shadow, the
          photon ring, the lensed disk and beaming — is faithful; exact photometry is not the goal.
        </p>
        <p className="muted small">
          Open the <strong>Geodesics</strong> tab to see the individual light rays that all of this
          is built from.
        </p>
      </div>
    </div>
  )
}
