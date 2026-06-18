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

        <h2>Seeing the flow — streamlines &amp; tracers</h2>
        <p>
          Colour alone hides the velocity field’s structure. Two overlays expose it:{' '}
          <strong>streamlines</strong> integrate the instantaneous velocity from a lattice of seeds
          (midpoint/RK2) so vortices and stagnation points pop out, and thousands of passive{' '}
          <strong>tracer particles</strong> are carried along the flow and drawn as short
          velocity-aligned streaks, turning even a paused frame into a legible picture of motion.

        </p>

        <h2>Does it actually work? The verification page</h2>
        <p>
          A solver you can’t check is a solver you can’t trust. The <a href="#/verify">Verify</a> page
          runs a battery of numerical checks live in your browser: that projection removes
          divergence and adds no left/right bias, that the linear solve really converges and SOR
          beats plain Gauss–Seidel, that advection reproduces constants and obeys a maximum principle
          (no overshoot, no negative dye), that diffusion conserves heat and smooths it, that the
          discrete curl matches a solid-body rotation exactly, that buoyancy lifts hot fluid, and
          that the whole thing stays bounded for any timestep. Each check reports the number it
          measured.
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
