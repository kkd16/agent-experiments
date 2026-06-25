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
        contributions, converging to a photorealistic image. It ships <strong>five</strong>{' '}
        light-transport integrators — a unidirectional path tracer, a <em>path-guided</em> path tracer
        (a learned SD-tree), a bidirectional path tracer, primary-sample-space Metropolis, and
        stochastic progressive photon mapping — that provably converge to the <em>same</em> image.
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
        <Card title="Path guiding (the SD-tree)">
          The path tracer samples the BSDF and the lights and <em>hopes</em> their product with the
          unknown incident radiance is low-variance. Lumen's fifth integrator instead{' '}
          <strong>learns where the light comes from</strong>. As paths are traced, the radiance each
          one carries is recorded into an <strong>SD-tree</strong> (Müller, Gross &amp; Novák 2017): a
          binary <em>spatial</em> k-d tree over the scene, every leaf of which holds a{' '}
          <em>directional</em> quadtree over the sphere of directions. Both refine between iterations
          (each renders twice the samples of the last) — the spatial tree splits where many paths
          pass, the directional quadtree sharpens where a bright direction is found. Then, at each
          surface, the next direction is drawn from a <strong>mixture</strong> of the BSDF and the
          learned guide, <code>p(ω)=α·p_bsdf+(1−α)·p_guide</code>, and weighted by that exact density.
          Because the guide is a genuine probability distribution over the sphere — its density{' '}
          <em>integrates to 1</em>, which the <strong>Verify</strong> tab proves — the estimator stays{' '}
          <strong>unbiased for any learned distribution</strong>: guiding only reshapes the variance,
          never the mean, so it converges to the very same image as the other four. Its home turf is
          light that next-event estimation can't sample: in <em>Glowing Orb</em> the only light is an
          emissive <em>sphere</em> (NEE samples only triangle lights, so it is invisible to it) — blind
          BSDF sampling finds it ~0.5 % of the time and the plain path tracer is all fireflies, while
          the guide learns the orb's direction per region (hitting it ~9 %) and cuts the error. Try it
          and flip between <strong>Path Tracer</strong> and <strong>Guided</strong>.
        </Card>
        <Card title="Many lights (the light BVH)">
          Next-event estimation has to make one discrete choice at every shade point:{' '}
          <strong>which light do I connect a shadow ray to?</strong> Lumen's original answer was to
          pick one <em>uniformly</em>. That is perfect for a Cornell box and a disaster the moment a
          scene has hundreds of emitters — almost every shadow ray is spent on a light that is far,
          occluded, or facing away, while the few lamps that actually illuminate the point are seen
          one-in-a-hundred of the time. More samples don't fix the <em>distribution</em>; sampling
          the right light does. So Lumen builds a <strong>light BVH</strong> (Conty Estevez &amp;
          Kulla 2018): a binary tree over the emissive triangles whose every node caches its total{' '}
          <strong>power</strong>, its <strong>bounding box</strong>, and a <strong>cone of its
          emitter normals</strong>. To pick a light for a point <code>p</code>, it walks the tree from
          the root, at each step choosing the child in proportion to a conservative estimate of how
          much that cluster could light <code>p</code> —{' '}
          <code>importance = power · orientation / distance²</code> — so near, bright, well-oriented
          clusters win and the shadow rays land where the light is. The product of the branch
          probabilities is the exact selection pdf, which the MIS weight reuses, so the estimator is{' '}
          <strong>unbiased</strong>: like everything in Lumen, it only reshapes the variance of NEE,
          never its mean, and converges to the very same image a uniform render does — it just gets
          there far faster. The <strong>Verify</strong> tab proves the pdf sums to 1, that every light
          keeps a positive probability (so none is ever missed), that the sampler matches the pdf, that
          it reduces to uniform when the lights are equal, and that on a many-lights scene it cuts the
          NEE variance by hundreds of times at equal mean. Try <em>Star Field</em> or{' '}
          <em>Lantern Hall</em> and toggle <strong>Many lights</strong>.
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
        <Card title="Spectral & daylight photons">
          The photon mapper is now <em>colour-</em> and <em>daylight-complete</em>. <strong>Spectral
          photons:</strong> the first time a photon strikes dispersive glass it commits a random hero
          wavelength and carries that colour's weight, so its onward refraction bends per-colour and the
          caustic it lays down is a <em>rainbow</em> — a prism's spectrum, but focused as a caustic the
          camera-side integrators can't sample. Because the per-wavelength weights average to white the
          total caustic energy is unchanged; the <strong>Verify</strong> tab proves a dispersive caustic
          carries the same energy as its achromatic twin while measurably spreading into colour.{' '}
          <strong>Environment photons:</strong> the sun is now a photon emitter too — photons leave a disc
          sized to the scene and rain in as a parallel beam — so daylight scenes get photon-mapped sun
          caustics and indirect light, not just the lamp-lit ones. Verify shows the sun-lit render matches
          the path tracer (the distant-light flux normalisation) and that the sun focuses a real caustic
          through glass. Try <em>Spectral Caustic</em> and <em>Daylight Lens</em> on <strong>Photon
          Map</strong>.
        </Card>
        <Card title="Microfacet BSDFs">
          Surfaces are Lambertian diffuse, GGX/Trowbridge-Reitz metal with height-correlated Smith
          shadowing, or dielectric glass — smooth or <em>frosted</em>, the latter refracting through a
          microfacet interface. Rough lobes use <em>visible-normal (VNDF)</em> sampling for low variance.
        </Card>
        <Card title="Energy-conserving rough metal">
          A single-scatter GGX lobe silently drops the light that would have bounced{' '}
          <em>multiple times</em> between microfacets, so rough metals darken unphysically — a rough
          gold sphere goes grey. Lumen adds a <strong>Kulla–Conty</strong> multiple-scattering
          compensation lobe driven by the GGX <em>directional albedo</em> <code>E(μ,α)</code>, which is
          Monte-Carlo–integrated once into a table at start-up. The compensation exactly restores the
          missing energy <code>(1−E(μₒ))</code>, with a coloured multiscatter Fresnel{' '}
          <code>F_ms</code> so saturated metals stay saturated as they roughen. The <strong>Verify</strong>{' '}
          tab proves a white rough conductor reflects ≈1 with compensation and measurably less without.
          See it in <em>Rough Conductors</em>: the back row dims, the compensated front row stays bright.
        </Card>
        <Card title="Anisotropic (brushed) metal">
          Milled, brushed and spun metals have microscopic grooves running one way, stretching the
          highlight into a streak. Lumen's GGX lobe takes two roughness axes{' '}
          <code>(αₓ,α_y)</code> in a tangent frame you can rotate, so the VNDF sampler, the BRDF and its
          pdf all become anisotropic — reciprocity and energy still hold exactly (proven in{' '}
          <strong>Verify</strong>). <em>Brushed Metal</em> rakes the streak across a row of spheres.
        </Card>
        <Card title="Real metals (complex IOR)">
          A real conductor's colour is not an RGB tint — it is a <em>spectral</em> reflectance set by
          its complex refractive index <code>n̄(λ) = η(λ) − i·k(λ)</code>. Lumen carries measured{' '}
          <code>η/k</code> spectra (Johnson &amp; Christy for gold/silver/copper, Rakić for aluminium)
          and evaluates the <strong>exact unpolarised conductor Fresnel</strong> at the path's hero
          wavelength, so a metal's hue emerges spectrally — the same machinery that fans glass into a
          rainbow. That is why gold rims warm, copper reads red, silver stays bright-neutral and
          aluminium leans faintly blue, with the correct desaturation toward the horizon that
          Schlick-from-RGB can never capture. The Fresnel rides on every lobe — anisotropic and
          Kulla–Conty multiscatter included. <strong>Verify</strong> proves <code>R∈[0,1]</code>, the{' '}
          <code>k→0</code> reduction to the dielectric Fresnel, the textbook metal colours, and that a
          rendered gold sphere reconstructs its measured RGB. See <em>Metals of the World</em>.
        </Card>
        <Card title="Subsurface scattering">
          Marble, jade, wax, milk and skin are <em>translucent</em>: light refracts into the solid,
          random-walks among microscopic scatterers, and re-emerges somewhere else — the soft inner glow
          a surface shader can never fake. Lumen lets a dielectric carry an <strong>interior scattering
          medium</strong> (<code>σ_t</code>, a per-channel single-scattering albedo, and Henyey–Greenstein{' '}
          <code>g</code>); while a path is <em>inside</em> the object the integrator free-flights between
          collisions, scatters off the phase function and multiplies throughput by the albedo (so the
          absorbed fraction grows with depth — the per-channel albedo <em>is</em> the colour of the
          translucency), and at the boundary refracts out through the dielectric's Fresnel interface or is{' '}
          <strong>total-internally-reflected</strong> back in. It reuses the volume free-flight, phase
          function and dielectric BSDF verbatim. <strong>Verify</strong> proves a pure-scattering object
          is invisible in a white furnace for <em>any</em> g, a pure-absorbing one reproduces Beer's law,
          the whole object (boundary + TIR + scattering) conserves energy, and a coloured albedo tints the
          glow. See <em>Subsurface Studio</em> and <em>Jade Idol</em> — and raise <strong>Max Depth</strong>{' '}
          for a creamier, deeper-penetrating look.
        </Card>
        <Card title="Spectral subsurface — a chromatic mean free path">
          The reason a hand held to a torch glows deep red is not that red is absorbed <em>less</em>{' '}
          per bounce — it is that red light simply <em>travels further</em> inside skin before it is
          absorbed at all. That is a <strong>chromatic mean free path</strong>: in real flesh, marble
          and milk the extinction <code>σ_t</code> itself depends on wavelength (red low, blue high),
          so red reaches the thin edges and blue scatters back out near the surface. Lumen 15.0 renders
          it by reusing the <strong>hero-wavelength</strong> trick that disperses glass and colours
          metals: a path that refracts into a spectral interior commits to one wavelength λ, takes its
          RGB weight once (<code>E_λ[w]=(1,1,1)</code>, so the estimator stays unbiased), then
          random-walks <em>monochromatically</em> with <code>σ_t(λ)</code> and the single-scattering
          albedo <code>ϖ(λ)</code> — and the colour reconstructs over many paths' wavelengths. The
          media are not hand-tuned: <em>Apothecary</em> and <em>Living Skin</em> use the{' '}
          <strong>measured BSSRDF</strong> coefficients of Jensen et al. 2001 (marble, skin, whole/skim
          milk, ketchup, cream, apple), converted from their reduced <code>σ_s′</code>/<code>σ_a</code>{' '}
          to a per-wavelength extinction. <strong>Verify</strong> proves the chromatic furnace still
          conserves energy for <em>any</em> spectral <code>σ_t</code>, that a pure-absorbing slab
          reconstructs the spectral Beer integral <code>∫w(λ)e^(−σ(λ)·2r)dλ</code> (with R&gt;G&gt;B), and
          that an achromatic medium collapses exactly onto the scalar walk.
        </Card>
        <Card title="Oren–Nayar rough diffuse">
          Real matte surfaces — clay, chalk, the moon, unfinished plaster — are not Lambertian: their
          microscopic roughness makes them <em>flatten</em> and back-scatter toward the light, so a full
          moon is a flat disc, not a shaded ball. Lumen models this with the reciprocal{' '}
          <strong>Oren–Nayar</strong> microfacet-diffuse BRDF (roughness σ), reducing to Lambert at σ=0.
          The matte spheres in <em>Ceramics &amp; Clay</em> show the chalky, shadowless look.
        </Card>
        <Card title="Clear-coat (layered) materials">
          Glazed ceramic, lacquer and car paint are a <em>clear dielectric coat over a coloured base</em>:
          a sharp Fresnel gloss floats over the pigment, and the light that enters the coat is attenuated
          on the way in and out so the stack still conserves energy. Lumen layers a GGX dielectric coat
          over a (Lambert or Oren–Nayar) base, sampling the two lobes by their Fresnel weight with a
          combined pdf — so it stays MIS-consistent and matches BDPT pixel-for-pixel (proven). Try the
          glossy row in <em>Ceramics &amp; Clay</em>.
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
        <Card title="Heterogeneous media (clouds &amp; smoke)">
          Real clouds, smoke and ground fog have a density that <em>varies continuously</em> through
          space, and you cannot invert the free-flight law{' '}
          <code>e&minus;&int;&sigma;&nbsp;ds</code> when the extinction is arbitrary. The renderer
          drives a procedural 3D fBm density field with the <em>null-collision</em> estimators:{' '}
          <em>delta tracking</em> samples analytic flights against a constant majorant and accepts a
          real scatter with probability &sigma;(x)/&sigma;&#772;, so the collisions follow the
          heterogeneous law exactly with no bias; <em>ratio tracking</em> does the same for shadow-ray
          transmittance. The result is a cloud that self-shadows into soft greys, flares a silver
          lining toward the sun, and breaks light into real volumetric beams — all from one varying
          field. A medium can also <em>emit</em> light: at a real collision the path picks up{' '}
          <code>(1&minus;albedo)&middot;L<sub>e</sub></code> of self-radiance, and because collisions
          are density-proportional the glow pools in the dense core — a soft, physically integrated
          fireball rather than a billboard. Try the <em>Cumulus</em>, <em>Smoke Plume</em>,{' '}
          <em>Drifting Fog</em> and (glowing) <em>Ember</em> scenes.
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
