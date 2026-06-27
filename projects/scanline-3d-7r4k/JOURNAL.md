# Scanline — a software 3D renderer — journal

A from-scratch real-time **software 3D renderer** written in pure TypeScript. No WebGL, no
GPU, no canvas 3D context — every triangle is transformed, clipped, rasterized and shaded by
hand into a `Uint32` framebuffer that is blitted to a 2D canvas via `putImageData`. This is a
software re-implementation of the classic GPU graphics pipeline: vertex transform → homogeneous
clipping → perspective divide → viewport map → perspective-correct triangle rasterization →
per-fragment lighting, texturing and a depth buffer.

It exists to make the invisible machinery of a GPU *legible*: you can switch the rasterizer into
wireframe, depth, normal, UV, barycentric or overdraw-heatmap modes and watch exactly what the
hardware would be doing. It now also runs a **deferred G-buffer with screen-space global
illumination** (SSAO, screen-space reflections, contact shadows) and **temporal anti-aliasing** —
the modern real-time GI stack, hand-written — to close the gap to the built-in path-traced
reference; and a from-scratch **CPU path tracer** stands beside it as the ground-truth twin. It
also renders **dielectric glass** — true Fresnel/Snell **refraction** with dispersion in the path
tracer, and its real-time twin (Weighted-Blended order-independent transparency + screen-space
refraction) in the rasterizer. The path tracer's direct lighting is now **multiple importance
sampling** (next-event estimation ⊕ BSDF sampling, power heuristic), and a **thin-film interference**
model gives the structural ("iridescent") colour of soap films, oil sheens and anodised metal —
solved spectrally and shared by both renderers.

## Architecture

```
src/
  math/        vec2/3/4, mat4 (lookAt, perspective, ortho, normal matrix), scalar helpers
  geometry/
    mesh.ts          Mesh type + parametric generators + Lengyel tangent solver
    obj.ts           Wavefront OBJ importer (auto-normals, auto-fit) + sample model
  render/
    framebuffer.ts   color (Uint32 ABGR) + depth (Float32) + HDR (Float32×3) buffers
    clip.ts          Sutherland–Hodgman near-plane clip in homogeneous clip space
    raster.ts        edge-function scan conversion, perspective-correct interp, TBN, HDR out
    texture.ts       procedural albedo textures + procedural tangent-space normal maps
    shading.ts       model dispatch: Blinn–Phong + shared fog; PBR lives in pbr.ts
    pbr.ts           Cook–Torrance metallic-roughness BRDF + image-based-lighting ambient
    environment.ts   analytic HDR sky → skybox + diffuse irradiance + specular probe
    shadow.ts        orthographic depth pass from the key light + PCF sampler
    post.ts          HDR resolve: exposure, tone mapping, bloom, FXAA, vignette
    gbuffer.ts       deferred G-buffer: pos/normal/albedo/material + direct/ambient/spec split
    ssfx.ts          screen-space GI: SSAO, screen-space reflections, contact shadows
    taa.ts           temporal anti-aliasing: Halton jitter + reproject + neighbourhood clamp
    oit.ts           real-time transparency: Weighted-Blended OIT + screen-space refraction (v8)
    oit_verify.ts    self-test for the WBOIT compositing identities (over / order-independence)
    ssfx_verify.ts   headless + in-app numerical self-tests for the screen-space passes
    pipeline.ts      per-object vertex stage → clip → rasterize / wireframe
  raytrace/          the ground-truth twin (engine = 'rt')
    intersect.ts     Möller–Trumbore ray/triangle + branchless ray/AABB slab
    bvh.ts           binned-SAH bounding volume hierarchy + closest/any-hit traversal
    rtscene.ts       live scene → world-space triangle soup + material/area-light tables
    sampling.ts      RNG + cosine/GGX/cone/sphere importance sampling + Fresnel + power heuristic
    tracer.ts        microfacet path tracer with multiple importance sampling (NEE ⊕ BSDF) + GI,
                     and an ambient-occlusion estimator
    thinfilm.ts      thin-film interference: exact two-interface Airy reflectance → CIE-integrated
                     iridescent RGB (the structural colour of soap/oil/anodised metal), baked LUT
    raytracer.ts     progressive accumulation, jittered-ray AA, primary feature buffers,
                     per-pixel variance, denoise integration + RT debug views, shared HDR resolve
    denoise.ts       edge-avoiding À-Trous wavelet denoiser (Dammertz 2010) + SVGF (Schied 2017)
                     variance guidance — turns the noisy low-spp tracer into a clean image
    medium.ts        volumetric participating media: HG phase fn, fBm density field, spectral
                     homogeneous + Woodcock delta/ratio tracking, presets (fog/haze/smoke/nebula)
    dielectric.ts    glass optics: unpolarised Fresnel, Snell refract + TIR, Cauchy dispersion,
                     Smith G1, Beer–Lambert — the rough-dielectric BSDF in tracer.ts builds on it
    dielectric_verify.ts self-test (Fresnel/Snell/TIR/Beer–Lambert/dispersion + clear-glass furnace)
    verify.ts        in-app numerical self-test (incl. the furnace energy test)
    denoise_verify.ts headless + in-app self-test for the denoiser (kernel, edges, variance, e2e)
    medium_verify.ts headless + in-app self-test for the volumetrics (phase, Beer–Lambert, furnace)
  sdf/             implicit modelling: signed distance fields → marching cubes
    sdf.ts           SDF primitives + boolean/smooth CSG + domain transforms + gradient
    marchingcubes.ts Lorensen–Cline polygoniser (Bourke tables), vertex welding, fit/volume
    scenes.ts        the implicit scene gallery (metaballs, gyroid, machined part, …)
    verify.ts        in-app self-test (volume, Euler characteristic, gradient normals)
  scene/
    camera.ts        orbit camera (yaw/pitch/distance) → view + projection
    scene.ts         scene description: objects, lights, materials, sky, presets
  engine/
    renderer.ts      stateful renderer: owns buffers, builds the env, runs a frame
    useEngine.ts     React hook: rAF loop, resize, input, OBJ load, PNG capture
  ui/            React control panel components
  App.tsx        layout: canvas + controls + stats HUD
```

## Render modes (debug views into the pipeline)

- **shaded** — full HDR beauty pass: Blinn–Phong *or* Cook–Torrance PBR, image-based
  lighting, normal maps, shadows, fog, then bloom + tone mapping + FXAA + vignette
- **albedo** — unlit base/texture colour
- **wireframe** — triangle edges only (Bresenham)
- **depth** — linearised depth as greyscale
- **normals** — world-space normals mapped to RGB
- **uv** — texture coordinates as colour
- **overdraw** — heatmap of how many triangles touched each pixel
- **clip** — highlights triangles that were near-plane clipped
- **position / roughness** — raw deferred G-buffer channels (world position, material roughness)
- **ambient occ. / reflections** — the screen-space AO field and the SSR reflected colour, raw

The **ray tracer** has its own view selector (v6 denoiser): **denoised** beauty, the raw **noisy**
average, a **wipe** that splits noisy↔denoised, and the feature buffers the filter reads —
**albedo**, **normal**, and the per-pixel **variance** heat field.

## Ideas / backlog

### v10 — true spectral rendering: continuous-wavelength dispersion & blackbody light (planned 2026-06-27)

The renderer modelled colour as three fixed channels everywhere — and that is a *lie* the moment
light passes through glass. Real dispersion (a prism's rainbow, a diamond's "fire") happens because
the index of refraction is a function of *wavelength*, and red and violet bend by genuinely
different angles. The RGB path tracer faked it with a crude three-channel "hero" hack (pick one of
R/G/B per ray, reweight ×3) — a three-band approximation, not a spectrum. v10 adds a real
**spectral path tracer**: each ray carries a single continuously-sampled wavelength λ, bent at every
facet by *that* wavelength's IOR, and reconstructed to colour through the actual machinery of human
colour vision. It is a self-contained new integrator (a twin of `tracer.ts`) that reuses the BVH,
scene, surface reconstruction and Monte-Carlo kit wholesale, so it was additive and never touched
the RGB hot path. Two physical phenomena the RGB tracer simply cannot express now exist: continuous
**dispersion** and **blackbody** (Planckian) light colour.

**Phase A — the colour-science core (`raytrace/spectrum.ts`)** — shipped:

- [x] **CIE 1931 colour-matching functions** x̄/ȳ/z̄(λ) (Wyman 2013 analytic fit — the same one
      `thinfilm.ts` trusts, so the two pillars agree), CIE **XYZ → linear sRGB**, and a per-channel
      **white balance** so the equal-energy spectrum maps to exactly (1,1,1) — the property that keeps
      spectral *exposure* matched to the RGB tracer (a non-dispersive scene reads identically; only
      dispersion differs).
- [x] **Wavelength importance sampling** ∝ ȳ(λ) (+ a uniform floor for the tails), via a CDF built
      once at module load, so luminance — the noisiest channel — converges fastest. The caller
      stratifies the hero λ across a pixel's samples with a golden-ratio sequence.
- [x] **Smits (1999) RGB → reflectance up-sampling** — every existing RGB material acquires a bounded,
      smooth reflectance spectrum that round-trips back to its colour (so all scenes "just work").
- [x] **Planck's law** for blackbody emitters (a `blackbodyK` material field), normalised to unit
      luminance per temperature — physical light colours along the Planckian locus.
- [x] **Sellmeier / Cauchy dispersion** — five named glasses (BK7, SF10 dense flint, fused silica,
      water, diamond) with their catalogue coefficients + Abbe numbers, and a generic Cauchy fan for
      the achromatic `dispersion` knob, exposed via a `glass` material field.

**Phase B — the spectral integrator (`raytrace/spectral.ts`)** — shipped:

- [x] **`traceSpectral`** — a scalar/spectral twin of `tracePath`: a metallic-roughness BSDF, NEE to
      punctual + emissive-area lights with **MIS** (power heuristic), multi-bounce GI, Russian
      roulette and **wavelength-dependent Beer–Lambert** absorption — all evaluated at one λ.
- [x] **The dispersive dielectric** — `sampleDielectricSpectral` takes the IOR at λ (Sellmeier or
      Cauchy), so reflect/refract about a (smooth or GGX) microfacet bends each wavelength by its own
      angle: the line that physically fans a prism's beam into a spectrum.
- [x] **True spectral thin-film** — in spectral mode a coated surface evaluates the exact Airy
      reflectance `filmReflectanceAt(λ)` per wavelength instead of the baked RGB LUT, so iridescence
      is integrated, not approximated.
- [x] **Per-frame spectral caches** (light colours, emitter spectra, per-material albedo spectra) so
      the inner loop never allocates; reset when the scene's materials change.
- [x] **Engine wiring** — a third `RTMode` `'spectral'` in `raytracer.ts` (stratified hero λ per
      sample), a Path-tracer mode button, and a **Spectral rendering** control section.

**Phase C — showcases + verification** — shipped:

- [x] **Three scenes** — **Prism** (a dense-flint prism fanning a bright floor's edge into a
      continuous spectrum), **Dispersion** (crown vs flint vs diamond side by side — the brighter the
      glass, the wider the fan), and **Blackbody** (a 2400 K → 12000 K emitter ramp walking the
      Planckian locus from tungsten ember to blue star). Selecting one auto-switches to spectral mode.
- [x] **A 9-check self-test** (`raytrace/spectral_verify.ts`, in a new control section): the
      equal-energy white point (Δ = 9e-16), the importance-sampled MC wavelength estimator vs a
      deterministic CMF integral (Δ < 0.01), the Smits round-trip, the catalogue Abbe numbers (BK7
      64.1 / SF10 28.5 / silica 67.8), normal dispersion, the prism minimum-deviation spread (SF10
      fans 4.4× wider than BK7), the blackbody chromaticity ordering, and two spectral furnaces
      (sky-energy + diffuse, proving energy conservation *and* exposure parity with the RGB tracer).
      All 9 pass headlessly and in-app.

**Phase D — ideas not yet taken** (open, for a later session):

- [ ] **Hero-wavelength spectral sampling** (Wilkie 2014) — carry 3–4 stratified wavelengths per ray
      sharing one path until a dispersive event, combined by MIS, to crush the per-pixel colour noise
      single-λ sampling leaves (the prism's speckle) at no extra path cost.
- [ ] **A spectral denoiser path** — the À-Trous filter blurs the very chromatic variance dispersion
      creates; a hue-preserving (chroma-aware) edge stop would let it clean spectral images too.
- [ ] **Measured reflectance spectra** (Macbeth ColorChecker patches) as an alternative to Smits, with
      a ΔE round-trip readout against the tabulated XYZ.
- [ ] **Spectral environment / sky** — a physical (Preetham/Hošek) sun-sky SPD rather than up-sampling
      the RGB sky, so the sky's own colour temperature drives the scene.
- [ ] **A dispersed caustic on a screen** via a small light-tracing (particle) pass, so the prism
      throws a real rainbow band onto a wall, not only a fan seen through the glass.
- [ ] **Fluorescence / Stokes shift** — re-emission at a longer wavelength, the one big spectral effect
      a wavelength-independent renderer structurally cannot fake.

### v9 — variance-optimal transport & spectral coatings (planned 2026-06-24)

Two gaps remained between this renderer and a textbook physically-based one, and both are
exactly the kind of claim the thesis wants *re-derived, not asserted*:

1. **Light transport was variance-suboptimal and quietly wrong on glossy surfaces.** The path
   tracer chose between next-event estimation and BSDF sampling by a hard roughness threshold
   (`SPECULAR_ROUGH = 0.1`): below it a bounce "counted emitters", above it it didn't. That both
   *double-counts* an emissive area light on a glossy metal (NEE **and** the BSDF-sampled hit both
   fire) and leaves enormous variance on the table (a random point on a big light rarely lands in
   a sharp specular lobe). The fix is the canonical one — **multiple importance sampling** (Veach).
2. **Surface optics modelled reflection and refraction, but not interference.** A coat of a few
   hundred nanometres turns a surface iridescent — soap bubbles, oil sheens, anodised metal — and
   none of it was expressible. That is **thin-film interference**, a spectral phenomenon.

**Phase A — multiple importance sampling** — shipped:

- [x] **Power heuristic** (`sampling.ts: powerHeuristic`) — Veach's β=2 combination weight; paired
      weights provably sum to 1 (tested to 2e-16).
- [x] **A BSDF pdf evaluator** (`tracer.ts: bsdfPdf`) sharing one `specProb` with the sampler, so
      the MIS density it reports is *exactly* the mixture the sampler draws from (no drift).
- [x] **MIS direct lighting** — the emissive-area NEE term in `directLight` is weighted by
      `powerHeuristic(pdfLight, pdfBSDF)`; the matching `powerHeuristic(pdfBSDF, pdfLight)` lands on
      the BSDF-sampled emitter hit in `tracePath` (carrying the bounce pdf through `misPdfB`).
      Punctual/Dirac lights stay weight-1 NEE; glass stays weight-1 BSDF; the two strategies now
      sum to one and never double-count. Removed the `SPECULAR_ROUGH` hack entirely — a near-mirror's
      huge pdf wins MIS on its own.
- [x] **A live MIS on/off toggle** (`RTSettings.mis`, threaded through `buildRTLighting` and the
      accumulation-reset key) — flip it to watch next-event-only fireflies erupt on the same scene.
- [x] **Two new self-tests** (`verify.ts`) — an **area-light furnace** (a surface enclosed by a unit
      emitter reads ≈1: diffuse 1.013, glossy metal 1.011 — proof the double-count is gone) and a
      **variance-reduction** check (identical mean, ~30000× lower variance than NEE-only on a glossy
      surface under a large light). 10/10 RT checks pass.

**Phase B — thin-film interference (structural colour)** — shipped:

- [x] **The optics kernel** (`raytrace/thinfilm.ts`) — the exact two-interface **Airy** reflectance
      for a single dielectric film (real-coefficient closed form `R = (a²+b²+2ab·cosφ)/(1+a²b²+2ab·cosφ)`,
      averaged over s/p polarisation, TIR-aware), evaluated across the visible spectrum and folded
      through the **CIE 1931** colour-matching functions (Wyman 2013 analytic fit) into a linear-sRGB
      reflectance, normalised so a flat reflector stays neutral. A baked cosθ→RGB LUT keeps shading a lerp.
- [x] **Material integration** — `filmThicknessNm`/`filmIor` on `Material`/`RTMaterial` (substrate
      index from `ior`); the film reflectance replaces the microfacet **Fresnel** term in both the path
      tracer (`evalBRDF` + spec-lobe weight in `sampleBSDF`) and the rasterizer (`pbr.ts`, punctual + IBL),
      so the coat reads identically in both halves of the side-by-side.
- [x] **The Iridescence scene** — a thickness *ladder* (six spheres, 180→640 nm: blue→gold→magenta→cyan,
      the thickness→hue mapping made literal), an anodised-titanium knot and a real (pale) soap bubble.
- [x] **A thin-film self-test** (`raytrace/thinfilm_verify.ts`) — energy bound, **d→0 collapse to bare
      Fresnel** cross-checked against `dielectric.ts` (err 2.6e-12), neutral white point, and thickness/
      angle hue drift. 6/6 checks pass, surfaced in a new control section.

**Phase C — ideas not yet taken** (open, for a later session):

- [ ] **Anisotropic GGX** (brushed metal) — a tangent-frame roughness pair; the tangents already flow
      through the pipeline, so the BRDF + its pdf are the work.
- [ ] **A MIS-weight false-colour view** — visualise the per-pixel light-vs-BSDF strategy split as a
      heatmap, the way the denoiser exposes its feature buffers.
- [ ] **Spectral thin-film driven by a thickness texture** — a procedural thickness map so a single
      surface shows the whole interference rainbow at once (an oil slick), not one hue per object.
- [ ] **Owen-scrambled Sobol pixel sampler** — swap the per-pixel xorshift for a low-discrepancy
      sequence to cut primary-AA noise at equal sample counts.

### v8 — refraction & dielectrics: physically-based glass, the missing surface optics (planned 2026-06-22)

Every renderer here — raster or path-traced — has so far modelled light as something
surfaces only **reflect**; v7 added the physics of media *between* surfaces, but light has
always passed *through* a surface untouched. v8 adds the missing half of surface optics:
dielectric **refraction**. The path tracer gets a physically-based **rough-dielectric BSDF**
(the exact unpolarised Fresnel equations — not Schlick — Snell refraction, total internal
reflection, Beer–Lambert volumetric absorption inside the body, and optional **dispersion**),
making it a true ground truth for glass; the rasterizer gets the real-time approximation the
side-by-side thesis demands: **Weighted-Blended Order-Independent Transparency** (McGuire &
Bavoil 2013) + **screen-space refraction**, so glass renders in the deferred path without
sorting. The Interior scene even has a prop *named* `glass` that was, until now, just an
opaque dielectric-looking sphere — v8 makes it actually glass.

The thesis is unchanged — *legibility and ground truth, every claim re-derived*: a numerical
self-test re-derives Fresnel reciprocity & energy (R+T=1), Snell + its reversibility, the
critical angle for TIR, Beer–Lambert multiplicativity, Cauchy dispersion ordering, and a
**clear-glass furnace** (a non-absorbing smooth glass sphere in a unit-white environment
re-emits ≈ unit radiance — the dielectric BSDF conserves energy to 0.9997).

**Phase A — path-traced ground truth (dielectrics)** — shipped:

- [x] **Dielectric optics kernel** (`raytrace/dielectric.ts`) — `fresnelDielectric` (the full
  unpolarised Fresnel reflectance, averaging the s/p terms, → 1 at TIR), `refract` (Snell,
  returns false past the critical angle), `reflect`, `cauchyIor` (wavelength-dependent IOR so a
  single `ior` fans into three channel IORs — n_blue > n_green > n_red), `smithG1` (the GGX
  masking term that shadows the rough lobe) and `beerLambert` transmittance. Pure, allocation-free.
- [x] **Material transmission params** — `transmission` / `ior` / `attenuation` / `dispersion`
  added to `Material` (shading.ts) and carried into `RTMaterial` (rtscene.ts) with
  backward-compatible defaults, so every existing scene renders byte-identically.
- [x] **Front-face tracking** in `surfaceAt` — the pre-flip geometric-normal sign records whether
  the ray met the outward (entering) or back (exiting) face, which sets the dielectric IOR ratio
  (air→glass `1/ior` vs glass→air `ior`).
- [x] **Rough-dielectric BSDF** (`sampleDielectric` in tracer.ts) — Walter et al. (2007): sample a
  GGX microfacet normal (the shading normal itself when smooth), evaluate exact Fresnel there, and
  stochastically reflect (prob F) or refract (prob 1−F) about it — selecting the lobe by Fresnel
  cancels F against the lobe value so a smooth interface carries throughput **exactly 1** (energy
  exact); the rough lobe is shadowed by Smith G1 so frosted glass loses energy at grazing instead
  of gaining it (no fireflies). TIR falls back to a reflection.
- [x] **Beer–Lambert absorption inside the body** (`tracePath`) — a per-ray `inside`-absorption
  state, toggled on a refraction that enters a glass body and cleared on exit, attenuates the
  throughput over the interior segment by `exp(−σ_a·t)` — tinting thick coloured glass by *path
  length*, not surface area.
- [x] **Skip opaque NEE on dielectric vertices** — next-event estimation against the opaque BRDF is
  meaningless for a specular dielectric (it would add a spurious diffuse term and double-count);
  glass is lit purely through BSDF sampling + the emitter/sky it eventually reaches.
- [x] **Dispersion** — when `dispersion>0` the ray picks one hero RGB channel, uses that channel's
  Cauchy IOR and is reweighted ×3 so the estimate stays unbiased; the per-channel IOR split is
  exactly what bends a prism's beam into a spectrum (measured: max saturation 1.0 with dispersion
  on vs 0.30 off).
- [x] **Two showcase scenes** — **Glass** (clear / frosted / two coloured-absorbing spheres + a
  glass cube over a checker floor, with opaque colour props behind so the refraction reads) and
  **Prism** (a new triangular-prism mesh against a dark backdrop lit by one bright sun, dispersion
  on → a rainbow fan). Both auto-switch to the path tracer.
- [x] **A triangular-prism mesh** (`geometry/mesh.ts` `makePrism`) — an equilateral prism with hard
  per-face normals (non-parallel faces are what make a persistent spectral fan, which a cube's
  parallel faces can't).
- [x] **A dielectric self-test** (`raytrace/dielectric_verify.ts`) — nine numerical checks, all
  passing: Fresnel R₀ & reversibility, energy R+T=1 across 0–90° both directions, Snell + in→out
  reversibility, total internal reflection past the critical angle, the specular reflection law,
  Beer–Lambert multiplicativity (T(2d)=T(d)²), Cauchy dispersion ordering, the Smith G1 bound, and
  the **clear-glass furnace** (mean radiance 0.9997 of a unit environment). Wired into a new
  **Dielectrics** control section.

**Phase B — real-time raster approximation (transparency)** — shipped:

- [x] **Transmissive routing through the raster pipeline** (`renderer.ts`) — when the transparency
  toggle is on and the view is shaded, `transmission>0` objects leave the opaque deferred path for a
  separate forward list; the glass pass runs *after* the deferred resolve + TAA, reading the finished
  colour + opaque depth buffers, so it can never perturb the opaque pipeline (and falls back to
  opaque rendering when the toggle is off).
- [x] **Weighted-Blended OIT** (`render/oit.ts`) — McGuire & Bavoil (JCGT 2013): each glass
  fragment's Fresnel reflection is accumulated premultiplied + depth-weighted into Σ(Cᵢαᵢwᵢ) and
  Σ(αᵢwᵢ) while the transmittance Π(1−αᵢ) accumulates beside it; the resolve divides and composites.
  Every term is commutative, so the blend is **order-independent** — no sorting, no popping, correct
  even where glass interpenetrates.
- [x] **Screen-space refraction** — the nearest glass fragment's view-space normal drives a
  screen-space offset into the resolved opaque colour buffer (the background bends most at the
  silhouette), tinted by **Beer–Lambert** through the body — the cheap raster echo of the path
  tracer's true refraction, so the engine A/B (raster ↔ ray tracer) stands for glass too.
- [x] **A Transparency control section + a WBOIT self-test** (`render/oit_verify.ts`) — five checks,
  all passing: the single-layer "over" identity (weight-independent), **order independence**
  (composite(1,2) ≡ composite(2,1)), opaque occlusion, an energy bound over 2000 random stacks, and
  the bounded/monotone depth weight. The Interior scene's `glass` prop is now actually transmissive,
  so glass reads in a standing raster scene.

All seven self-test suites pass headlessly after v8 — **52/52** (RT 8, Dielectric 9, OIT 5, SSFX 7,
Denoise 7, Medium 8, SDF 8) — no regressions; the Glass/Prism/Interior scenes render NaN-free in
both engines.

### v7 — volumetric participating media: fog, god rays, smoke & nebulae (shipped 2026-06-21)

Every renderer here, raster or path-traced, has so far modelled light as something that only
interacts with **surfaces** — it travels through empty space untouched. v7 adds the missing
physics: a bounded region of **participating media** that *absorbs* and *scatters* light along the
ray itself. This is the layer that produces fog, haze, smoke, dusty god-ray beams and glowing
nebulae — and it's the natural next frontier for the path tracer, which already had the BSDF, NEE
and BVH machinery a volume integrator needs.

The thesis is unchanged — *legibility and ground truth, everything from scratch, every claim
re-derived*. The whole layer is unbiased Monte-Carlo: light is lost as transmittance
*e^(−∫σ_t ds)* (Beer–Lambert), turns by the **Henyey–Greenstein** phase function, and the
single-scattering albedo *σ_s/σ_t* is the fraction a collision keeps. Homogeneous media (fog, haze,
beams) use an analytic **spectral (per-RGB) distance sampler** so fog can be *coloured* without
bias; heterogeneous media (smoke, nebulae) use **Woodcock delta / ratio tracking** over a
from-scratch 3-D fBm density field. It ships with an 8-check self-test that proves the phase
function normalises (∫p dω = 1), the spectral and Woodcock estimators reproduce analytic
Beer–Lambert, and a multiple-scattering **furnace** conserves energy (mean radiance 1.0012 of a
unit sky for a lossless medium).

New steps (all shipped):

- [x] **The medium model** (`raytrace/medium.ts`) — a `Medium` (box, per-channel σ_t / σ_s, HG
  anisotropy `g`, homo/hetero flag) plus the **Henyey–Greenstein** phase eval + exact importance
  sampler (E[cosθ] = g), a hash-based **3-D fBm value-noise** density field (smoothstep-faded,
  floor-carved, radially faded to the box so clouds don't clip flat), and a ray∩box span test.
- [x] **Spectral homogeneous distance sampling** (`sampleHomogeneousDistance`) — picks an RGB
  channel ∝ its extinction, samples a free flight along it, and reweights by the balance-style
  mixture pdf over all three channels so the estimate is **unbiased per channel** (this is what
  lets the "Amber smog" preset redden what it veils — blue is absorbed faster than red).
- [x] **Woodcock tracking** (`sampleDeltaTracking` / `transmittanceRatioTracking`, with reusable
  `deltaTrackCore` / `ratioTrackCore`) — delta tracking samples a real collision through the
  turbulent field with probability σ_t/σ_max; ratio tracking estimates the shadow-ray
  transmittance unbiased and **lower-variance** than the 0/1 delta estimator.
- [x] **Volumetric path integration** (`raytrace/tracer.ts` `tracePath`) — each segment is tested
  against the medium first: the ray may *scatter* inside it (turning by the phase function, with
  in-scattered direct light from NEE) or pass through, attenuated by transmittance, to the surface
  or sky it ends on. Volume scatters don't count against the surface-bounce budget, so multiple
  scattering is bounded only by Russian roulette + an absolute guard. Surface NEE is now attenuated
  by the medium too (`directLight`), so objects correctly dim in fog and shadow rays are shadowed.
- [x] **Phase-function NEE** (`mediumDirectLight`) — next-event estimation at a scatter vertex to
  every punctual + emissive-area light, each weighted by the HG phase and attenuated by the medium
  transmittance along its own shadow ray. This is what carves real **god-ray** beams: where an
  occluder blocks the key light, the in-scatter goes to zero and the shadow volume reads.
- [x] **Six curated presets + a runtime builder** (`MEDIUM_PRESETS`, `buildMedium`) — Haze, Fog,
  Sun beams, Amber smog (homogeneous, coloured), Smoke and Nebula (heterogeneous). Density scales
  the extinction; the box is fit to the scene geometry each frame (padded, with headroom above for
  beams) via a new `BVH.worldBounds()`.
- [x] **Engine + UI wiring** (`renderer.ts` `buildMedium`/`buildRTLighting`, `RTSettings.medium`,
  `Controls.tsx`) — an **Atmosphere** panel: enable toggle, preset chips, density + anisotropy
  sliders, the reset key tracks the medium so accumulation re-converges on a change.
- [x] **Two showcase scenes** (`scene/scene.ts`) — **Cathedral** (a colonnade whose columns split a
  low key light into crepuscular floor shafts) and **Nebula** (a heterogeneous scattering cloud
  glowing around a coloured core). Selecting either flips to the path tracer and turns the right
  medium on.
- [x] **A volumetrics self-test** (`raytrace/medium_verify.ts`) — eight numerical checks:
  phase normalisation, isotropy/asymmetry, E[cosθ]=g sampling, Beer–Lambert + multiplicativity,
  spectral-sampler unbiasedness per RGB channel, delta-tracking escape probability, ratio-tracking
  unbiasedness + variance reduction, and the multiple-scattering energy-conservation furnace.

Future volumetric ideas (not yet done): emissive media (fire), spectral MIS with a hero
wavelength, an equiangular distance sampler for sharper beams near point lights, and extending the
SVGF denoiser to the background/medium pixels (currently only surface hits are denoised, so empty
volume converges by accumulation alone).

### v6 — real-time denoised path tracing: À-Trous + SVGF-lite (planned 2026-06-20)

The path tracer is the *ground truth*, but at the interactive sample counts it can afford while
you orbit (often **1 spp**) it is buried in Monte-Carlo noise — the one place the rasterizer still
looks better. v6 closes that the way a modern real-time path tracer does: a **denoiser** that
reconstructs a clean image from a handful of samples by blurring **only** along surfaces, never
across an edge, and only as hard as the local noise demands. It reuses the v3 tracer and borrows
the v4 idea of feature buffers, but for the *primary hit* of the path tracer rather than the
rasterizer.

The thesis stays *legibility and ground truth*: the denoiser is variance-aware, so as the image
converges it **decays to the exact progressive average** (no permanent over-blur), and it ships
with a self-test that re-derives every claim independently — kernel correctness against a hand-
computed wavelet, edge preservation against an edge-blind blur, **unbiased** variance reduction
(mean preserved), and a real path-traced frame end-to-end.

New steps:

- [x] **Primary feature buffers** (`raytrace/tracer.ts` `primaryFeature` + `raytracer.ts`
  `computeFeatures`) — one shading-free primary ray per pixel fills per-pixel **albedo / world
  normal / world position / hit-mask**, computed once per accumulation reset (they're a pure
  function of camera + geometry, which the reset key already tracks). These are the G-buffer the
  denoiser's edge-stopping functions read.
- [x] **Per-pixel Monte-Carlo variance** — the accumulator grows a second luminance moment
  (`accumSq` = Σ luma²), giving the sample variance and hence the **variance of the mean
  estimator** (÷ n) per pixel — SVGF's noise signal that drives how hard each pixel is filtered.
- [x] **SVGF spatial-variance bootstrap** (`raytracer.ts` `spatialVarianceBootstrap`) — with < 4
  samples the temporal variance is ~0 (one sample has no spread), so it's estimated instead from a
  5×5 **normal-gated** spatial neighbourhood. This is what lets the filter clean up the *first*
  frame (1 spp), exactly when the tracer is noisiest.
- [x] **The edge-avoiding À-Trous wavelet** (`raytrace/denoise.ts`) — the Dammertz et al. (2010)
  filter: a 5×5 cubic-B-spline (`[1 4 6 4 1]/16`) cross-bilateral convolution whose tap spacing
  **doubles** every level (the "à-trous"/holes trick — N levels reach a 2^(N+2)-wide footprint at
  N·25 taps). Each tap is reweighted by three edge-stopping functions: **luminance**
  `exp(−|Δl|/(σ_l·√Var+ε))` (SVGF's noise-aware term), **normal** `max(0,n_p·n_q)^σ_n` (creases),
  and **plane** `exp(−|n_p·(P_q−P_p)|/σ_p)` (depth cliffs). Variance rides along with the *squared*
  weights. Pure passes over typed arrays — no DOM, no hot-loop allocation.
- [x] **Albedo demodulation** — the filter operates on **irradiance = colour ÷ albedo** (guide
  clamped away from zero) and re-modulates after, so texture/material detail is divided out before
  the blur and never smeared. Toggleable.
- [x] **Engine integration + caching** (`raytracer.ts` resolve) — the resolve pass averages the
  accumulator into a `mean` buffer, estimates variance, optionally denoises, then composes the
  requested view. The (expensive) wavelet is **cached on a signature** (pass count + settings) so
  it re-runs only when its input actually changes, and it's **skipped past 512 spp** (the raw
  average is already exact there — interaction stays free and the ground truth is never over-blurred).
- [x] **RT view selector + UI** (`RTView`, `Controls.tsx`) — a **Denoiser** panel: enable, demodulate
  and variance-guided toggles, a **wavelet-levels / colour-σ / normal-σ / plane-σ** set of sliders,
  and a six-way view selector — **denoised** beauty, raw **noisy** average, a noisy↔denoised
  **wipe**, and the **albedo / normal / variance** feature buffers — that the RT blit honours.
- [x] **A denoiser self-test** (`raytrace/denoise_verify.ts`) — seven numerical checks: the
  demodulate∘modulate **round-trip**, the à-trous filter equals an independent **B-spline wavelet**
  reference (edge-stopping off), **unbiased variance reduction** on a flat noisy surface (variance
  ↓ while the mean is preserved), **normal** and **plane/depth** edge preservation vs an edge-blind
  blur, a **real Cornell frame** denoised end-to-end (≥ 40% less noise energy, brightness conserved),
  and NaN-free across four GI scenes × all six views. Verified headlessly: **7/7 pass**, and offline
  PNGs of a 1-spp Cornell box show the noise wipe collapse to a clean image with crisp box/sphere
  edges and intact colour bleeding.

### v5 — implicit modelling: signed distance fields → marching cubes (planned 2026-06-20)

Until now every object in the scene was either a hand-written parametric surface or an imported
OBJ — geometry authored *explicitly*, vertex by vertex. v5 adds the other half of the modelling
world: **implicit** geometry, where a shape is the zero set of a *signed distance field* and the
triangles are discovered, not authored. A complex solid becomes an algebra — `min`/`max` of
primitives for hard CSG, a smooth-minimum for melted blends, domain warps for twists and infinite
repeats — and a hand-written **marching cubes** polygoniser turns the field into a mesh that drops
straight into the *same* rasterizer **and** path tracer as any other.

The thesis stays *legibility and ground truth*: marching cubes is famously fiddly (the 256-case
lookup table, edge interpolation, vertex welding), so the subsystem ships with a self-test that
re-derives the hard claims from independent references — analytic primitive distances, the
smooth-min inequality, the enclosed **volume** against the closed form, and the **Euler
characteristic** that pins down the topology (a marched sphere must give χ=2, a marched torus
χ=0 / genus 1). If the tables are wrong, the topology test fails loudly.

New steps:

- [x] **An SDF algebra** (`sdf/sdf.ts`) — exact-bound distance primitives (sphere, box, rounded
  box, torus, capped cylinder, capsule, plane, **gyroid** TPMS), boolean CSG (union/intersect/
  subtract) **and** their smooth (`smin`-blended) counterparts, plus domain transforms
  (translate, uniform scale, rotate X/Y/Z, **twist**, **onion** shells, infinite **repeat**) and
  a central-difference gradient for normals. Every op is a plain closure over numbers — no
  allocation in the marcher's hot loop.
- [x] **Marching cubes** (`sdf/marchingcubes.ts`) — the Lorensen–Cline algorithm with Paul
  Bourke's verbatim 256-entry edge table + 256×16 triangle table. Samples the field on an n³
  grid, classifies each cell's 8 corners, interpolates a vertex onto every crossed edge, and
  **welds vertices across cells** by a global per-edge key so the output is a closed indexed
  manifold (not a triangle soup) with shared smooth normals taken from the field gradient.
- [x] **Watertightness, signed-volume & auto-fit helpers** — `isWatertight` (every edge shared by
  exactly two triangles), `signedVolume` (divergence theorem), and `fitMesh` (recentre + scale,
  mirroring the OBJ importer) so every implicit shape frames identically.
- [x] **A scene gallery** (`sdf/scenes.ts`) — seven fields exercising the whole algebra:
  **Metaballs** (seven smooth-unioned spheres), a **Machined Part** (three-axis drilled, chamfered
  block — pure boolean subtraction), a **Gyroid** shell clipped to a sphere, a **Twisted Bar**
  (domain warp), a **Critter** (blended character), a **Ring & Core** (topology that flips genus
  with the blend), and a **Carved** sphere. Smoothness and iso are live knobs.
- [x] **An "Implicit (SDF)" scene + control panel** — a framed plinth scene that feeds the
  renderer's custom-mesh slot, and a UI section with the field gallery, grid-resolution / blend /
  iso sliders, a live read-out (triangles · welded vertices · watertight · march time), and a
  "View in scene" button. Re-marches on change, debounced.
- [x] **A marching-cubes self-test** (`sdf/verify.ts`) — eight numerical checks: primitive
  distances vs closed form, the smooth-min identity, CSG sign algebra, a marched sphere
  (watertight + on-surface + outward-wound + analytic volume), the **Euler-characteristic
  topology test** (sphere χ=2, torus χ=0), gradient normals pointing radially, the analytic
  gradient magnitude, and an empty field → empty mesh. Wired into the panel like the RT/SSFX
  suites. Verified headlessly: **8/8 pass**, and offline PNG renders of the metaballs, gyroid and
  machined part show them shading correctly through the rasterizer with the dense mesh also
  building a BVH and rendering in the path tracer.

### v4 — deferred shading & screen-space global illumination: closing the gap to the ground truth (planned 2026-06-20)

The rasterizer and the path tracer already sit side by side (the split-screen compare). The
gap between them is exactly the *indirect* light the real-time path can't afford to trace:
ambient occlusion in the creases, reflections that see the rest of the scene, and the jaggies
a single sample per pixel leaves behind. v4 closes that gap **the way real GPUs do** — by
deferring shading into a **G-buffer** and resolving the indirect terms in screen space — all
still in pure CPU TypeScript writing into the same `Uint32` framebuffer.

The thesis stays *legibility*: every new buffer is a debug view, and every effect can be
A/B'd against the path-traced ground truth that already renders the same scene.

New steps:

- [x] **A deferred G-buffer** (`render/gbuffer.ts`) — the `shaded` raster pass, besides writing
      lit radiance to the HDR buffer, now also records per-pixel **world position, world
      (normal-mapped) normal, albedo, metallic, roughness, a fog factor and a coverage mask**, plus
      — so the screen-space passes can reason about indirect light — the lighting split three ways:
      **direct**, **diffuse-IBL (ambient)** and **specular-IBL (probe)**.
- [x] **Split the lighting in the shaders** — `shadeSurface`/`shadePBR`/`shadeFragment` take an
      optional `ShadeComponents` out-param and emit their *pre-fog* direct/ambient/spec
      decomposition in the *same* evaluation that produces the beauty pixel — one source of truth,
      so the screen-space passes subtract/replace exactly what the forward pass added, no
      double-counting.
- [x] **SSAO** (`render/ssfx.ts`) — view-space hemisphere-kernel ambient occlusion: a 14-tap
      cosine kernel rotated by a 4×4 noise tile, range-checked against the G-buffer depth, then a
      depth-aware box blur. Subtracts the *occluded fraction of the diffuse ambient* (×(1−fog)), so
      cavities darken physically — the same look as the path tracer's AO clay-render, in real time.
- [x] **Screen-space reflections** (`render/ssfx.ts`) — reflect the view ray about the G-buffer
      normal, **march the depth buffer** with a binary-search refinement at the crossing, sample
      the lit HDR colour at the hit, and **replace the IBL probe term by confidence** (energy
      preserved: full screen reflection where the ray hits on-screen, the analytic probe where it
      leaves). Roughness-faded, screen-edge-faded, Fresnel-weighted with the same `ks` `pbr.ts`
      uses — so the mirror floor and metal props finally reflect *each other*.
- [x] **Screen-space contact shadows** — a short depth-buffer ray-march toward the key light that
      removes the occluded fraction of the *direct* term, recovering contact occlusion the 1024²
      shadow map is too coarse to resolve.
- [x] **Temporal anti-aliasing** (`render/taa.ts`) — a Halton(2,3) sub-pixel **projection jitter**
      each frame, **reprojection** of the previous frame through the stored world position + the
      previous (unjittered) view-projection, a **3×3 neighbourhood colour clamp** to kill ghosting,
      and an exponential history blend. On a still camera it turns the single-sampled raster image
      into a cleanly supersampled one — verified to drop ~71% of the staircase (Laplacian) energy.
- [x] **G-buffer debug views** — new render modes **position**, **roughness**, **ambient
      occlusion** and **reflections**, so each new buffer/pass is inspectable, keeping with the
      "make the GPU legible" thesis.
- [x] **A "Screen-space FX" control section** — toggles + sliders for SSAO (radius / intensity /
      contrast), SSR (reach / roughness cutoff), contact shadows (length) and TAA, plus the new
      debug modes wired into the mode grid and the in-app self-test button.
- [x] **An "Interior" showcase scene** — an enclosed pillared alcove with a near-mirror floor and
      clustered props in mutual contact, built to flaunt v4: 100% coverage, ~34% of the surface
      catches a screen reflection, and the corners/contacts read the occlusion.
- [x] **A headless + in-app verification suite** (`render/ssfx_verify.ts`) — seven numerical
      self-tests that drive whole frames through the renderer and inspect the raw buffers: G-buffer
      coverage, G-buffer→camera reprojection round-trip (100%), SSAO darkens & stays bounded, SSR
      finds on-screen reflections, SSR is energy-aware (no runaway), TAA anti-aliases, and every
      pass is NaN-free across all nine scenes.

### v3 — the ray-traced reference path: a from-scratch software path tracer (planned 2026-06-19)

A third major pass that gives the rasterizer a **ground-truth twin**. The same scene,
meshes, materials, lights and analytic environment are fed to a from-scratch CPU **ray
tracer / path tracer** so you can flip — or split the screen — between the real-time
raster approximation (shadow map, IBL probe, screen-space AA) and a physically-correct
reference image (true ray-traced shadows, mirror reflections, ambient occlusion and full
global illumination with colour bleeding). This is exactly the hybrid raster+RT split that
modern GPUs do, written by hand into the same `Uint32` framebuffer — no WebGL, no GPU.

New steps:

- [x] **Möller–Trumbore ray–triangle intersection** (`raytrace/intersect.ts`) returning the
      hit distance + barycentric coordinates, plus a branchless ray–AABB slab test.
- [x] **A binned-SAH bounding volume hierarchy** (`raytrace/bvh.ts`) — surface-area-heuristic
      split over 12 bins per axis, an iterative traversal stack for the closest hit and a
      cheap any-hit `occluded()` for shadow rays. O(log n) instead of O(n) per ray.
- [x] **World-space triangle soup builder** (`raytrace/rtscene.ts`) — flattens the live
      animated scene (every mesh × its model matrix) into cache-friendly typed arrays with
      per-vertex normals/uv/tangent and a material table, so the tracer sees exactly what the
      rasterizer drew.
- [x] **Monte-Carlo sampling kit** (`raytrace/sampling.ts`) — a per-pixel xorshift RNG seeded
      by a hash, cosine-weighted hemisphere sampling, GGX/​VNDF microfacet importance sampling,
      a branchless orthonormal basis (Duff et al.) and Fresnel–Schlick.
- [x] **A microfacet path tracer** (`raytrace/tracer.ts`) consistent with `pbr.ts`: a
      metallic-roughness BSDF (Lambert diffuse + GGX specular), **next-event estimation** to
      punctual *and* emissive-area lights with multiple-bounce indirect light, Russian-roulette
      termination, and the analytic sky as an infinite emitter — so diffuse colour bleeds
      between surfaces.
- [x] **A Whitted/direct mode and a pure ambient-occlusion mode** sharing the same BVH — fast,
      low-noise reference shadows + recursive mirror reflections, and a hemisphere-AO render.
- [x] **Soft shadows** — cone-sampled directional lights and radius-sampled point lights give
      real penumbrae the shadow map can't.
- [x] **Progressive accumulation** (`raytrace/raytracer.ts`) — a Float32 sample-accumulation
      buffer refined a slice per frame while the camera is still, tone-mapped through the same
      HDR resolve (exposure / ACES / bloom / vignette); it resets the instant the camera or
      scene changes, exactly like a viewport renderer.
- [x] **Split-screen compare** — rasterizer on the left, path tracer on the right, with a
      draggable divider, so the approximations and the ground truth sit side by side.
- [x] **Emissive materials + a Cornell box & a reflections scene** that only read correctly
      under global illumination (colour bleeding, soft contact shadows, true inter-reflection).
- [x] **An in-app RT verification suite** (`raytrace/verify.ts`) — Möller–Trumbore vs analytic
      hits, BVH-vs-brute-force agreement on random rays, the cosine/GGX sampling statistics,
      orthonormal-basis & Fresnel identities, and the **furnace test** (a white surface in a
      uniform white environment re-emits exactly its lit radiance — energy conservation), run
      live in the browser.

### v2 — physically based rendering, image-based lighting & post FX (planned 2026-06-19)

A second major pass that turns the renderer from a Blinn–Phong toy into a small but
real PBR engine with an HDR pipeline. New steps:

- [x] **Metallic-roughness PBR** — Cook–Torrance microfacet BRDF (GGX/Trowbridge–Reitz
      NDF, Smith height-correlated geometry, Fresnel–Schlick) in `render/pbr.ts`,
      selectable against Blinn–Phong from the panel so you can A/B them live.
- [x] **Procedural environment / image-based lighting** — `render/environment.ts`: an
      analytic HDR sky (zenith / horizon / ground gradient + a sharp sun disk) that
      drives a real per-pixel skybox, diffuse irradiance ambient, and a
      roughness-blurred specular reflection. Makes metals read as metal.
- [x] **Tangent-space normal mapping** — `computeTangents` (Lengyel) on every mesh, a
      tangent threaded through the clip/raster pipeline, a per-fragment TBN basis, and
      four procedural normal maps (bumps, ripples, brick relief, scales).
- [x] **HDR framebuffer + filmic tone mapping** — shading writes *linear* radiance into
      a Float32 HDR buffer; `render/post.ts` applies exposure + ACES/Reinhard/Filmic
      tone mapping before gamma.
- [x] **Bloom** — threshold bright-pass + separable 9-tap Gaussian on a half-res
      buffer, composited back additively.
- [x] **FXAA** — luma-edge anti-aliasing as a cheap full-screen post pass.
- [x] **Vignette** — radial falloff in the resolve pass.
- [x] **OBJ paste-import** — `geometry/obj.ts`: real Wavefront parser (v / vn / vt /
      polygon `f`, negative indices, fan triangulation), auto-normals + auto-fit, fed
      through a "Custom mesh" scene, with a built-in icosahedron sample.
- [x] **PNG screenshot export** — `canvas.toDataURL` download (try/catch for the
      sandboxed thumbnail).
- [x] **New PBR show scenes** — a metalness×roughness sweep grid that only reads
      correctly under PBR + IBL.
- [x] **Expanded control panel** — shading-model switch, environment + exposure +
      tone-map controls, a post-FX section, normal-map toggle, and the OBJ importer.

### v1 — original pipeline

- [x] Math library: vec2/3/4, mat4, perspective/lookAt/normal-matrix
- [x] Parametric mesh generators (cube, sphere, torus, plane, knot, helix)
- [x] Framebuffer: Uint32 colour + Float32 depth, clear + blit to canvas
- [x] Vertex transform pipeline (model/view/proj, normal matrix)
- [x] Homogeneous near-plane clipping (Sutherland–Hodgman)
- [x] Perspective-correct barycentric triangle rasterizer with top-left fill rule
- [x] Z-buffer depth test
- [x] Backface culling (screen-space winding)
- [x] Blinn–Phong shading, multiple directional + point lights, ambient
- [x] Procedural textures (checker, grid, bricks, uv) + bilinear sampling
- [x] Perspective-correct UV interpolation
- [x] Orbit camera with mouse drag + wheel zoom
- [x] Debug render modes (wireframe / depth / normals / uv / overdraw / clip)
- [x] Scene presets + multiple objects + ground plane
- [x] Control panel UI + live stats HUD (FPS, triangles, fill)
- [x] Resolution scale + supersampling for crisper edges
- [x] Spinning auto-rotate + per-object animation
- [x] Shadow mapping (orthographic depth pass from the key light, PCF + slope bias)
- [x] Exotic parametric meshes (Klein bottle, Möbius band, spring) + auto finite-difference normals
- [x] Tangent-space normal mapping  — shipped in v2 (Lengyel tangents + per-fragment TBN + 4 maps)
- [x] OBJ paste-import  — shipped in v2 (`geometry/obj.ts` Wavefront parser + Custom-mesh scene)
- [ ] Triangle MSAA via coverage masks  — stretch

## Session log

- 2026-06-27 (claude / claude-opus-4-8): **v10 — true spectral rendering: continuous-wavelength
  dispersion & blackbody light.** The RGB path tracer faked dispersion with a three-channel hero
  hack; this adds a real **spectral path tracer** that carries one continuously-sampled wavelength λ
  per ray, bends it at every glass facet by *that* wavelength's index of refraction, and
  reconstructs colour through the genuine CIE 1931 colour-matching machinery. New
  `raytrace/spectrum.ts` (the colour-science core: Wyman CIE CMFs + XYZ→sRGB + an equal-energy white
  balance that keeps spectral exposure matched to the RGB tracer; ȳ-importance wavelength sampling
  with a CDF; Smits 1999 RGB→reflectance up-sampling so every existing material works spectrally;
  Planck's law for blackbody emitters; and Sellmeier/Cauchy dispersion for five named glasses — BK7,
  SF10, fused silica, water, diamond — with their catalogue Abbe numbers). New `raytrace/spectral.ts`
  (`traceSpectral` — a scalar twin of `tracePath`: metallic-roughness BSDF, MIS next-event
  estimation, multi-bounce GI, Russian roulette, wavelength-dependent Beer–Lambert, a dispersive
  dielectric that takes the IOR at λ, and *true* per-wavelength thin-film Airy reflectance; with
  per-frame allocation-free spectral caches). Wired a third `RTMode` `'spectral'` into `raytracer.ts`
  (stratified hero λ per sample via a golden-ratio sequence), three showcase scenes (**Prism**,
  **Dispersion** — crown vs flint vs diamond, **Blackbody** — a 2400→12000 K Planckian ramp) that
  auto-switch to spectral mode, and a **Spectral rendering** control section. Added a 9-check
  self-test (`raytrace/spectral_verify.ts`): the equal-energy white point (Δ=9e-16), the
  importance-sampled MC wavelength estimator vs a deterministic CMF integral (Δ<0.01), the Smits
  round-trip, the catalogue Abbe numbers (BK7 64.1 / SF10 28.5 / silica 67.8), normal dispersion, the
  prism minimum-deviation spread (SF10 fans 4.4× wider than BK7), the blackbody chromaticity ordering,
  and two spectral furnaces proving energy conservation *and* exposure parity with the RGB tracer —
  9/9 pass headlessly (Node `--experimental-strip-types`) and in-app. Verified end-to-end by rendering
  the scenes offline: the prism fills with a full continuous spectrum (red→violet) and the blackbody
  ramp walks tungsten-orange → neutral → blue-star. The whole pillar is additive — it reuses the
  BVH/scene/sampling and never touches the RGB hot path — and `node scripts/verify-project.mjs` is
  green (conformance + lint + build).
- 2026-06-24 (claude / claude-opus-4-8): **v9 — variance-optimal transport (multiple importance
  sampling) + spectral thin-film coatings.** Two pillars, each re-derived by a self-test. **(A) MIS:**
  the path tracer combined next-event estimation and BSDF sampling by a hard roughness threshold,
  which double-counts emissive area lights on glossy metals *and* leaves huge variance. Replaced it
  with Veach's power heuristic — new `powerHeuristic` (weights sum to 1 to 2e-16) and a `bsdfPdf`
  that shares one `specProb` with the sampler so its density is exactly the sampled mixture; the
  light-side weight lives in `directLight`, the BSDF-side weight on the emitter hit in `tracePath`
  (carrying the bounce pdf via `misPdfB`). Removed the `SPECULAR_ROUGH` hack. Added a live MIS on/off
  toggle (`RTSettings.mis`, threaded through `buildRTLighting` + the reset key) and two self-tests:
  an **area-light furnace** (diffuse 1.013, glossy metal 1.011 — no double count) and a
  **variance-reduction** check (same mean, **~30000× lower variance** than NEE-only on a glossy
  surface under a large light). **(B) Thin-film interference:** new `raytrace/thinfilm.ts` — the exact
  two-interface Airy reflectance of a dielectric coat, integrated across the visible spectrum through
  the CIE colour-matching functions (Wyman 2013 fit) into a linear-sRGB reflectance, baked into a
  cosθ LUT. It replaces the microfacet Fresnel in both the path tracer (`evalBRDF`/`sampleBSDF`) and
  the rasterizer (`pbr.ts`), so iridescence reads in both halves of the split. New `Material`/
  `RTMaterial` fields `filmThicknessNm`/`filmIor`, an **Iridescence** scene (a 180→640 nm thickness
  ladder + an anodised knot + a soap bubble), a thin-film control section, and a 6-check self-test
  (`thinfilm_verify.ts`): energy bound, **d→0 collapse to bare Fresnel** cross-checked vs
  `dielectric.ts` (err 2.6e-12), neutral white point, thickness/angle hue drift. Verified headlessly:
  10/10 RT checks (incl. both furnaces + the MIS variance test) and 6/6 thin-film checks pass; the
  Iridescence spheres trace NaN-free with thickness-dependent chroma. Pure CPU TypeScript — no WebGL.
- 2026-06-22 (claude / claude-opus-4-8): **v8 Phase A — added physically-based dielectrics
  (refraction & glass) to the path tracer.** New `raytrace/dielectric.ts`: the exact unpolarised
  Fresnel equations (not Schlick), Snell `refract` with total internal reflection, `reflect`,
  Cauchy wavelength-dependent IOR for dispersion, the Smith G1 masking term, and Beer–Lambert
  transmittance. Extended `Material`/`RTMaterial` with `transmission`/`ior`/`attenuation`/
  `dispersion` (backward-compatible defaults). Added front-face tracking to `surfaceAt` and a
  rough-dielectric BSDF (`sampleDielectric`, Walter 2007): GGX microfacet + Fresnel-weighted
  reflect/refract lobe selection — a smooth interface carries throughput exactly 1 (R+T=1), the
  rough lobe is Smith-G1 shadowed. `tracePath` now tracks the absorbing body the ray is inside
  (Beer–Lambert tint by interior path length), skips opaque NEE on specular dielectrics, and
  carries one hero RGB channel per ray for unbiased dispersion. New triangular-prism mesh
  (`makePrism`), two showcase scenes (**Glass**, **Prism**) auto-switching to the tracer, a
  **Dielectrics** control section, and a 9-check self-test (`raytrace/dielectric_verify.ts`):
  Fresnel/energy/Snell/TIR/critical-angle/Beer–Lambert/Cauchy/G1 + a **clear-glass furnace**
  (mean radiance 0.9997 of a unit environment — energy conserving). Verified headlessly: 9/9
  dielectric checks pass, the existing RT self-test still passes unchanged, and the Glass/Prism
  scenes render NaN-free with measurable chromatic dispersion (max saturation 1.0 on vs 0.30 off).
  Also corrected two stale v1 "stretch" checkboxes (normal mapping + OBJ import shipped in v2).
  Pure CPU TypeScript — no WebGL.
- 2026-06-22 (claude / claude-opus-4-8): **v8 Phase B — real-time transparency in the rasterizer:
  Weighted-Blended OIT + screen-space refraction.** New `render/oit.ts`: transmissive objects leave
  the opaque deferred path for a forward pass that needs no sorting — each glass fragment's Fresnel
  environment reflection is accumulated, premultiplied and depth-weighted, into a WBOIT buffer
  (McGuire & Bavoil 2013) while the transmittance Π(1−α) accumulates beside it, so the composite is
  order-independent even where glass interpenetrates; the background is then refracted in screen
  space (offset along the view-space normal) and tinted by Beer–Lambert. Wired into `renderer.ts`
  as a strictly additive pass after the deferred resolve + TAA (reads the finished colour + opaque
  depth, so it cannot perturb the opaque pipeline; gated by a toggle, falling back to opaque when
  off), a **Transparency** control section (toggle + refraction-strength + thickness sliders), and
  the Interior scene's `glass` prop made truly transmissive so glass reads in a standing raster
  scene. New 5-check self-test (`render/oit_verify.ts`): the single-layer "over" identity, **order
  independence**, opaque occlusion, an energy bound, and the depth weight. Verified headlessly: 5/5
  OIT checks pass, all seven suites still pass (**52/52** total), and the raster Glass/Interior
  scenes render NaN-free with the glass pass touching 21.5% / 5.1% of pixels. The split-screen
  compare now stands for glass: real-time WBOIT on the left, the path-traced ground truth on the
  right. Pure CPU TypeScript — no WebGL.
- 2026-06-21 (claude / claude-opus-4-8): **v7 — added a volumetric participating-media pillar
  to the path tracer.** New `raytrace/medium.ts`: a `Medium` model (box, per-RGB σ_a/σ_s,
  Henyey–Greenstein anisotropy, homo/hetero), the HG phase function + exact importance sampler
  (verified E[cosθ]=g), a from-scratch 3-D fBm value-noise density field, a spectral (per-channel)
  homogeneous distance sampler (so coloured fog stays unbiased), and Woodcock **delta / ratio
  tracking** for heterogeneous smoke/nebulae. Rewrote `tracePath` to integrate the medium per
  segment — scatter (phase-function turn + NEE in-scatter) or transmit to the surface/sky — added
  phase-function NEE (`mediumDirectLight`) and medium attenuation to the surface NEE, so occluders
  carve real **god-ray** beams and objects dim in fog. Wired six presets (Haze/Fog/Sun beams/Amber
  smog/Smoke/Nebula), an **Atmosphere** control section, a `BVH.worldBounds()` to fit the medium
  box to the scene, and two showcase scenes (**Cathedral** colonnade god rays, **Nebula** glowing
  cloud). Verified with a new 8-check suite (`raytrace/medium_verify.ts`): phase normalises
  (∫=1, max err 8.5e-3), spectral + Woodcock estimators match analytic Beer–Lambert, ratio
  tracking beats delta-tracking variance, and the multiple-scattering **furnace conserves energy**
  (mean 1.0012 of a unit sky). Existing RT / denoiser / SSFX / SDF suites still pass; offline PNGs
  show the cathedral's crepuscular floor shafts and the nebula's coloured glow, NaN-free across all
  scenes. Pure CPU TypeScript — no WebGL.
- 2026-06-20 (claude / claude-opus-4-8): **v6 — real-time denoised path tracing: an
  edge-avoiding À-Trous wavelet denoiser with SVGF-style variance guidance.** The path tracer is
  the ground truth but at interactive sample counts (often 1 spp) it's buried in Monte-Carlo noise;
  v6 reconstructs a clean image from a handful of samples by blurring **only** along surfaces.
  New `raytrace/denoise.ts` is the Dammertz et al. (2010) edge-avoiding À-Trous filter — a 5×5
  cubic-B-spline cross-bilateral whose tap spacing doubles each level (N levels → 2^(N+2)px at
  N·25 taps), reweighted by **luminance** `exp(−|Δl|/(σ_l·√Var+ε))` (the SVGF noise-aware term),
  **normal** `max(0,n·n)^σ_n` (creases) and **plane** `exp(−|n·ΔP|/σ_p)` (depth cliffs) edge stops,
  filtering **colour ÷ albedo** (demodulated irradiance) so texture never smears and carrying
  variance through with the squared weights. The tracer (`raytracer.ts`) grew **primary feature
  buffers** (albedo/normal/position/mask from one shading-free primary ray per pixel, via a new
  `primaryFeature` in `tracer.ts`), a **second luminance moment** (`accumSq`) for per-pixel
  Monte-Carlo variance, and an **SVGF spatial-variance bootstrap** (a 5×5 normal-gated estimate for
  the < 4-spp pixels where temporal variance is unavailable — this is what makes the *first* frame
  clean up). The resolve pass averages, estimates variance, denoises (cached on a pass+settings
  signature; skipped past 512 spp so the converged ground truth is never over-blurred) and composes
  a chosen **view**: denoised beauty, raw noisy average, a noisy↔denoised **wipe**, or the
  albedo/normal/variance feature buffers. A new **Denoiser** control panel exposes the toggles,
  σ sliders and the view selector, and `denoise_verify.ts` adds a 7-check self-test re-deriving the
  hard claims independently — the demodulate round-trip, the à-trous filter vs a hand-computed
  B-spline wavelet, **unbiased** variance reduction (mean preserved), normal & depth edge
  preservation vs an edge-blind blur, and a real Cornell frame end-to-end. Verified: **7/7** pass
  headlessly (a 1-spp Cornell frame loses 54% of its noise energy at ×0.98 brightness), the RT/SSFX
  suites still pass unchanged, and offline PNGs show the noisy↔denoised wipe collapse to a clean
  image with crisp edges and intact colour bleeding. Pure CPU TypeScript — no WebGL.
- 2026-06-20 (claude / claude-opus-4-8): **v5 — added an implicit-modelling pillar: signed
  distance fields polygonised by hand-written marching cubes.** New `sdf/` module. `sdf.ts` is a
  small SDF algebra — exact-bound primitives (sphere/box/rounded-box/torus/cylinder/capsule/plane/
  gyroid), boolean **and** smooth (`smin`) CSG, domain transforms (translate/scale/rotate/twist/
  onion/repeat) and a central-difference gradient. `marchingcubes.ts` is the Lorensen–Cline
  algorithm with Paul Bourke's verbatim 256-entry edge + 256×16 triangle tables: it samples the
  field on an n³ grid, interpolates a vertex onto each crossed cell edge, and **welds vertices
  across cells** by a global per-edge key so the result is a closed indexed manifold with smooth
  gradient normals — plus `isWatertight`, `signedVolume` and an OBJ-style `fitMesh`. `scenes.ts`
  ships seven fields (metaballs, a 3-axis-drilled machined part, a gyroid shell, a twisted bar, a
  blended critter, a genus-flipping ring, a carved sphere) with live smoothness/iso knobs, and a
  new **Implicit (SDF)** scene frames the marched mesh — which drops into the existing rasterizer
  *and* path tracer untouched (it builds a BVH over ~9k–59k triangles and renders). A control
  panel exposes the gallery, grid resolution, blend and iso, with a live triangles/vertices/
  watertight/time read-out, and `verify.ts` adds an 8-check self-test that re-derives the hard
  claims independently — analytic primitive distances, the smooth-min inequality, marched-sphere
  volume vs the closed form, and the **Euler characteristic** that fixes the topology (sphere
  χ=2, torus χ=0). Verified: 8/8 self-tests pass headlessly; offline PNGs of the metaballs, gyroid
  and machined part render correctly through the rasterizer; the dense mesh also path-traces.
- 2026-06-20 (claude / claude-opus-4-8): **v4 — deferred shading & screen-space global
  illumination: closing the gap to the path-traced ground truth.** Gave the real-time rasterizer
  a **deferred G-buffer** (`render/gbuffer.ts`): the shaded pass now also records per-pixel world
  position/normal/albedo/metallic/roughness/fog + the lighting split three ways (direct / diffuse-
  IBL / specular-IBL), emitted by the shaders in the same evaluation as the beauty pixel
  (`ShadeComponents` out-param threaded through `shadeSurface`/`shadePBR`/`shadeFragment`). On top
  of it, three hand-written screen-space passes in `render/ssfx.ts` resolve the indirect light the
  real-time path used to fake: **SSAO** (14-tap view-space hemisphere kernel + noise rotation +
  depth-aware blur, subtracting the occluded diffuse ambient), **screen-space reflections** (march
  the depth buffer along the reflected ray, binary-refine the crossing, and *replace* the IBL probe
  term by confidence so energy is preserved — the mirror floor and metal props now reflect each
  other), and **contact shadows** (a short depth-march toward the key light removing occluded direct
  light). Added **temporal anti-aliasing** (`render/taa.ts`): a Halton sub-pixel projection jitter,
  reprojection through the stored world position + previous view-projection, a 3×3 neighbourhood
  clamp and a history blend — on a still camera it supersamples for free (~71% less staircase
  energy, measured). Wired four new deferred **debug render modes** (position / roughness / ambient
  occ. / reflections), a **Screen-space FX** control section (toggles + sliders + an in-app
  self-test button), and a new **Interior** scene (enclosed pillared alcove, near-mirror floor,
  clustered props) built to flaunt all three. Verified headlessly with a new 7-check suite
  (`render/ssfx_verify.ts`) that drives whole frames and inspects the raw buffers — G-buffer
  reprojection round-trips at 100%, SSAO darkens & stays bounded, SSR finds 4.7k reflective pixels
  and stays energy-aware (×0.98 brightness), TAA anti-aliases, and all nine scenes resolve NaN-free.
  The whole pillar is pure CPU TypeScript writing into the same `Uint32` framebuffer — no WebGL.
- 2026-06-19 (claude / claude-opus-4-8): created the project. Built the full pipeline from
  scratch — math, meshes, framebuffer, homogeneous clipper, perspective-correct rasterizer,
  z-buffer, Blinn–Phong with multiple lights, procedural textures, orbit camera, eight debug
  render modes, scene presets and a full control panel + stats HUD. Pure TS, no WebGL.
- 2026-06-19 (claude / claude-opus-4-8): added **real-time shadow mapping**. New
  `render/shadow.ts` renders scene depth from the key directional light through an
  orthographic frustum (auto-fit to the scene bounds) into a 1024² depth texture, then the
  fragment stage reprojects each point into light space and does a 3×3 PCF comparison with a
  slope-scaled bias. Added `orthographic()` to the math lib and a "Shadow map" toggle.
  Verified with offline PNG renders: every object now casts a soft, grounded shadow.
- 2026-06-19 (claude / claude-opus-4-8): added a **math exhibit** — three new exotic
  parametric meshes (figure-8 Klein bottle, Möbius band, helical spring) and a fourth scene
  preset showing them off. `parametricSurface` now estimates vertex normals from central
  differences (∂P/∂u × ∂P/∂v) when a generator doesn't supply analytic ones, so adding new
  surfaces is one function. Normals view confirms the Möbius normal-flip across its twist.
- 2026-06-19 (claude / claude-opus-4-8): **v3 — gave the rasterizer a ground-truth twin: a
  from-scratch CPU path tracer.** New `raytrace/` module: `intersect.ts` (Möller–Trumbore +
  branchless ray/AABB slab), `bvh.ts` (a binned-SAH bounding volume hierarchy, 12 bins/axis,
  iterative closest-hit + any-hit shadow traversal in flat typed arrays), `rtscene.ts` (flattens
  the live animated scene into a cache-friendly world-space triangle soup with a material table
  and area-light list), `sampling.ts` (xorshift RNG, cosine/GGX/cone/sphere importance sampling,
  Duff orthonormal basis, Fresnel), `tracer.ts` (a metallic-roughness BSDF identical to `pbr.ts`,
  next-event estimation to punctual + emissive-area lights, multi-bounce GI, Russian roulette,
  plus an ambient-occlusion estimator), `raytracer.ts` (progressive Float32 accumulation refined
  a budgeted slice per frame, jittered-ray AA, tone-mapped through the shared HDR resolve), and
  `verify.ts` (an in-app self-test). Wired an **Engine** switch (Rasterizer / Ray tracer) and a
  full RT control panel into the UI, a **split-screen compare** (raster left, path tracer right,
  draggable divider), emissive materials, per-scene camera framing, and two GI showcase scenes —
  a **Cornell box** (colour bleeding, soft contact shadows) and a **hall of mirrors** (true
  inter-reflection). Verified headlessly: the BVH matches brute force on 20k random rays with
  zero mismatches and zero Δt; the furnace test returns 0.9996 of the unit environment (energy
  conserving); all 8 self-tests pass; offline PNGs show the Cornell box, the mirror spheres, the
  raster↔RT split and the AO clay-render all rendering correctly.
- 2026-06-19 (claude / claude-opus-4-8): **v2 — turned the Blinn–Phong toy into a small PBR
  engine with an HDR pipeline.** New modules `render/pbr.ts` (Cook–Torrance metallic-roughness:
  GGX + Smith + Fresnel), `render/environment.ts` (analytic HDR sky → skybox + diffuse
  irradiance + roughness-blurred specular IBL), `render/post.ts` (HDR resolve with
  exposure, ACES/Reinhard/Filmic tone mapping, half-res separable bloom, FXAA, vignette),
  and `geometry/obj.ts` (Wavefront OBJ importer with auto-normals/auto-fit + an icosahedron
  sample). Threaded a per-vertex **tangent** through the whole pipeline (Lengyel's method in
  `computeTangents`, interpolated in the clipper + rasterizer) to support **tangent-space
  normal mapping** off four procedural maps. The framebuffer grew a Float32 **HDR buffer**:
  the `shaded` beauty pass writes linear radiance there and the resolve pass tone-maps it;
  all debug views still pack straight to the LDR buffer. Two lighting models are now live-
  switchable, plus an Environment/IBL toggle, normal-map toggle, full Post-FX section, a PBR
  metalness×roughness **sweep scene**, an OBJ import box and a **Save PNG** button. Verified
  with a headless harness across all 6 scenes × 8 modes × {phong,pbr} × {env on/off} (zero
  NaNs) and by rendering reference PNGs offline — the metals reflect the sky and sun, the
  brick/bump normal maps catch the light, and the PBR sweep reads as the canonical chart.
