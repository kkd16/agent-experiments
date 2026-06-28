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
        <p>
          But <code>E(k)</code> only says <em>where</em> the energy is, not which way it is moving.
          For that the lab also computes the spectral <strong>energy flux</strong> <code>Π(k)</code>.
          The nonlinear term splits into a rotational part <code>ω×u</code> and a gradient part; the
          gradient part is parallel to <code>k</code> in Fourier space and so does no work on the
          (divergence-free, hence <code>k</code>-perpendicular) velocity — it cannot move energy
          between scales. The rotational part carries all the transfer, and because{' '}
          <code>u·(ω×u) = 0</code> at every point, the energy fed into all shells sums to{' '}
          <em>exactly zero</em>: the nonlinearity only <em>shuffles</em> energy across scales, never
          creates it (the Verify page checks <code>∑ₖ T(k) = 0</code> to round-off). The cumulative
          flux <code>Π(k)</code> then reveals the 2-D inverse cascade as a clean <em>negative</em>
          flux — energy flowing to large scales. Switch the lab to <strong>Forced</strong> to stir
          the fluid continuously at a small scale against a large-scale drag; it settles into a
          steady state with a sustained <code>k<sup>−5/3</sup></code> inertial range and a steady
          negative flux through it. Alongside <code>E(k)</code> the same FFT yields the{' '}
          <strong>enstrophy</strong> spectrum <code>Z(k)</code> and the scalar-variance spectrum{' '}
          <code>V(k)</code> of a stirred dye — each verified to integrate to its physical total.
        </p>

        <h2>The hidden skeleton — Lagrangian coherent structures</h2>
        <p>
          A velocity snapshot tells you where the fluid points <em>now</em>; it does not tell you how
          a drop of dye will be stretched over the next second. That is a <em>Lagrangian</em>
          question, answered by the <strong>flow map</strong> <code>φ_τ</code> — where each point
          lands after following the flow for a time <code>τ</code>. Two neighbouring tracers separate
          at a rate set by the gradient of that map, and the{' '}
          <strong>finite-time Lyapunov exponent</strong> measures the largest such stretching:{' '}
          <code>FTLE = (1/|τ|)·ln√λ_max(C)</code>, where <code>C = (∇φ_τ)ᵀ∇φ_τ</code> is the
          Cauchy–Green strain tensor. The ridges of the FTLE field are{' '}
          <strong>Lagrangian Coherent Structures</strong> — the material curves that organise mixing.
          <strong> Forward-time</strong> ridges are <em>repelling</em> (a watershed two parcels fall
          off either side of); <strong>backward-time</strong> ridges are <em>attracting</em> — exactly
          the filaments where dye and floating debris collect, which is why the backward-FTLE often
          mirrors the dye pattern. Eddy integrates the flow map of the frozen field with RK4, takes
          the gradient by central differences of neighbouring landing points, and reads{' '}
          <code>λ_max</code> from the closed-form 2×2 eigenvalue. Choose the <strong>LCS</strong>
          render mode. The Verify page pins it to ground truth: on a hyperbolic saddle the FTLE equals
          the analytic strain rate, and on a rigid rotation (which stretches nothing) it is zero.
        </p>

        <h2>Closing the box — open channels &amp; the Schmidt number</h2>
        <p>
          A sealed tank is mass-locked: fluid pumped in has nowhere to go, so a wake piles up against
          the far wall and recirculates. A real wind tunnel is a <em>channel</em>. Eddy can open a
          domain edge to <strong>outflow</strong>: a zero-gradient condition on the velocity lets the
          flow leave, and a <strong>Dirichlet pressure</strong> (<code>p = 0</code>) at the outlet
          makes the (otherwise singular pure-Neumann) pressure system non-singular and lets the box
          pass a net through-flow. The <em>Vortex street (open channel)</em> scene uses it, so the
          shed vortices sail off downstream instead of recirculating — the honest von Kármán street.
          Separately, the dye carries its own diffusivity <code>κ_s</code>, decoupled from the
          momentum viscosity <code>ν</code>; their ratio is the <strong>Schmidt number</strong>{' '}
          <code>Sc = ν/κ_s</code>, which sets how sharp the ink’s filaments stay relative to the
          velocity field (high <code>Sc</code> folds ink into ever-finer streaks). Both are verified:
          an open channel sustains a through-flow a closed box stalls, and a dye mode diffuses at
          exactly its own Schmidt-number rate.
        </p>

        <h2>Magnetohydrodynamics — a magnetized fluid</h2>
        <p>
          Most fluids in the universe — the Sun, the solar wind, the interstellar medium, a tokamak —
          are <em>plasmas</em>: electrically conducting, and threaded by magnetic fields they carry and
          bend. <strong>Magnetohydrodynamics</strong> (MHD) is the fluid theory of that coupling. Turn
          MHD on and Eddy evolves an in-plane field <code>B = (Bx, By)</code> alongside the flow, in
          Alfvén units (<code>ρ = μ₀ = 1</code>):
        </p>
        <pre>{`∂u/∂t + (u·∇)u = −∇P* + ν∇²u + (B·∇)B     (Lorentz force)
∂B/∂t + (u·∇)B = (B·∇)u + η∇²B            (induction)
∇·u = 0,   ∇·B = 0`}</pre>
        <p>
          Two new pieces, and remarkably both reuse machinery already here. The{' '}
          <strong>Lorentz force</strong> <code>(∇×B)×B = (B·∇)B − ∇(½|B|²)</code> is the field pushing
          back on the flow; it splits into a <em>tension</em> along the field lines and a{' '}
          <em>magnetic pressure</em>. We add only the tension <code>(B·∇)B</code> as a body force — the
          magnetic pressure is a pure gradient, so the velocity’s own pressure projection removes it for
          free, reproducing the full Lorentz force exactly. The <strong>induction equation</strong>{' '}
          carries the field with the flow (a semi-Lagrangian advection of <code>B</code>) and{' '}
          <strong>stretches</strong> it (<code>(B·∇)u</code>, the term that amplifies a field when the
          flow pulls a field line taut — flux-freezing, and the engine of the dynamo).
        </p>
        <p>
          And <code>∇·B = 0</code> — no magnetic monopoles — is enforced by the <em>same Hodge
          projection</em> that keeps the velocity incompressible, now cleaning the magnetic field every
          step. No new linear algebra: incompressibility and the no-monopole law are the same
          mathematics. With resistivity <code>η = 0</code> the field is frozen into the fluid (Alfvén’s
          theorem); raise <code>η</code> and field lines can slip and <strong>reconnect</strong>.
        </p>
        <p>
          The payoff is real plasma physics: pluck a field line and it snaps back as an{' '}
          <strong>Alfvén wave</strong> travelling at <code>v_A = B₀/√(ρμ₀)</code> (the Verify page times
          it against the closed-form dispersion <code>ω = v_A·k</code>); wind the field up in the{' '}
          <strong>Orszag–Tang</strong> vortex and it steepens into thin sheets of electric current; lay
          two opposed fields against each other and they <strong>reconnect</strong>, firing plasma jets,
          the mechanism of solar flares. Watch it in the <strong>Current (jz)</strong>,{' '}
          <strong>|B|</strong> and <strong>B-field-line</strong> render modes.
        </p>

        <h2>The kinetic route — Lattice Boltzmann (the Kinetic lab)</h2>
        <p>
          Everything above marches the Navier–Stokes equations <em>directly</em>: a velocity field, a
          pressure solve, operator splitting. The <a href="#/kinetic">Kinetic lab</a> reaches the very
          same physics from the opposite end. It never writes Navier–Stokes down at all. It tracks a
          fictitious gas of particles through their distribution <code>f(x, e, t)</code> — “how much
          fluid at <code>x</code> is streaming along lattice velocity <code>e</code>” — on the{' '}
          <strong>D2Q9</strong> lattice (a rest state plus eight neighbours), and evolves it by two
          spectacularly simple local rules:
        </p>
        <pre>{`fᵢ(x + eᵢ, t+1) = fᵢ(x, t) − Ωᵢ          (stream, then collide)
Ωᵢ = ωⁱ (fᵢ − fᵢᵉ𐞥),   fᵢᵉ𐞥 = wᵢρ[1 + 3(eᵢ·u) + 4.5(eᵢ·u)² − 1.5|u|²]`}</pre>
        <p>
          <em>Stream</em>: every population hops to its neighbour. <em>Collide</em>: it relaxes toward a
          local equilibrium <code>fᵉ𐞥</code> (the lattice’s truncated Maxwell–Boltzmann). That is the
          whole algorithm — no global pressure solve, perfectly local, the density and velocity recovered
          as the moments <code>ρ = Σfᵢ</code>, <code>ρu = Σfᵢeᵢ</code>. And yet a{' '}
          <strong>Chapman–Enskog</strong> multi-scale expansion proves that the slow moments of this
          update obey incompressible Navier–Stokes to second order, with a viscosity set <em>only</em> by
          the relaxation time: <code>ν = c_s²(τ − ½)</code>, <code>c_s² = ⅓</code>. The Verify page
          measures that ν straight back out of a decaying shear wave — the kinetic-to-hydrodynamic bridge,
          confirmed live.
        </p>
        <p>
          The implementation is all from scratch and carries the real machinery, including three
          collision operators of increasing sophistication: single-relaxation <strong>BGK</strong>;{' '}
          <strong>two-relaxation-time (TRT)</strong>, whose “magic” parameter <code>Λ = 3/16</code> pins
          the bounce-back wall exactly half-way between nodes (so a body-forced channel reproduces the
          analytic Poiseuille parabola to ~0.1%, where BGK would slip); and{' '}
          <strong>multiple-relaxation-time (MRT)</strong>, which transforms the populations into nine
          physical moments (density, momentum, energy, stresses…), relaxes each at its own rate — the
          stresses carry the viscosity while the unphysical “ghost” modes are damped hard for stability —
          and maps back through an inverse built numerically at load (so the transform can’t drift).{' '}
          <strong>Guo forcing</strong> for body forces (projected into moment space for MRT); half-way{' '}
          <strong>bounce-back</strong> for no-slip walls and a moving-wall variant for the lid-driven
          cavity; a <strong>Zou–He</strong> velocity inlet and an extrapolation outflow for the open
          channel; and a <strong>Smagorinsky LES</strong> sub-grid model whose eddy viscosity is read
          from the <em>local non-equilibrium stress</em> <code>Π^neq</code> — a strain-rate tensor LBM
          hands you for free at every node, no finite differences. Flow past the cylinder sheds a{' '}
          <strong>von Kármán vortex street</strong>; the lab times the wake oscillation and reports its{' '}
          <strong>Strouhal number</strong> against Williamson’s experimental fit, and reads the drag and
          lift off a from-scratch <strong>momentum-exchange</strong> sum over the bounce-back links (lift
          oscillates at the shedding frequency, drag at twice it). Two solvers, two universes, one fluid.
        </p>

        <h2>Heat that drives the flow — thermal lattice Boltzmann (the Convection lab)</h2>
        <p>
          The kinetic solver above carries momentum. Temperature is a <em>second</em> conserved field, so
          the textbook way to make a lattice fluid convect is the <strong>double-distribution model</strong>:
          carry a <em>second</em> nine-velocity distribution <code>g</code> whose single conserved moment is
          the temperature, <code>T = Σᵢ gᵢ</code>, relaxing toward the advection–diffusion equilibrium{' '}
          <code>g^eq_i = wᵢ T (1 + eᵢ·u / c_s²)</code>. A Chapman–Enskog expansion of <em>its</em> stream +
          collide gives the advection–diffusion equation <code>∂ₜT + u·∇T = α∇²T</code> with a thermal
          diffusivity fixed only by <code>g</code>’s relaxation time — the exact scalar twin of the viscosity
          law:
        </p>
        <pre>{`α = c_s² (τ_g − ½)        (the scalar Chapman–Enskog bridge)`}</pre>
        <p>
          The two lattices are coupled <em>both</em> ways: <code>g</code> is advected by the velocity{' '}
          <code>u</code> it reads off the flow, and the flow <code>f</code> feels a per-node{' '}
          <strong>Boussinesq buoyancy</strong> body force <code>F = ρ·gβ·(T − T_ref)·ĝ</code> — hot fluid is
          lighter, so it rises — injected with the very same exact second-order Guo forcing the Kinetic lab
          uses. That tiny addition is enough to make the two most iconic instabilities in fluid dynamics fall
          out of nothing but stream + collide. Thermal walls are first-class: a fixed-temperature (Dirichlet)
          wall is an <strong>anti-bounce-back</strong> <code>gᵢ = −g*_ī + 2wᵢT_wall</code> that pins{' '}
          <code>T</code> half-way between nodes, an adiabatic (zero-flux) wall is plain bounce-back, and a
          direction can be periodic.
        </p>
        <p>
          The <a href="#/thermal">Convection lab</a> dials the dimensionless <strong>Rayleigh number</strong>{' '}
          <code>Ra = gβΔT·H³/(να)</code> — buoyancy’s strength relative to the diffusive damping that fights
          it — and the <strong>Prandtl number</strong> <code>Pr = ν/α</code>, deriving ν, α and the buoyancy
          coefficient from them at a fixed low-Mach free-fall velocity. In <strong>Rayleigh–Bénard</strong>{' '}
          (hot floor, cold ceiling) the motionless conduction state is linearly stable below the{' '}
          <strong>critical Rayleigh number</strong> <code>Ra_c ≈ 1708</code> and breaks into counter-rotating{' '}
          <strong>convection rolls</strong> above it; the lab measures this onset on the Verify page and lands
          it on the textbook value. The <strong>heated cavity</strong> is the de Vahl Davis (1983)
          natural-convection benchmark — hot and cold side walls driving one recirculation, whose average{' '}
          <strong>Nusselt number</strong> the suite reproduces to a few percent. The <strong>thermal plume</strong>{' '}
          is a continuous buoyant updraft mushrooming off a hot floor patch. The lab reads the Nusselt number{' '}
          <code>Nu = 1 + ⟨u·T⟩·H/(αΔT)</code> — the ratio of total to purely conductive heat transport — live;
          it sits at exactly 1 while the fluid is still and climbs as the rolls carry heat. Four kinetic
          solvers now, four universes, one fluid.
        </p>

        <h2>Two phases of one fluid — Shan–Chen multiphase (the Phase lab)</h2>
        <p>
          The kinetic solver above carries a single fluid. The <a href="#/phase">Phase lab</a> carries the
          <em> interface</em> — the boundary between a liquid and its own vapour — and the force that lives
          on it: <strong>surface tension</strong>. Remarkably, it takes just one extra ingredient. Give
          every lattice site a <strong>pseudopotential</strong> <code>ψ(ρ) = 1 − e^(−ρ)</code> and add, as
          a body force, a short-range attraction toward denser neighbours (Shan &amp; Chen, 1993):
        </p>
        <pre>{`F(x) = −G · ψ(x) · Σᵢ wᵢ ψ(x + eᵢ) eᵢ        (sum over the 8 links)`}</pre>
        <p>
          A Chapman–Enskog expansion shows this force endows the fluid with a <strong>non-ideal equation of
          state</strong> <code>p = c_s²ρ + ½c_s²G·ψ²</code> — a van-der-Waals-like loop. When the cohesion
          <code> G</code> is strong enough that <code>dp/dρ</code> goes <em>negative</em> over a band of
          densities, the fluid is mechanically unstable there and spontaneously <strong>separates</strong>{' '}
          into a dense liquid and a thin vapour, with a sharp interface a few cells wide. For this ψ the
          threshold is <strong>exactly <code>G_c = −4</code></strong> — the point where <code>dp/dρ</code>{' '}
          and <code>d²p/dρ²</code> vanish together, at <code>ρ = ln 2</code>. Surface tension then falls out
          for free: the inside of a droplet sits at a higher pressure than the outside by exactly{' '}
          <strong>Δp = σ/R</strong> (<strong>Laplace’s law</strong>, in 2-D), with a single constant{' '}
          <code>σ</code>. The Verify page measures that line across four droplet radii (r² &gt; 0.99); the
          Droplet scene reads <code>Δp·R</code> live. There is no interface tracking, no level set, no front
          reconstruction anywhere — the boundary is simply <em>wherever the density jumps</em>.
        </p>
        <p>
          From that one force the whole zoo follows. <strong>Spinodal decomposition</strong>: a noisy fluid
          unmixes into a foam of droplets that <em>coarsen</em> over time (small drops evaporate into big
          ones — Ostwald ripening). <strong>Coalescence</strong>: two drops touching merge into one,
          because a single larger drop has less interface. <strong>Wetting</strong>: an analogous adhesion
          force toward solid sites, <code>G_ads</code>, sets a droplet’s <strong>contact angle</strong> on a
          floor — hydrophilic (spreads) for positive adhesion, hydrophobic (beads up) for negative. And with
          a mean-subtracted gravity, liquid drops <strong>rain</strong> down through the vapour and splash on
          the floor — while, because the cohesion is Newton’s-third-law antisymmetric (<code>ΣF = 0</code>),
          total momentum is still conserved to round-off. The one honest blemish, reported rather than
          hidden, is the small <strong>spurious current</strong> a curved discrete interface generates at
          equilibrium — a known pseudopotential artefact, kept small here by the smooth ψ. Three solvers,
          three universes, one fluid.
        </p>

        <h2>Two different fluids that won’t mix — multi-component Shan–Chen (the Phase lab’s second model)</h2>
        <p>
          The model above splits <em>one</em> fluid into its own liquid and vapour. Flip the{' '}
          <a href="#/phase">Phase lab</a> to <strong>“Two fluids · immiscible”</strong> and you get the other
          canonical Shan–Chen model: <strong>two genuinely different fluids</strong> — “red” and “blue”, the
          way oil and water are — that refuse to blend. Each species streams and collides on its <em>own</em>{' '}
          D2Q9 lattice, and the only coupling is a single short-range <strong>cross-repulsion</strong>: each
          fluid is pushed away from the <em>other</em>’s dense neighbours,
        </p>
        <pre>{`F_σ(x) = −G · ρ_σ(x) · Σᵢ wᵢ ρ_σ′(x + eᵢ) eᵢ        (σ′ is the other fluid)`}</pre>
        <p>
          giving the binary mixture the non-ideal pressure <code>p = c_s²(ρ₁+ρ₂) + c_s²G·ρ₁ρ₂</code>. Above a
          critical coupling the well-mixed state is unstable: the fluids <strong>demix</strong> into pure
          domains separated by a thin interface with a real, emergent <strong>surface tension</strong> — and
          from that one force every classic immiscible-fluid phenomenon follows. A heavy fluid resting on a
          light one <strong>fingers downward</strong> (the <strong>Rayleigh–Taylor</strong> instability); a
          liquid <strong>thread pinches into a row of drops</strong> (<strong>Rayleigh–Plateau</strong>); a
          suspended drop of one fluid in the other obeys <strong>Laplace’s law</strong> Δp = σ/R (read live,
          and pinned across four radii on the Verify page); and a <strong>sessile</strong> drop’s{' '}
          <strong>contact angle</strong> bends with how strongly each fluid wets the wall. Both species share a
          momentum-conserving <strong>common velocity</strong>, so the interaction injects no net momentum —
          the box can never spontaneously propel itself (<code>ΣF = 0</code>, checked to ~1e-13), and each
          fluid’s mass is conserved separately to round-off. Four solvers now, four universes.
        </p>

        <h2>When the fluid can be squeezed — compressible gas dynamics (the Gas lab)</h2>
        <p>
          Every solver above holds the fluid <strong>incompressible</strong>: a pressure projection pins the
          velocity divergence-free, which is the same as saying the speed of sound is infinite — no sound waves,
          and crucially <em>no shocks</em>. The <a href="#/gas">Gas lab</a> is the opposite physics. It marches
          the <strong>compressible Euler equations</strong> for the conserved density, momentum and energy,
        </p>
        <pre>{`∂U/∂t + ∂F(U)/∂x + ∂G(U)/∂y = 0,   U = [ρ, ρu, ρv, E],   p = (γ−1)(E − ½ρ|u|²)`}</pre>
        <p>
          whose solutions form genuine <strong>discontinuities</strong> in finite time — a smooth flow steepens
          into a <strong>shock wave</strong>. You cannot reach a shock with a smooth central-difference scheme;
          it builds Gibbs oscillations and blows up. The fix, due to Godunov, is to treat every cell interface
          as a tiny <strong>Riemann problem</strong> and take the upwind flux its wave structure dictates. So
          each step <strong>reconstructs</strong> a second-order, slope-limited (<strong>minmod MUSCL-Hancock</strong>)
          state on either side of every face — a half-step predictor evolves it by its own flux for second order
          in time too — then resolves the face with an <strong>HLLC</strong> three-wave Riemann flux that keeps
          the <em>contact</em> and shear waves sharp where a cruder flux would smear them. A CFL condition on the
          signal speed <code>|u|+a</code> sets the step, and 2-D is handled by Strang-splitting the 1-D sweeps.
        </p>
        <p>
          The beautiful thing about 1-D gas dynamics is that the Riemann problem has an <strong>exact analytic
          solution</strong> — iterate the pressure function <code>f_L(p)+f_R(p)+Δu = 0</code> for the star-region
          pressure, then sample the self-similar wave fan. The lab draws that exact answer as a pale line under
          the computed <strong>Sod</strong> and <strong>Lax</strong> shock-tube profiles, so you watch a
          second-order scheme settle onto the truth; the <a href="#/verify">Verify</a> page measures the gap and
          confirms it shrinks as the mesh refines. The other scenes are the canonical gallery: a Sedov point
          <strong> blast</strong>, the four-shock <strong>2-D Riemann</strong> problem, a compressible{' '}
          <strong>Kelvin–Helmholtz</strong> roll-up, <strong>Rayleigh–Taylor</strong> under gravity, the
          Liska–Wendroff <strong>implosion</strong>, and a Mach-1.5 shock shredding a light gas{' '}
          <strong>bubble</strong>. Switch to the <strong>Schlieren</strong> view to shadowgraph <code>|∇ρ|</code>{' '}
          and the shock fronts read exactly as they would in a wind-tunnel photograph.
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
          no flow, obeys a maximum principle, and streaks along the flow. The newest physics is held
          to the same bar: the scalar-variance and enstrophy spectra obey Parseval, the nonlinear
          energy transfer is <em>exactly conservative</em> (<code>∑ₖ T(k) = 0</code>), the FTLE
          reproduces the analytic strain rate of a saddle and vanishes on a rigid rotation, an open
          channel sustains a through-flow a closed box stalls, and the dye diffuses at its own
          Schmidt-number rate. The MHD pillar is held to the same bar (∇·B cleaning, the Alfvén
          dispersion relation, ideal-MHD energy conservation, flux-freezing, the Orszag–Tang
          current-sheet). And the <strong>Lattice Boltzmann</strong> solver earns its own group: the
          equilibrium’s exact mass/momentum/Euler-stress moments, mass conservation, the{' '}
          <strong>Chapman–Enskog viscosity</strong> <code>ν = c_s²(τ−½)</code> measured from a shear
          wave, the exact <strong>Poiseuille</strong> parabola from the TRT magic wall, and the local
          strain rate read from <code>Π^neq</code>, and that the <strong>MRT</strong> moment transform
          round-trips exactly and reproduces the same viscosity. The <strong>multiphase</strong> solver
          earns its own group too: the fluid only separates below the exact critical strength{' '}
          <code>G_c = −4</code> (and stays mixed above it), mass is conserved to round-off, a flat
          interface settles to bulk phases of <em>equal pressure</em>, droplets obey{' '}
          <strong>Laplace’s law</strong> <code>Δp = σ/R</code> with one positive surface tension, the
          internal cohesion force conserves momentum (<code>ΣF = 0</code>), and the spurious interface
          currents stay small. The <strong>multi-component</strong> (two-fluid) model earns a group of its
          own as well: a blended mixture <em>demixes</em> above the critical coupling (and stays mixed below
          it), each species’ mass and the total momentum are conserved to round-off, and a drop of one fluid
          suspended in the other obeys <strong>Laplace’s law</strong> across four radii. The newest{' '}
          <strong>thermal LBM</strong> earns its own group as well: the scalar’s{' '}
          <strong>Chapman–Enskog diffusivity</strong> <code>α = c_s²(τ_g−½)</code> read off a decaying
          temperature wave, the exact conduction limit (a linear profile and Nusselt number{' '}
          <code>Nu = 1</code>), adiabatic walls that leak no heat, the recovery of the textbook{' '}
          <strong>critical Rayleigh number</strong> <code>Ra_c ≈ 1708</code> for the onset of convection, and
          the <strong>de Vahl Davis</strong> heated-cavity Nusselt number reproduced to a few percent. The{' '}
          <strong>compressible gas dynamics</strong> group rounds it out with an <em>analytic</em> yardstick the
          incompressible solvers don’t have: the exact Sod star state (<code>p* = 0.30313</code>,{' '}
          <code>u* = 0.92745</code>), the HLLC flux’s consistency, the captured shock obeying all three{' '}
          <strong>Rankine–Hugoniot</strong> jump conditions, the Sod tube’s <strong>L1 convergence</strong> to
          the exact Riemann solution, round-off conservation of mass/momentum/energy, and blast positivity. Each
          check reports the number it measured — <strong>82 checks across 19 groups</strong>.
        </p>

        <h2>Rendering</h2>
        <p>
          Three dye channels (R/G/B) are advected through the same velocity field, so colours mix
          like real ink. The dye is tonemapped (Reinhard) to keep highlights from clipping. You can
          also visualise raw speed, signed vorticity, the pressure or temperature field, the
          Q-criterion vortex cores, an animated LIC weave, schlieren shading, or the{' '}
          <strong>LCS</strong> (FTLE) transport skeleton — each with perceptual colour-maps — and
          overlay the velocity vectors, streamlines or tracer particles.
        </p>

        <a className="back" href="#/">
          ← Back to the studio
        </a>
      </div>
    </div>
  );
}
