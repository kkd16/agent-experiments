export default function AboutView() {
  return (
    <div className="about">
      <div className="about__inner">
        <h1>How Event Horizon works</h1>
        <p className="lead">
          Nothing here is a texture of a black hole. Every frame of the main view is a physics
          simulation: for each pixel we launch a ray of light from the camera and integrate its
          path through curved spacetime — around any member of the black-hole family, from a
          non-rotating (Schwarzschild) hole to a <strong>spinning (Kerr)</strong> and even{' '}
          <strong>charged (Kerr–Newman)</strong> one — then colour the pixel by whatever that ray
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

        <h2>Charge: the Kerr–Newman family</h2>
        <p>
          Spin is one of only <em>three</em> things a black hole can carry. The{' '}
          <strong>no-hair theorem</strong> says any stationary black hole in general relativity is
          fixed completely by its mass <code>M</code>, its angular momentum <code>a</code>, and its
          electric <strong>charge <code>Q</code></strong> — nothing else survives the collapse. Turn
          up the <strong>Charge Q/M</strong> control and the renderer switches from Kerr to the fully
          general <strong>Kerr–Newman</strong> metric, the most general isolated black hole there is.
        </p>
        <p>
          Remarkably, charge enters the geometry through a single, tidy change: the “mass function”{' '}
          <code>2Mr</code> that appears throughout the metric becomes <code>2Mr − Q²</code>, and the
          horizon function picks up one term,
        </p>
        <pre className="eq">Δ(r) = r² − 2Mr + a² + Q²</pre>
        <p>
          Everything else follows. The outer horizon contracts to{' '}
          <code>r₊ = M + √(M² − a² − Q²)</code>, the ergosphere and the photon rings pull inward, and
          the shadow <strong>shrinks</strong> — charge curves spacetime and grips light much as extra
          mass would. Because the photons themselves are neutral, their null geodesics are still pure
          metric motion, so the same Hamiltonian integrator traces them; only <code>Δ</code> and the
          mass function change. With no spin you get a <strong>Reissner–Nordström</strong> hole: a
          perfectly circular shadow, but smaller than Schwarzschild’s — its radius slides from{' '}
          <code>3√3·M ≈ 2.598 rs</code> down toward <code>4M = 2 rs</code> as the charge approaches
          extremal.
        </p>
        <p>
          Spin and charge draw on one shared budget. A real (non-naked) horizon demands{' '}
          <code>a*² + Q*² ≤ 1</code>, so pushing either toward the extremal edge caps the other — the
          control enforces it for you. (Astrophysical holes are essentially neutral, since any net
          charge is quickly screened by surrounding plasma; Kerr–Newman is here because it is the{' '}
          <em>exact, general</em> solution — and because the Observatory can prove the app gets it
          right for every member of the family, not just the uncharged ones.)
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
          Doppler, <em>and</em> the frame-dragging contribution — and it generalises to a charged
          disk for free, since <code>g_tt</code>, <code>g_tφ</code>, <code>g_φφ</code> and the
          Kepler frequency <code>Ω</code> all inherit the same <code>2Mr → 2Mr − Q²</code> shift.
          Colour shifts by <code>g</code> and
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

        <h2>The shadow — computed, and proven</h2>
        <p>
          The dark disc at the centre of the image is the black hole’s <strong>shadow</strong>: the
          set of directions on your sky along which a backwards-traced photon spirals onto an
          unstable orbit and is lost. Its edge — the <strong>critical curve</strong> — has an exact
          closed form. Every point of it corresponds to a <em>spherical photon orbit</em> at some
          Boyer–Lindquist radius <code>r</code>, which fixes two conserved ratios, the specific
          angular momentum <code>ξ = L/E</code> and Carter’s constant <code>η = Q/E²</code>, and
          Bardeen’s projection turns those into sky coordinates:
        </p>
        <pre className="eq">α = −ξ / sinθ_o      β² = η + a²cos²θ_o − ξ² cot²θ_o</pre>
        <p>
          At zero spin this is a perfect circle of radius <code>b_crit = 3√3·M ≈ 2.598 rs</code>. Give
          the hole spin and it slides sideways and flattens into the famous Kerr <strong>“D”</strong>:
          the prograde light ring is dragged in tight while the retrograde one swings wide, so the
          shadow is displaced and asymmetric — exactly the deformation the Event Horizon Telescope
          hunts for. The new <strong>Observatory</strong> tab draws this curve live and, behind it,
          fills in the shadow a second, independent way — by asking of every direction whether the
          Kerr <em>radial potential</em> lets a photon turn around before the horizon. The two agree
          to the pixel.
        </p>
        <p>
          That agreement is the point. Everywhere else the app <em>asserts</em> its physics is right;
          the Observatory <strong>proves</strong> it, in your browser, on every load. A suite of
          self-tests re-derives the results from the inside: the critical impact parameter recovered
          by bisecting real integrated photons matches <code>3√3·M</code> to six figures; the CPU port
          of the Kerr integrator conserves Carter’s constant and the null condition to <code>~10⁻⁵</code>
          along genuine geodesics; the spherical-orbit formulae satisfy <code>R(r) = R′(r) = 0</code>;
          and the analytic shadow edges match the renderer’s own equatorial ray tracer. The{' '}
          <strong>Light bending</strong> plot on the same tab shows the companion story for a
          non-rotating hole — the deflection angle tracks Einstein’s <code>4M/b</code> far out and
          diverges through <code>π</code> and <code>2π</code> as the impact parameter approaches
          <code>b_crit</code>, each loop stacking another of the infinitely many images that pile up
          into the photon ring.
        </p>

        <h2>Click a photon: the probe</h2>
        <p>
          The render is 200 000 photons a frame — so make one of them talk. <strong>Click anywhere</strong>
          {' '}on the main view and Event Horizon rebuilds the <em>exact</em> ray that pixel casts, then
          integrates that single photon’s geodesic with the same Runge–Kutta scheme the shader uses and
          draws its path back over the image. The curve is frozen in space, so you can keep orbiting and
          watch it bend around the hole in three dimensions; a warm-to-cool gradient tracks how deep into
          the gravitational well it dived. Markers flag the camera, the point of closest approach, any
          disk crossing, and where it ends — an ✕ on the horizon if it was captured, a cool dot toward the
          sky if it escaped.
        </p>
        <p>
          The read-out panel is the real payoff: it reports the photon’s conserved{' '}
          <strong>energy <code>E</code></strong>, <strong>axial angular momentum <code>L</code></strong>,
          and <strong>Carter’s constant <code>Q</code></strong> — the three integrals of motion that make
          the Kerr geodesic solvable — along with its impact parameter <code>b = |L/E|</code> measured
          against <code>b_crit</code>, its closest approach, its lensing image order, and its total
          deflection. Aim near the shadow’s edge and you can watch <code>b</code> creep toward{' '}
          <code>b_crit</code> as the deflection climbs past a full turn. In the free-fall frame the ray is
          reconstructed <em>through the same aberration boost</em> the shader applies, so you are always
          tracing the photon you are actually seeing.
        </p>

        <h2>Light echoes: the photon ring</h2>
        <p>
          A photon that grazes close enough to the hole doesn’t just bend — it can loop the shadow one or
          more times before flying to your eye, so the sky (and the disk) is imaged not once but{' '}
          <em>infinitely many times</em>, each higher-order image squeezed into an ever-thinner ring
          hugging the shadow’s edge. That stack is the <strong>photon ring</strong> the Event Horizon
          Telescope is racing to resolve. Turn on <strong>Light-echo highlight</strong> (or press{' '}
          <code>P</code>) and the renderer counts how many times each traced photon crosses the equatorial
          plane — its <em>image order</em> — and tints the higher orders: cyan for the first echo, gold for
          the second, magenta beyond. The direct image is left untouched, so the successive echoes light up
          exactly where the deflection curve on the Observatory tab races through <code>π</code>,{' '}
          <code>2π</code>, and beyond.
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
          shift now moves each star’s black-body <em>temperature</em> along the Planckian locus (a
          genuine per-wavelength shift), though the already-integrated disk light still gets a
          perceptual tint since its source temperature is no longer separable; and the starfield is
          procedural. The Kerr rain frame adds the ZAMO azimuthal drift as a leading-order swirl rather
          than the full local infalling tetrad. The Kerr
          integration is done in Boyer–Lindquist coordinates, which are elegant but have a coordinate
          seam along the rotation axis — you may spot a faint speckle there on near-edge-on,
          high-spin views (production codes switch to Kerr–Schild coordinates to remove it). The
          charged (Kerr–Newman) geodesics and shadow are exact, but the disk’s ISCO-tracking inner
          edge uses the uncharged-Kerr innermost stable orbit — charge shifts it only slightly and
          the inner edge is a display choice, not part of the null-geodesic physics. The
          qualitative physics — the off-axis shadow, frame dragging, the ergosphere, the charge-shrunk
          horizon and shadow, the exactly computed disk shifts — is faithful; exact photometry is not
          the goal.
        </p>
        <p className="muted small">
          Open the <strong>Geodesics</strong> tab to see the individual light rays that all of this
          is built from — and drag the spin slider there to watch frame dragging directly. Then open{' '}
          the <strong>Observatory</strong> for the exact shadow outline, the light-bending curve, and
          the live verification suite that keeps every number here honest.
        </p>
      </div>
    </div>
  )
}
