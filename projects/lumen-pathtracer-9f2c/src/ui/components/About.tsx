// About.tsx — a written tour of how the renderer works, for curious visitors.

import type { ReactNode } from 'react'

export function About() {
  return (
    <div className="about">
      <h2>How Lumen works</h2>
      <p className="lead">
        Lumen is a physically based <strong>Monte-Carlo path tracer</strong> written from scratch in
        TypeScript — no WebGL, no GPU, no third-party math. It numerically solves the rendering
        equation by tracing thousands of random light paths per pixel and averaging their
        contributions, converging to a photorealistic image. It ships <strong>four</strong>{' '}
        light-transport integrators — a unidirectional path tracer, a bidirectional path tracer,
        primary-sample-space Metropolis, and stochastic progressive photon mapping — that provably
        converge to the <em>same</em> image.
      </p>

      <div className="about-grid">
        <Card title="The rendering equation">
          Every pixel estimates{' '}
          <code>L₀ = Lₑ + ∫ f(ωᵢ,ω₀)·Lᵢ(ωᵢ)·cosθ dωᵢ</code> by Monte-Carlo integration. Paths start
          at the camera and random-walk through the scene, accumulating throughput until they reach a
          light or escape to the environment.
        </Card>
        <Card title="Multiple importance sampling">
          At each surface two estimators compete: sampling a light directly (great for small bright
          lights) and sampling the BSDF lobe (great for glossy surfaces and broad skies). The{' '}
          <em>power heuristic</em> blends them, so neither one’s variance dominates.
        </Card>
        <Card title="Bidirectional path tracing">
          The path tracer only grows paths from the camera, so it struggles when the light that
          matters is hard to reach — a bulb hidden in a cove, a room lit only by bounced light.{' '}
          <strong>BDPT</strong> also grows a path <em>from a light</em> and then <em>connects</em>{' '}
          every camera vertex to every light vertex; multiple importance sampling (the balance
          heuristic) blends all of these strategies so the best one for each situation wins. Because
          it estimates the <em>same</em> rendering equation, it must converge to the same image as the
          path tracer — the <strong>Verify</strong> tab proves exactly that by rendering a box both
          ways and checking the means agree, and proves the MIS weights form a partition of unity. Try
          the <em>Cove</em> scene and flip the <strong>Integrator</strong> control: same image, a
          fraction of the noise.
        </Card>
        <Card title="Metropolis light transport (PSSMLT)">
          The path tracer and BDPT both <em>average</em> independent samples. Lumen's third integrator
          instead runs a <strong>Markov chain</strong> through path space. A path tracer is just a
          function from a vector of random numbers to a colour, so PSSMLT (Kelemen et al.) mutates{' '}
          <em>that very random stream</em> — small local nudges and occasional global jumps — and
          accepts each mutation with the Metropolis rule, probability <code>min(1, I′/I)</code>. The
          chain then lingers wherever light is, so it locks onto the hardest-to-find transport (a thin
          caustic, a room lit only by a sliver of bounce) and refines the entire frame at once. A
          one-time <em>bootstrap</em> re-establishes absolute brightness, and the result is the same
          unbiased image — the <strong>Verify</strong> tab renders the Cornell box with both the path
          tracer and PSSMLT and proves their luminance and spatial distribution agree. Beautifully,
          the engine reuses the path tracer <em>verbatim</em>: the Metropolis sampler simply{' '}
          <em>is</em> the random-number generator.
        </Card>
        <Card title="Photon mapping (SPPM)">
          All three of the others build paths that <em>end on a light</em> — the wrong shape for a{' '}
          <strong>caustic</strong>, light focused through glass onto a floor. A shadow ray from the
          floor to the lamp will not refract through the lens, so next-event estimation sees the light
          at measure zero, and a diffuse bounce that threads the glass by luck is astronomically rare.{' '}
          <strong>SPPM</strong> turns the problem around: it shoots <em>photons from the lights</em>,
          lets them refract and reflect through the specular geometry, and records where they land on
          diffuse surfaces — so the rare light→specular→diffuse transport is found <em>by
          construction</em>. Each pass re-traces jittered camera rays to place a measurement point per
          pixel, gathers the photons within a radius, and then <em>shrinks that radius</em> on the
          Hachisuka schedule <code>R²←R²·(N+αM)/(N+M)</code>, which drives the density-estimation bias
          to zero so the estimate <em>converges</em> — to the same image as the path tracer, as the{' '}
          <strong>Verify</strong> tab proves on the Cornell box. Photons are gathered through an exact
          spatial hash (also verified against brute force). Try <em>Caustic Pool</em> or{' '}
          <em>Caustic Room</em> and switch to <strong>Photon Map</strong>: the caustics resolve where
          the other integrators only sputter.
        </Card>
        <Card title="Microfacet BSDFs">
          Surfaces are Lambertian diffuse, GGX/Trowbridge-Reitz metal with height-correlated Smith
          shadowing, or dielectric glass — smooth or <em>frosted</em>, the latter refracting through a
          microfacet interface. Rough lobes use <em>visible-normal (VNDF)</em> sampling for low variance.
        </Card>
        <Card title="Spectral dispersion">
          Dispersive glass is given a wavelength-dependent index of refraction via Cauchy’s law, so a
          path commits to a random <em>hero wavelength</em> on entry and refracts blue more sharply than
          red. A white-point-normalised wavelength→RGB map fans white light into a real prism rainbow.
        </Card>
        <Card title="Volumetric absorption">
          Coloured glass is not a surface tint but <em>Beer–Lambert</em> physics: the integrator tracks
          the medium a ray is inside and attenuates its throughput by e^(−σ·d), so thicker glass and
          longer chords darken and saturate exactly as real amber, emerald and sapphire do.
        </Card>
        <Card title="Participating media">
          Space between surfaces is no longer a vacuum: bounded volumes of fog, smoke and cloud
          scatter light. The integrator samples a <em>free-flight distance</em> from the medium's
          transmittance, and a collision before the next surface makes the path scatter <em>inside</em>{' '}
          the volume — next-event-estimating the lights through the <em>Henyey–Greenstein</em> phase
          function (with phase↔light MIS and shadow rays attenuated by the haze) before sampling a new
          direction. That is what makes light shafts and volumetric shadows — "god rays" — emerge
          physically rather than as a painted-on glow.
        </Card>
        <Card title="Thin-film iridescence">
          The shifting colour of a soap bubble or an oil slick is <em>wave optics</em>, not pigment:
          two reflections off a film only nanometres thick interfere, and their path difference makes
          the reflectance a function of wavelength. We evaluate the exact two-interface <em>Airy
          reflectance</em> per polarisation at the path's hero wavelength, so the same spectral
          machinery that fans a prism into a rainbow fans a flat coating into iridescence.
        </Card>
        <Card title="Low-discrepancy sampling">
          The camera's sub-pixel jitter and depth-of-field lens are drawn from a <em>scrambled Halton</em>{' '}
          sequence with a per-pixel Cranley–Patterson rotation, not white noise. Low-discrepancy points
          blanket the pixel footprint far more evenly, so anti-aliasing and bokeh converge noticeably
          faster for the same sample count — while every deeper bounce keeps its own decorrelated
          pseudo-random stream so global illumination stays unbiased.
        </Card>
        <Card title="Triangle meshes & smooth shading">
          Geometry is no longer just spheres: an indexed mesh library builds icospheres, lathed
          surfaces of revolution and tori, and any pasted <em>Wavefront OBJ</em>. Each triangle
          carries per-vertex normals that are barycentrically interpolated at the hit point, so a few
          hundred flat faces read as a perfectly curved surface — with the geometric normal still
          driving ray offsets so smooth shading never leaks light through the surface.
        </Card>
        <Card title="Analytic daylight sky">
          The sky is the <em>Preetham</em> all-weather model: a closed-form radiance for every
          direction from just the sun's position and the atmospheric turbidity, assembled in CIE xyY
          and converted to linear RGB, with a hard solar disc on top. Slide the sun around and watch
          the whole scene's colour temperature and shadows follow.
        </Card>
        <Card title="Sun next-event estimation">
          The sky isn't only a backdrop — its sun is a <em>sampled light</em>. The integrator
          importance-samples the solar cone directly and MIS-weights it against BSDF sampling (and
          weights escaped rays back), so crisp daylight shadows resolve in a handful of samples
          instead of the thousands pure BSDF sampling would need. Sampling the whole sphere reduces
          exactly to the white-furnace energy test.
        </Card>
        <Card title="Procedural textures">
          Checkerboards, blueprint grids and value-noise marble are evaluated analytically in world
          space — no UVs, no image files — and resolved to a flat colour at each hit so the BSDF math
          never has to know a texture was there.
        </Card>
        <Card title="Adaptive sampling & noise">
          Every pixel tracks its own variance, yielding a live <em>relative-error</em> map you can view
          as a heatmap. Adaptive sampling reads it to retire already-clean regions early, so the budget
          concentrates where the image is still noisy.
        </Card>
        <Card title="SAH bounding volume hierarchy">
          A binned <em>surface-area-heuristic</em> BVH turns the brute-force O(n) ray/scene test into
          an expected O(log n) traversal, which is what makes thousands of triangles tractable on a
          CPU at interactive rates.
        </Card>
        <Card title="A worker pool">
          The image is split into horizontal bands, one per CPU core. Each Web Worker builds its own
          BVH and renders one sample per pass, streaming results back as transferable buffers that the
          main thread accumulates. Sandboxed contexts fall back to a chunked single-thread loop.
        </Card>
        <Card title="Progressive accumulation & denoise">
          Samples accumulate into an HDR buffer that is ACES tone-mapped every frame. An edge-avoiding
          À-Trous wavelet filter, guided by an albedo/normal G-buffer, can clean the remaining noise
          for a crisp still — without touching the underlying samples.
        </Card>
      </div>

      <p className="about-foot">
        Drag the viewport to orbit · scroll to dolly · raise the sample target for a cleaner image ·
        open <strong>Verify</strong> to run the engine’s correctness proofs.
      </p>
    </div>
  )
}

function Card(props: { title: string; children: ReactNode }) {
  return (
    <div className="about-card">
      <h3>{props.title}</h3>
      <p>{props.children}</p>
    </div>
  )
}
