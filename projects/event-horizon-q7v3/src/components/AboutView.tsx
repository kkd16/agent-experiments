export default function AboutView() {
  return (
    <div className="about">
      <div className="about__inner">
        <h1>How Event Horizon works</h1>
        <p className="lead">
          Nothing here is a texture of a black hole. Every frame of the main view is a physics
          simulation: for each pixel we launch a ray of light from the camera and integrate its
          path through curved spacetime — around either a non-rotating (Schwarzschild) or a{' '}
          <strong>spinning (Kerr)</strong> black hole — then colour the pixel by whatever that ray
          eventually hits.
        </p>

        <h2>Tracing light backwards</h2>
        <p>
          Light travels along <em>null geodesics</em> — the straightest possible paths through
          curved geometry. We trace them in reverse, from the eye outward, which is exactly
          equivalent by time-symmetry and far cheaper than following every photon a disk emits.
        </p>
        <p>
          Working in units where the Schwarzschild radius <code>rs = 1</code> (so the mass{' '}
          <code>M = ½</code>), a non-spinning hole bends light by a purely radial force. A photon's
          angular momentum <code>L = r⃗ × v⃗</code> is then conserved, which collapses the whole
          problem to one compact Cartesian acceleration we march with 4th-order Runge–Kutta:
        </p>
        <pre className="eq">a⃗ = −1.5 · |L|² · r⃗ / r⁵</pre>
        <p>
          A ray that reaches <code>r &lt; 1</code> has crossed the horizon — it is captured and the
          pixel is black. That black disc is bigger than the horizon itself: the boundary is the{' '}
          <strong>photon sphere</strong> at <code>1.5 rs</code>, where light can orbit. Rays that
          escape sample a procedural, gravitationally-lensed starfield along their final heading, so
          the background genuinely warps into an <strong>Einstein ring</strong> around the hole.
        </p>

        <h2>Spin: the Kerr black hole</h2>
        <p>
          Real black holes rotate, often near the theoretical maximum. A spinning hole doesn't just
          curve spacetime — it <strong>drags it around</strong> in the direction of rotation (the
          Lense–Thirring effect, or <em>frame dragging</em>). Turn up the <strong>Spin a/M</strong>
          {' '}control and the whole image shears: the shadow stops being a circle and develops the
          famous flat edge on the side rotating toward you, and the lensed disk winds up asymmetric.
        </p>
        <p>
          There is no clever radial shortcut here, so we integrate the full Kerr geodesic honestly.
          We work in <strong>Boyer–Lindquist coordinates</strong> <code>(r, θ, φ)</code> and use a{' '}
          <strong>Hamiltonian</strong> formulation: each photon carries its position and the
          covariant momenta <code>(p_r, p_θ)</code>, while its energy <code>E = −p_t</code> and
          axial angular momentum <code>L = p_φ</code> stay constant. The equations of motion are
          driven by the inverse Kerr metric and its gradient:
        </p>
        <pre className="eq">dxᵘ/dλ = gᵘᵛ p_ᵥ      dp_ᵤ/dλ = −½ (∂_ᵤ gᵃᵇ) p_ₐ p_ᵦ</pre>
        <p>
          Because the Hamiltonian is smooth, there are no fragile turning-point sign flips — the ray
          sails through its closest approach and back out cleanly. The horizon now sits at{' '}
          <code>r₊ = M + √(M² − a²)</code>, shrinking as the spin grows.
        </p>

        <h2>The ergosphere</h2>
        <p>
          Just outside the horizon lies the <strong>ergosphere</strong>, bounded by the{' '}
          <em>static limit</em> <code>r = M + √(M² − a²cos²θ)</code>. Inside it, frame dragging is so
          overwhelming that <em>nothing</em> — not even light aimed against the spin — can remain at
          rest relative to the distant stars; everything is forced to co-rotate. Switch it on with
          the <strong>Ergosphere</strong> toggle to see the shell, and open the{' '}
          <strong>Geodesics</strong> tab to watch a fan of photons go lopsided as the spin rises.
        </p>

        <h2>The accretion disk &amp; the g-factor</h2>
        <p>
          A thin disk of gas orbits in the equatorial plane. Where a ray crosses it we emit light
          with an approximate <strong>black-body</strong> spectrum — hotter and bluer toward the
          innermost stable orbit (the <strong>ISCO</strong>, which for a prograde disk marches from{' '}
          <code>6M</code> down toward <code>M</code> as the spin approaches maximal; toggle{' '}
          <strong>Inner edge → ISCO</strong> to track it). Two relativistic effects shape the disk:
        </p>
        <ul>
          <li>
            <strong>Doppler beaming.</strong> The gas orbits at a large fraction of light speed. The
            side sweeping toward you is brighter and bluer; the receding side dimmer and redder.
          </li>
          <li>
            <strong>Gravitational redshift.</strong> Light climbing out of the well loses energy, so
            material deep near the hole looks dimmer and redder.
          </li>
        </ul>
        <p>
          Around the Kerr hole we compute these <em>exactly</em>, together, with a single{' '}
          <strong>frequency-shift factor</strong> built from the photon's own conserved{' '}
          <code>b = L/E</code> and the disk's orbital angular velocity <code>Ω</code>:
        </p>
        <pre className="eq">g = √(−(g_tt + 2Ω·g_tφ + Ω²·g_φφ)) / (1 − Ω·b)</pre>
        <p>
          This one number bundles gravitational redshift, transverse <em>and</em> longitudinal
          Doppler, <em>and</em> the frame-dragging contribution. Colour shifts by <code>g</code> and
          brightness by <code>g³</code>. The <strong>spectrograph</strong> overlay plots the same
          shift across the whole disk as an emission-line profile — the skewed, double-horned shape
          astronomers actually fit to X-ray spectra to <em>measure</em> a real black hole's spin.
        </p>

        <h2>A volume, not a sheet</h2>
        <p>
          Switch on <strong>Volumetric</strong> and the disk stops being an infinitely thin plane.
          Instead it becomes a <em>flared slab</em> of glowing gas: its half-thickness grows with
          radius as <code>H(ρ) = h₀·(ρ/ρ_in)^1.15</code> and the density fades away from the
          mid-plane as a Gaussian. Now, instead of registering a single crossing, each light ray is{' '}
          <strong>ray-marched</strong> through the gas it passes, accumulating emission that is
          attenuated by everything already in front of it:
        </p>
        <pre className="eq">color += T · S · (1 − e^−κ·ds)      T ·= e^−κ·ds</pre>
        <p>
          That is the classic <em>emission–absorption</em> volume-rendering integral: <code>S</code>{' '}
          is the gas's own relativistically-shifted glow, <code>κ</code> its opacity, and{' '}
          <code>T</code> the fraction of light still getting through. Because each step shadows the
          ones behind it, the disk now <strong>occludes itself</strong> — the far side glows{' '}
          <em>through</em> the near side, the inner wall stands up in real three-dimensional relief,
          and the lensed underside no longer looks like a decal. It is slower (every in-slab step
          does the full photometry), so the crisp thin-plane path stays a toggle away.
        </p>

        <h2>Falling in: the rain frame</h2>
        <p>
          Everything above is what a camera <em>hovering</em> at a fixed radius sees. But what would{' '}
          <em>you</em> see, falling in? Turn on <strong>Free fall</strong> (or hit the{' '}
          <strong>Plunge</strong> button / <code>F</code>) and the camera becomes a{' '}
          <strong>Gullstrand–Painlevé raindrop</strong> — an observer that fell from rest at
          infinity, moving inward at speed <code>β = √(r_s/r)</code> relative to the static frame.
          Two things happen at once, and both are real relativity, not a filter:
        </p>
        <ul>
          <li>
            <strong>Aberration.</strong> Your motion sweeps the entire sky forward. We transform
            every camera ray into the static frame with the relativistic aberration law before
            integrating its geodesic, so the whole visible universe — stars, disk, Einstein ring —
            compresses into a shrinking window ahead of you as you speed up.
          </li>
          <li>
            <strong>Doppler &amp; beaming.</strong> Light you rush toward is blue-shifted and
            brightened, light behind you red-shifted and dimmed, by the factor{' '}
            <code>D = γ(1 + β·μ)</code>. The forward window doesn't just shrink — it blazes.
          </li>
        </ul>
        <p>
          Because <code>β → 1</code> as <code>r → r_s</code>, the dive can carry the camera down past
          the <strong>photon sphere</strong>, where the shadow swells to swallow most of your view.
          The HUD tracks your radius, <code>β</code>, and Lorentz factor <code>γ</code> the whole way
          down.
        </p>

        <h2>Making it look photographic</h2>
        <ul>
          <li>
            <strong>HDR bloom.</strong> The scene is rendered to a floating-point buffer, the bright
            disk material is extracted and blurred through a multi-pass Gaussian pyramid, and added
            back before an ACES filmic tonemap — the glow you see is real light bleeding, not a
            filter. Toggle it with <code>B</code>.
          </li>
          <li>
            <strong>Adaptive quality.</strong> The renderer watches its own framerate and quietly
            lowers or raises the internal resolution to stay smooth while you orbit.
          </li>
          <li>
            <strong>Share</strong> copies a link that encodes the entire scene, so a view you tuned
            is a URL you can send.
          </li>
        </ul>

        <h2>Honest caveats</h2>
        <p className="muted">
          This is a real-time approximation, not a research code. The volumetric disk is a
          phenomenological emission–absorption slab, not a solved radiative-transfer / MHD flow (and
          the thin-plane mode is, deliberately, a zero-thickness sheet); we integrate coordinate
          paths without a full parallel-transport of the observed spectrum; the free-fall Doppler
          colour shift is a perceptual RGB tint rather than a per-wavelength remap; and the
          starfield is procedural. The Kerr
          integration is done in Boyer–Lindquist coordinates, which are elegant but have a coordinate
          seam along the rotation axis — you may spot a faint speckle there on near-edge-on,
          high-spin views (production codes switch to Kerr–Schild coordinates to remove it). The
          qualitative physics — the off-axis shadow, frame dragging, the ergosphere, the exactly
          computed disk shifts — is faithful; exact photometry is not the goal.
        </p>
        <p className="muted small">
          Open the <strong>Geodesics</strong> tab to see the individual light rays that all of this
          is built from — and drag the spin slider there to watch frame dragging directly.
        </p>
      </div>
    </div>
  )
}
