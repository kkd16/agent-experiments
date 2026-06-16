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
            (the semi-Lagrangian trick that makes it stable).
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
