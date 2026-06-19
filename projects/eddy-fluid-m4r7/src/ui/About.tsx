// About.tsx — explains what the solver actually computes.

export function About() {
  return (
    <div className="about">
      <div className="about-inner">
        <h1>How Eddy works</h1>
        <p className="lede">
          Eddy is a real-time solver for the <strong>incompressible Navier–Stokes
          equations</strong> — the equations that govern smoke, water, and air. Nothing here is
          faked with particles or pre-baked textures: every frame solves the actual fluid PDE on a
          grid, from scratch, in TypeScript.
        </p>

        <h2>The equations</h2>
        <p>
          For a velocity field <code>u</code> with pressure <code>p</code> and viscosity{' '}
          <code>ν</code>, an incompressible fluid obeys
        </p>
        <pre>{`∂u/∂t = −(u·∇)u − ∇p + ν∇²u + f      (momentum)
∇·u = 0                              (incompressibility)`}</pre>
        <p>
          The first equation says velocity is carried along by the flow (advection), pushed by
          pressure, smeared by viscosity, and nudged by external forces <code>f</code>. The second
          says no fluid is created or destroyed anywhere — the field is divergence-free.
        </p>

        <h2>The method — operator splitting</h2>
        <p>
          Following Jos Stam's <em>Stable Fluids</em> (1999), each timestep applies the terms in
          sequence, and the result is <strong>unconditionally stable</strong> for any timestep:
        </p>
        <ol>
          <li>
            <strong>Forces</strong> — add vorticity confinement, gravity/buoyancy, and your mouse
            input directly to the velocity.
          </li>
          <li>
            <strong>Diffuse</strong> — solve the viscosity term implicitly with Gauss–Seidel
            iterations (a sparse linear solve), so high viscosity can't explode.
          </li>
          <li>
            <strong>Advect</strong> — move the field along itself by tracing each cell{' '}
            <em>backwards</em> through the velocity and sampling there with bilinear interpolation
            (the semi-Lagrangian trick that makes it stable). The dye can optionally use{' '}
            <strong>MacCormack advection</strong>: advect forward, advect that back, correct by half
            the round-trip error, then clamp to the source stencil — second-order accurate and far
            less smeared, without the overshoot that would ring or go negative.
          </li>
          <li>
            <strong>Project</strong> — restore <code>∇·u = 0</code>. We solve a Poisson equation
            <code> ∇²p = ∇·u</code> for pressure (more Gauss–Seidel sweeps), then subtract its
            gradient. This is the Hodge decomposition: it strips out the compressible part of the
            field and keeps the incompressible one.
          </li>
        </ol>

        <h2>Why vorticity confinement?</h2>
        <p>
          Semi-Lagrangian advection is stable but <em>dissipative</em> — it quietly smears away the
          small swirls that make smoke look alive. Vorticity confinement (Fedkiw et al., 2001)
          measures the curl <code>ω = ∇×u</code>, finds where it's concentrated, and adds a force
          that pushes velocity back into those vortex cores. Turning it up makes the flow wispier
          and more turbulent.
        </p>

        <h2>Obstacles &amp; the vortex street</h2>
        <p>
          Walls are cells flagged solid. The pressure solve and boundary routine treat them with a
          no-penetration / no-slip condition: flow can't enter them, and it reflects off their
          faces. Put a cylinder in a steady stream and, above a critical speed, the wake becomes
          unstable and sheds a periodic train of alternating vortices — the{' '}
          <strong>von Kármán vortex street</strong>. It's the same physics that makes flags flap
          and tall chimneys sway. Load that scene and watch it self-organise.
        </p>

        <h2>Temperature &amp; buoyancy</h2>
        <p>
          Eddy carries a real <strong>temperature field</strong> alongside the dye. It is advected
          by the flow and spread by thermal diffusion, and it pushes back on the fluid through the{' '}
          <strong>Boussinesq approximation</strong>: a parcel hotter than the ambient reference feels
          an upward body force proportional to <code>T − T₀</code>. That single coupling is enough to
          produce genuine convection. Heat a layer from below and cool it from above and, past a
          critical temperature gap, the motionless fluid spontaneously organises into a row of
          counter-rotating <strong>Rayleigh–Bénard rolls</strong> — the same instability you see in a
          pan of oil and on the surface of the Sun. Paint with the <em>Heat</em> brush, or load the
          convection / plume scenes and switch the render mode to <em>Temperature</em>.
        </p>

        <h2>Faster, fairer solves — red-black SOR</h2>
        <p>
          The pressure and viscosity steps are big sparse linear systems. The original solver swept
          them with Gauss–Seidel in reading order, which quietly biases the result left-to-right.
          Eddy now uses a <strong>red-black</strong> ordering: the five-point Laplacian only ever
          couples a cell to its opposite-coloured neighbours, so each colour can be updated
          independently of its own. That removes the directional bias (a mirror-symmetric setup now
          stays mirror-symmetric) and parallelises cleanly. On top of it sits{' '}
          <strong>successive over-relaxation</strong> (the <code>ω</code> slider): nudging each update
          past the Gauss–Seidel value accelerates convergence several-fold in the real-time sweep
          budget, without changing the solution it converges to.
        </p>
        <p>
          One honest caveat, shown right in the verification page: on a <em>collocated</em> grid
          (velocity and pressure sampled at the same points) the divergence and pressure-gradient
          stencils compose into a wide one, so projection drives the smooth divergence down sharply
          but leaves a small high-frequency “checkerboard” residual it can’t remove. It’s harmless
          here — and the suite measures it rather than hiding it.
        </p>

        <h2>A faster road to the same answer — Conjugate Gradients</h2>
        <p>
          The pressure Poisson equation is a large, sparse, <strong>symmetric
          positive-semidefinite</strong> linear system — the exact case the{' '}
          <strong>Conjugate Gradient</strong> method was built for. Eddy offers CG alongside SOR
          (pick it under <em>Fluid → Pressure solver</em>). It is <em>matrix-free</em>: rather than
          storing a matrix it applies the same five-point Neumann/obstacle stencil the relaxation
          uses, so the two solvers attack the identical system. CG drives the residual down across
          the whole spectrum at once instead of sweep-by-sweep, so it reaches a given accuracy in a
          small fraction of the iterations — the <a href="#/verify">Verify</a> page shows it landing
          several times lower than SOR at an equal budget, and converging to the <em>same</em>
          projected field. (The right-hand side is shifted to be mean-zero first: the pure-Neumann
          system is singular up to a constant, and that compatibility step keeps CG from stalling on
          the null space. Only the pressure gradient is used, so the constant is irrelevant.)
        </p>

        <h2>The work-optimal solver — geometric multigrid</h2>
        <p>
          SOR and even CG share a blind spot: they kill <em>jagged</em> error fast but crawl on the{' '}
          <em>smooth</em>, long-wavelength error — which is most of the pressure field. So their cost
          to a fixed accuracy grows with the grid. <strong>Multigrid</strong> removes that ceiling
          with one idea: error that looks smooth on a fine grid looks <em>oscillatory</em> on a
          coarser one, where a cheap relaxation flattens it. A <strong>V-cycle</strong> smooths on the
          fine grid, transfers (<em>restricts</em>) the leftover residual to a 2× coarser grid,
          recurses all the way down to a handful of cells, then interpolates (<em>prolongs</em>) the
          correction back up and smooths again. Because every error wavelength is handled on the grid
          where it’s cheap to resolve, the residual drops by a near-constant factor <em>per cycle</em>{' '}
          — a convergence rate that <strong>doesn’t degrade as the grid grows</strong>, the textbook
          O(N) (work-optimal) Poisson solver. Eddy builds the whole hierarchy from scratch: red-black
          smoothing on the same Neumann/obstacle Laplacian, cell-centred bilinear prolongation, its
          transpose for restriction, and a 2×2 agglomeration of the obstacle mask.
        </p>
        <p>
          A bare V-cycle is happiest on open domains; intricate embedded boundaries make its
          coarse-grid correction overshoot. The fix is <strong>MGCG</strong> — use a single symmetric
          V-cycle as the <em>preconditioner</em> inside Conjugate Gradients. CG is forgiving of an
          imperfect preconditioner (it still converges to the exact answer), while the V-cycle gives
          it a near-perfect, grid-independent approximate inverse — so MGCG reaches machine-level
          residual in a fixed handful of iterations <em>regardless of resolution</em> and stays robust
          around obstacles. The <a href="#/verify">Verify</a> page shows the convergence factor barely
          moving between a 48² and a 96² grid, and MGCG crushing plain CG at an equal budget while
          landing on the identical field. Pick either under <em>Fluid → Pressure solver</em>.
        </p>

        <h2>Reactive flow — combustion</h2>
        <p>
          Beyond carrying heat, Eddy can <em>make</em> it. A separate <strong>fuel</strong> field is
          advected by the flow like the dye; wherever it is hotter than the <em>ignition</em>
          temperature it burns at a first-order (Arrhenius-lite) rate, releasing heat back into the
          temperature field and being consumed in the process — depositing bright flame and soot dye
          as it reacts. Couple that with <strong>variable-density buoyancy</strong> (a
          non-Boussinesq lift proportional to the local smoke concentration, distinct from the
          thermal term) and you get a genuine self-sustaining <strong>Fire</strong> scene: fuel
          rises from a burner, ignites, buoys its own hot products upward, and trails rising smoke.
          The verification page pins the model down — nothing burns below ignition, burning strictly
          consumes fuel while raising heat, and fuel is exactly conserved when the reaction is off.
        </p>

        <h2>Seeing the flow — streamlines, tracers, LIC &amp; schlieren</h2>
        <p>
          Colour alone hides the velocity field’s structure. Several overlays and modes expose it:{' '}
          <strong>streamlines</strong> integrate the instantaneous velocity from a lattice of seeds
          (midpoint/RK2) so vortices and stagnation points pop out; thousands of passive{' '}
          <strong>tracer particles</strong> are carried along the flow and drawn as short
          velocity-aligned streaks; and the <strong>hover probe</strong> reads the actual field
          values — velocity, speed, vorticity, pressure, temperature, fuel — under your cursor.
        </p>
        <p>
          Two render modes show the <em>whole</em> field at once.{' '}
          <strong>Line Integral Convolution</strong> (Cabral &amp; Leedom, 1993) smears a white-noise
          texture <em>along</em> the streamlines, so every pixel reveals the local flow direction as
          a dense, fabric-like weave — and it animates downstream. <strong>Schlieren</strong> shading
          images the magnitude of the dye-density gradient <code>|∇ρ|</code>, the way an optical
          schlieren rig makes plumes and shock waves visible by refraction. The LIC core is a pure
          function, so the suite checks it too (it reduces to the identity under no flow, can’t
          overshoot the noise, and provably streaks along the flow).
        </p>
        <p>
          Finally, the <strong>Q-vortex</strong> mode renders the <strong>Q-criterion</strong>
          <code> Q = ½(‖Ω‖² − ‖S‖²)</code> — the part of the velocity gradient where rotation beats
          strain. It lights up genuine <em>vortex cores</em> while ignoring the plain shear that a
          raw vorticity view can’t tell apart from a vortex (a uniform shear has vorticity but{' '}
          <code>Q = 0</code>; a solid-body rotation has <code>Q = Ω² &gt; 0</code> — both checked on
          the Verify page).
        </p>

        <h2>The energy cascade — a spectrum from a from-scratch FFT</h2>
        <p>
          A turbulent field looks like noise, but in Fourier space it has structure: a{' '}
          <strong>kinetic-energy spectrum</strong> <code>E(k)</code> telling how much energy lives at
          each spatial scale. The <a href="#/spectra">Spectra lab</a> evolves a decaying-turbulence
          field live and, every few frames, runs its velocity through a from-scratch radix-2{' '}
          <strong>2-D FFT</strong> to plot <code>E(k)</code> on log–log axes. Two dimensions are
          special (Kraichnan, 1967): energy flows <em>up</em> the scales — small vortices merging into
          larger ones (the <strong>inverse cascade</strong>) — while enstrophy flows <em>down</em>,
          steepening the spectrum toward the <code>k<sup>−3</sup></code> enstrophy range (drawn as a
          reference slope). The transform is exact: it inverts to machine precision, obeys{' '}
          <strong>Parseval’s theorem</strong> (the spectrum sums to the physical kinetic energy), and
          localises a pure sinusoid to a single shell — all on the Verify page.
        </p>

        <h2>Does it actually work? The verification page</h2>
        <p>
          A solver you can’t check is a solver you can’t trust. The <a href="#/verify">Verify</a> page
          runs a battery of numerical checks live in your browser: that projection removes
          divergence and adds no left/right bias, that the linear solve really converges and SOR
          beats plain Gauss–Seidel, that advection reproduces constants and obeys a maximum principle
          (no overshoot, no negative dye), that diffusion conserves heat and smooths it, that the
          discrete curl matches a solid-body rotation exactly, that buoyancy lifts hot fluid, and
          that the whole thing stays bounded for any timestep. It now also checks the newer
          machinery: that Conjugate Gradients beats SOR per iteration, converges, respects obstacles,
          and lands on the same field; that <strong>multigrid</strong> converges with a
          grid-independent rate and <strong>MGCG</strong> crushes plain CG while reaching the same
          answer; that the implicit diffusion decays a Fourier mode at exactly its analytic
          (backward-Euler) rate; that the <strong>FFT</strong> round-trips, obeys Parseval, and
          localises a single mode; that combustion only burns above ignition, consumes fuel while
          releasing heat, and conserves fuel when off; and that the LIC texture is the identity under
          no flow, obeys a maximum principle, and streaks along the flow. Each check reports the
          number it measured — <strong>34 checks across 11 groups</strong>.
        </p>

        <h2>Rendering</h2>
        <p>
          Three dye channels (R/G/B) are advected through the same velocity field, so colours mix
          like real ink. The dye is tonemapped (Reinhard) to keep highlights from clipping. You can
          also visualise raw speed, signed vorticity, or the pressure field with perceptual
          colour-maps, and overlay the velocity vectors.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}
