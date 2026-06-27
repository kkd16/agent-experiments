# Lumen — journal

The app's long-lived memory. Read this first when you pick it back up.

**Lumen** is a from-scratch, physically based **Monte-Carlo path tracer** that runs entirely on
the CPU (no WebGL/WebGPU) across a Web Worker pool, rendering into a `<canvas>` with progressive
accumulation. It solves the rendering equation with next-event estimation + multiple importance
sampling, GGX microfacet BSDFs, smooth **and frosted** dielectrics, **spectral dispersion**,
**subsurface scattering** (random-walk translucency for marble/jade/wax/skin, with a **chromatic
mean free path** as of 15.0 — per-wavelength extinction from measured BSSRDF data, so red light
penetrates skin further than blue),
**Beer–Lambert volumetric absorption**, **heterogeneous participating media** (procedural fBm
clouds, smoke & fog traced by **delta/ratio tracking**, with **chromatic extinction** as of 16.0 —
a per-wavelength σ_t so blue scatters out of a haze sooner than red, the reason the sky is blue), **procedural textures**, **adaptive
variance-guided sampling** with a live noise heatmap, a SAH BVH, ACES tone mapping, and an
edge-avoiding À-Trous denoiser. It carries **four interchangeable light-transport integrators** (a unidirectional path
tracer, bidirectional PT, primary-sample-space Metropolis, and stochastic progressive photon
mapping) that all provably converge to the same image — and as of 8.0 the photon mapper is
**spectral** (rainbow caustics through dispersive glass) and **daylight-complete** (the sun is a
photon emitter, so daylight scenes get photon-mapped sun caustics).

## Architecture

- `src/engine/vec3.ts` — vector algebra, ONB (Duff 2017), reflect/refract.
- `src/engine/rng.ts` — sfc32 RNG + splitmix32 seeding; cosine/disk/GGX samplers; power heuristic.
- `src/engine/ray.ts` — rays, AABB slab test, hit record.
- `src/engine/material.ts` — the **physically based material system**. Lambert / GGX metal (VNDF
  sampling, Smith G2) / smooth + rough dielectric (exact Fresnel, microfacet refraction) / emissive,
  plus (11.0) **real metals from measured complex IOR** (η(λ),k(λ) tables + exact conductor Fresnel
  at the hero wavelength, so gold/copper/silver get their physical spectral hue — see `conductor.ts`),
  plus (10.0) **energy-conserving rough metal** (Kulla–Conty multiscatter compensation off a
  start-up-built GGX directional-albedo table `E(μ,α)`/`Eavg(α)`), **anisotropic GGX** (two roughness
  axes in a rotatable tangent frame), **Oren–Nayar** rough-diffuse (`sigma`), and a **clear-coat**
  layer (`coat`: a GGX dielectric gloss over a Lambert/Oren–Nayar base). `sampleBSDF`/`evalBSDF`/
  `pdfBSDF` are kept in lockstep through shared local-frame helpers so every lobe is MIS-consistent;
  `resolveMaterial` bakes textures + dispersion at a vertex. **(12.0)** a dielectric may carry a
  `Subsurface { sigmaT, albedo, g }` `interior`, making it a **translucent solid** the integrator
  random-walks inside (marble/jade/wax/skin).
- `src/engine/texture.ts` — procedural world-space textures (checker / grid / value-noise marble).
- `src/engine/subsurface.ts` — **(15.0)** chromatic subsurface: `spectralAt` (RGB-as-3-point-spectrum
  upsampling at the R/G/B representative wavelengths) + the measured BSSRDF library (Jensen et al.
  2001) and `subsurfacePreset` that converts σ_s′/σ_a into a spectral `Subsurface` (per-wavelength
  extinction + single-scattering albedo) for the integrator's wavelength-resolved interior walk.
- `src/engine/spectrum.ts` — Cauchy dispersion IOR + white-point-normalised wavelength→RGB.
- `src/engine/blackbody.ts` — **(18.0)** physically based light colour: Planck's law `planck(λ,T)`,
  the CIE 1931 colour-matching functions (Wyman–Sloan–Shirley analytic fit) integrated against it,
  XYZ→linear-sRGB, and `blackbody(K)`/`blackbodyEmission(K,intensity)` giving the Planckian-locus hue.
- `src/engine/conductor.ts` — **(11.0)** measured complex refractive indices η(λ),k(λ) for six real
  metals (gold/silver/copper/aluminium/iron/chromium), the exact unpolarised conductor Fresnel, its
  hemispherical average (for Kulla–Conty), and a band-integrated RGB F0 (denoiser/BDPT fallback).
- `src/engine/primitive.ts` — sphere + triangle (Möller–Trumbore w/ barycentrics + smooth
  vertex normals), triangle area-light sampling, degenerate-thin AABB padding.
- `src/engine/spherelight.ts` — **(20.0)** next-event estimation for emissive **spheres** by the solid
  angle they subtend: uniform-cone sampling (`cosθ_max=√(1−R²/d²)`, pdf `1/Ω`), the MIS pdf
  `sphereDirPdf`, a closed-form near-hit distance, and the analytic sphere form factor (the proof oracle).
- `src/engine/mesh.ts` — indexed mesh generators (icosphere / uv-sphere / torus / surface of
  revolution), affine transforms (inverse-transpose normals), area-weighted normal recovery.
- `src/engine/obj.ts` — Wavefront OBJ parser (v/vn/f, polygon fans, auto-fit to a unit box).
- `src/engine/noise.ts` — dependency-free 3D value noise + fBm + domain warp (the density fields).
- `src/engine/volume.ts` — compiles a `DensityDef` into a `DensityField` (majorant + density(p)) for
  heterogeneous media; FBM clouds/smoke + exponential fog layers, bounded by the medium sphere.
- `src/engine/sky.ts` — Preetham analytic daylight (Perez distribution + zenith chromaticity).
- `src/engine/bvh.ts` — binned SAH build, stack traversal (nearest + any-hit).
- `src/engine/scene.ts` — scene assembly, intersection, NEE light sampler + MIS light pdf, env,
  and the participating-media estimators: analytic Beer–Lambert for homogeneous volumes, **delta
  tracking** (free-flight collisions) + **ratio tracking** (shadow transmittance) for heterogeneous.
- `src/engine/integrator.ts` — the path tracer: NEE + MIS (power heuristic) + Russian roulette,
  Beer–Lambert medium tracking, hero-wavelength spectral sampling, and **(12.0)** the **subsurface
  random walk** (a homogeneous interior free-flight + HG phase scatter bounded by the dielectric
  surface, entered/exited through its Fresnel interface).
- `src/engine/bdpt.ts` — bidirectional path tracer: camera×light subpath connections weighted by
  balance-heuristic MIS; exports `areaDensity`/`misPartitionResidual` for the proofs.
- `src/engine/pssmlt.ts` — Primary-Sample-Space Metropolis light transport: a `PssmltSampler`
  (an `Rng` subclass that returns coordinates of a mutatable random-number vector) lets the path
  tracer be reused *verbatim* as the contribution function; `MltState` runs the Markov chain
  (Kelemen lazy mutation, expected-value splatting, bootstrap brightness) and is driven by both the
  worker and the single-thread fallback.
- `src/engine/guiding.ts` — **(13.0)** Practical Path Guiding (Müller et al. 2017): the **SD-tree**.
  A `DTree` is a directional quadtree over the sphere (equal-area cylindrical map → constant
  Jacobian, so a flux-proportional tree is a radiance-proportional *solid-angle* sampler), with a
  *building* tree it records into and a *sampling* tree it draws from, refined+promoted each
  iteration by a flux threshold. A `Guide` is the spatial binary k-d tree whose leaves each carry a
  `DTree`; leaves subdivide by *visit* count (paths through the region, not just lit ones) so the
  spatial resolution tracks the scene, children inheriting a clone of the parent's learned
  distribution. The integrator (`integrate(..., guide)`) draws each scatter from the mixture
  `α·p_bsdf+(1−α)·p_guide` and trains the tree from each path's downstream radiance — provably
  unbiased (the density integrates to 1), gated by per-leaf maturity so under-trained regions keep
  to plain BSDF sampling.
- `src/engine/sppm.ts` — stochastic progressive photon mapping: an `SppmState` (same
  `FrameEstimator` shape as `MltState`) that, each pass, re-traces jittered camera rays to place a
  per-pixel measurement point, emits power-sampled photons from the area lights, deposits them into
  the measurement points via an exact `HashGrid` (CSR spatial hash), and shrinks each point's gather
  radius on the Hachisuka schedule so the density estimate converges. Built for caustics. As of 8.0
  its photons are **spectral** (commit a hero wavelength on the first dispersive hit → rainbow
  caustics) and the **sun is a photon source** (a disc, sized to the scene's bounding sphere,
  perpendicular to the sun → daylight caustics + GI), both unbiased and proven in the verify suite.
- `src/engine/tonemap.ts` — **AgX (18.0)** / ACES / filmic / Reinhard / linear + sRGB encode. AgX is
  the RGB-coupled Sobotka transform (inset→log₂→contrast sigmoid→outset) that desaturates highlights.
- `src/engine/denoise.ts` — À-Trous edge-avoiding wavelet filter, albedo/normal guided.
- `src/engine/scenes.ts` — Cornell box, Weekend daylight, Material gallery, **Brushed Metal**
  (anisotropic GGX), **Rough Conductors** (single-scatter vs Kulla–Conty multiscatter split),
  **Ceramics & Clay** (clear-coat gloss + Oren–Nayar matte), **Subsurface Studio** + **Jade Idol**
  (12.0 translucent marble/jade/wax/skin), Caustic room, Caustic Pool
  (rippled-water caustics), Prism (dispersion), Glass Menagerie (roughness + absorption), Textured
  Studio (procedural textures), Cathedral / Nebula (media), Iridescence (thin film), …
- `src/engine/envmap.ts` — **(21.0) image-based lighting.** A from-scratch `InfiniteAreaLight`: a
  `Distribution1D`/`Distribution2D` over an equirectangular HDRI's **luminance × sinθ**, sampled by a
  marginal-then-conditional inverse CDF, with `EnvMap.radiance/sample/pdf` exposing the panorama as both
  the escaped-ray radiance **and** an importance-sampled NEE light (exact solid-angle pdf for MIS). Ships
  three deterministic procedural panoramas (studio / sunset / twilight).
- `src/engine/selftest.ts` — invariant checks (furnace, BVH-vs-brute-force, pdf consistency…).
- `src/render/worker.ts` — one render worker owning a horizontal band.
- `src/render/renderer.ts` — worker-pool orchestrator + single-thread fallback + compositing.
- `src/App.tsx` + `src/ui/` — the studio UI (orbit camera, controls, stats, verify, about).

## Ideas / backlog

- [x] Vec / RNG / sampling core
- [x] GGX VNDF microfacet metal + smooth dielectric + Fresnel
- [x] SAH BVH (build + nearest + shadow traversal)
- [x] Path tracer with NEE + MIS + Russian roulette
- [x] Multi-threaded worker pool + progressive accumulation
- [x] Single-thread sandbox fallback (for the catalog thumbnail)
- [x] ACES tone mapping + exposure + operators
- [x] À-Trous albedo/normal-guided denoiser
- [x] Orbit camera, depth of field, 4 preset scenes
- [x] In-app verification suite + PNG export
- [x] Procedural textures — world-space checker / grid / marble (value-noise fBm) albedo
- [x] Rough (microfacet) dielectric — GGX VNDF reflect/refract for frosted glass
- [x] Beer–Lambert volumetric absorption — physically coloured thick glass
- [x] Spectral rendering / dispersion through glass — hero-wavelength Cauchy IOR, prism rainbows
- [x] Adaptive sampling guided by per-pixel variance + live noise (relative-error) heatmap
- [x] Three new scenes: Prism, Glass Menagerie, Textured Studio
- [x] Eight new correctness proofs in the verification suite for the above
- [x] Triangle meshes with smooth (barycentric-interpolated) vertex normals
- [x] Procedural mesh library — icosphere, UV-sphere, torus, surface-of-revolution
- [x] OBJ import (paste-in) with area-weighted normal recovery + auto-fit
- [x] Physically based **Preetham sky** (turbidity + sun position)
- [x] **Environment / sun next-event estimation** — the sky is now a sampled light (MIS)
- [x] **(21.0) Image-based lighting — equirectangular HDRI environments, importance sampled** — a
      from-scratch `Distribution2D` over luminance×sinθ (PBRT `InfiniteAreaLight`), MIS-consistent with
      BSDF sampling; three procedural panoramas (studio/sunset/twilight), live rotation + intensity; six
      new proofs (110 total). Every non-HDRI env stays bit-for-bit identical.
- [x] **Bidirectional path tracing (BDPT)** — full Veach/Guibas connections + balance-heuristic MIS
- [x] **A physically based material system (10.0)** — the surfaces made as rigorous as the transport:
  - [x] **Energy-conserving rough metal (Kulla–Conty multiscatter)** — a start-up-built GGX
        directional-albedo table `E(μ,α)` drives a compensation lobe that restores the energy the
        single-scatter lobe drops between microfacets, so rough conductors stop darkening; proven to
        reflect ≈1 in a white furnace with compensation and measurably less without
  - [x] **Anisotropic GGX (brushed metal)** — two roughness axes `(αₓ,α_y)` in a rotatable tangent
        frame; anisotropic D, Smith Λ and VNDF sampling; reciprocity + energy preserved exactly
  - [x] **Oren–Nayar rough diffuse** — reciprocal microfacet-diffuse BRDF (`sigma`) for chalk/clay/
        plaster, reducing to Lambert at σ=0
  - [x] **Clear-coat layered materials** — a GGX dielectric coat over a Lambert/Oren–Nayar base
        (`coat`), the two lobes sampled by Fresnel weight with a combined pdf so it stays energy-
        conserving *and* MIS-consistent (matches BDPT pixel-for-pixel)
  - [x] Three showcase scenes — **Brushed Metal**, **Rough Conductors**, **Ceramics & Clay**
  - [x] Six new correctness proofs (GGX albedo table, multiscatter energy, anisotropic reciprocity/
        streak, Oren–Nayar reciprocity/grazing, clear-coat reciprocity/gloss/energy) + a BDPT≡PT
        oracle over a box of all four new materials (55 proofs total)
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)
- [x] **Physically based image formation (22.0)** — a post-capture camera & film pipeline: a
      polygonal-aperture **bokeh** sampler (shaped circle of confusion), energy-conserving veiling-glare
      **bloom**, natural **cos⁴θ vignetting**, lateral **chromatic aberration**, and photographic **film
      grain**. All display-side stages leave light transport untouched (all-zero ⇒ bit-exact identity);
      the bokeh sampler is area-uniform so depth of field stays unbiased. Two scenes (**Neon Bokeh**,
      **Lumière Hall**) + eight proofs (118 total).
- [ ] **(22.0 follow-ups) Cat's-eye / optical vignetting** — truncate the entrance pupil toward the
      frame edge so off-axis bokeh deforms into the swirly cat's-eye shape of a real fast lens
- [ ] **(22.0 follow-ups) Lens flare & ghosts** — trace the bright-source reflections between glass
      elements (the aperture-shaped ghost chain) as an additive, energy-budgeted overlay
- [ ] **(22.0 follow-ups) Anamorphic bokeh + barrel/pincushion distortion** — a per-axis aperture
      stretch and a radial distortion polynomial in the camera ray generation
- [ ] **(22.0 follow-ups) Tilt-shift / Scheimpflug focal plane** — tilt the plane of focus for a
      wedge-of-focus look (a non-fronto-parallel focus distance)
- [ ] **(21.0 follow-ups) Load a real `.hdr`/`.exr` panorama** — Radiance RGBE / OpenEXR decode, drag-and-drop
- [ ] **Two-strategy env MIS** — also draw the BSDF lobe and weight both samples against the env importance pdf
- [ ] **Fold the env into the light tree** — a bright env region competes with triangle/sphere emitters in one unified selection
- [ ] **Prefiltered env mip-chain** — a fast diffuse/rough-gloss IBL path (irradiance + split-sum specular)
- [x] **Spectral/Fresnel-conductor reflectance (11.0)** — wavelength-dependent complex IOR (real gold's hue
      from η,k) layered onto the new multiscatter conductor. Measured η(λ)/k(λ) tables for gold, silver,
      copper, aluminium, iron & chromium; exact unpolarised conductor Fresnel evaluated at the path's
      committed hero wavelength (so a metal's hue emerges spectrally, like dispersion); rides on the
      single-scatter, anisotropic *and* Kulla–Conty multiscatter lobes through a shared `FresnelSpec`.
      New **Metals of the World** scene + six proofs (range, k→0 dielectric limit, textbook colours,
      a furnace render reconstructing the measured RGB, MIS sampler↔pdf↔weight, multiscatter energy).
- [ ] **Anisotropic clear-coat & dielectric multiscatter** — extend energy compensation to rough glass
- [x] **Subsurface scattering (12.0)** — random-walk volumetric transport *inside* a translucent
      dielectric (marble/jade/wax/skin): a `Subsurface { sigmaT, albedo, g }` interior, an interior
      free-flight + HG phase walk bounded by the real surface, Fresnel-boundary entry/exit + TIR.
      Two scenes (**Subsurface Studio**, **Jade Idol**) + five proofs (pure-scatter furnace ≡ 1 ∀g,
      pure-absorb ≡ e^(−σ·2r), whole-object Fresnel+TIR+scatter energy ≡ 1, per-channel albedo R>G>B,
      reflectance strictly monotone in albedo).
- [ ] **Subsurface NEE through the boundary** — importance-sample a light *and* the refraction toward
      it (a refracted-shadow connection) to kill the phase-only glow's variance
- [ ] **Separable BSSRDF / diffusion-dipole fast-path** — for very dense media the random walk samples
      poorly at low depth; a diffusion approximation would converge the deep-scatter look in O(1) bounces
- [x] **Spectral (per-channel σ_t) subsurface (15.0)** — vary the *mean free path* with wavelength via the
      hero-wavelength machinery (real skin: red penetrates far, blue barely at all), not just the albedo.
      A spectral interior carries per-channel `sigmaTSpectral`/`albedoSpectral` (read as 3-point spectra
      at R/G/B representative wavelengths); the path commits a hero λ at the boundary and random-walks
      *monochromatically* with σ_t(λ)/ϖ(λ), colour reconstructing through the committed wavelengthWeight.
  - [x] **Measured BSSRDF media library** — Jensen et al. 2001 σ_s′/σ_a for marble, skin1/2, whole/skim
        milk, cream, ketchup, chicken, potato, apple, converted to per-wavelength extinction + albedo
  - [x] Two scenes (**Living Skin**, **Apothecary**) + six proofs (upsampling contract; measured-media
        sanity/red-deepest; chromatic furnace ≡ 1; spectral Beer ≡ ∫w(λ)e^(−σ(λ)·2r)dλ with R>G>B;
        achromatic ≡ scalar oracle; measured skin glows red)
- [ ] **Spectral subsurface in the photon mapper (SPPM)** — let inner caustics through a translucent
      solid carry the chromatic mean free path too (today only the path tracer/PSSMLT walk the interior)
- [x] **Participating media** — bounded homogeneous volumes with Henyey–Greenstein
      scattering, distance sampling, in-scattering NEE + phase-function MIS (fog, smoke, god rays)
- [x] **Thin-film interference** — spectral Airy reflectance for iridescent coatings
      (soap-bubble / oil-slick / beetle-shell colour from interference, via the hero-wavelength path)
- [x] **Low-discrepancy (quasi-Monte-Carlo) primary sampling** — scrambled Halton
      sequence with Cranley–Patterson rotation for the camera sub-pixel + lens dimensions
- [x] **Primary-Sample-Space Metropolis Light Transport (PSSMLT)** — a third integrator: a
      Markov chain over the path tracer's random stream (Kelemen mutation + Metropolis–Hastings),
      with bootstrap normalisation, parallel chains across the worker pool, and three new proofs
      that it converges to the same image as PT/BDPT
- [x] **Stochastic Progressive Photon Mapping (SPPM)** — a fourth integrator built for **caustics**
      (light→specular→diffuse paths NEE can't sample): photons emitted from the area lights (power-
      sampled, equal flux), traced through the specular geometry, and gathered at per-pixel
      measurement points through an exact spatial hash, with a per-point gather radius shrunk on the
      Hachisuka schedule so the density-estimation bias vanishes and the estimate converges. Slots
      into the full-frame estimator path (like PSSMLT); a new **Caustic Pool** scene (a sine-ripple
      water surface with analytic smooth normals) showcases it; three new proofs (SPPM≡PT oracle,
      caustic-forms, and the gather grid is exact vs brute force)
- [x] **Importance sampling of many lights — the light BVH (14.0)** — a binary tree over the
      emissive triangles (power + bounds + normal-cone per node) that replaces uniform light
      selection in NEE with a stochastic root→leaf descent weighted by `power·orient(p)/dist²(p,box)`,
      so near/bright/well-oriented lights are chosen far more often. A drop-in for the selection step:
      same `sampleLight`/`lightPdf` contract → MIS unchanged → unbiased (converges to the same image),
      with the uniform path kept byte-for-byte as the default. Two scenes (**Star Field**, **Lantern
      Hall**) + five proofs (Σpdf=1, sampler↔pdf, positivity, reduction-to-uniform, same-image+variance).
  - [x] **Adaptive tree splitting (SAH-style) (17.0)** — split by a surface-area/power cost
        (`Σ power·surfaceArea`) rather than the median (prefix/suffix sweep, O(count)), so a powerful
        lamp is isolated from a dim halo and the importance estimate is sharper
  - [x] **Receiver-normal–aware importance (17.0)** — fold the shade point's normal into the cluster
        importance (a floored cone bound on how much of the box lies in the lit hemisphere) so
        back-hemisphere clusters are down-weighted before the shadow ray; threaded through
        `sampleLight`/`lightPdf` and kept MIS-consistent via the stored vertex normal
  - [ ] **Stochastic light-tree for BDPT/SPPM** too — share one importance sampler across all integrators
- [x] **Sphere-light NEE — subtended-cone (solid-angle) sampling (20.0)** — emissive spheres are now
      first-class lights: a shade point samples the cone a sphere subtends (`cosθ_max=√(1−R²/d²)`,
      `Ω=2π(1−cosθ_max)`, uniform within), so a small bright orb that BSDF sampling finds <1% of the
      time is lit cleanly. Drop-in for the selection step (`sampleLight`/`lightPdf`/`envSunPdf` learn a
      `useSphere` flag; the same Ω drives the BSDF-hit MIS weight), gated so OFF is byte-for-byte. Two
      scenes (**Plasma Lamps**, **Firefly Swarm**) + six proofs (Ω + inverse-square limit; sampler↔pdf
      with ∫_cone dω=Ω; pdf integrates to 1; **analytic form-factor oracle + >100,000× variance win**;
      MIS-consistency to machine ε; horizon/inside guards). 104 proofs total.
  - [ ] **Sphere emitters in the light BVH** — give clusters that contain spheres a bounding box (the
        sphere AABB) and an all-directions normal cone, so `manyLights` distributes sphere selection by
        power/distance too (today spheres take a uniform 1/N residual slot beside the tree's triangles)
  - [ ] **Area-preserving sphere sampling for a point inside/very near** — fall back to uniform-area (or
        a BSSRDF-style) sample when `d ≲ R` instead of declining, so an emitter you are *inside* still
        gets a direct estimate (rare, but it removes the last BSDF-only case)
  - [ ] **Ellipsoid / disc / quad analytic lights** — extend the solid-angle sampler family (Urena 2013
        spherical-rectangle sampling for quads; spherical-ellipse for discs) so every non-triangle
        emitter has an exact NEE pdf, not just the sphere
- [ ] WebGPU compute backend behind the same scene API
- [ ] Image (bitmap) textures + tangent-space normal maps (needs UV plumbing)
- [ ] **Photon-map progress-radius decoupling** — share one radius across all workers' passes
      (a single global SPPM rather than averaged independent ones) for slightly faster convergence
- [ ] **Volumetric photon mapping / beam radiance estimate** — let SPPM resolve *volumetric*
      caustics (light focused inside fog) by depositing photons along medium free-flights
- [x] **Spectral photons (8.0)** — a photon commits a random hero wavelength on its first dispersive
      hit and carries that wavelength's RGB weight, so its refraction bends per-colour and the caustic
      it deposits is a *rainbow*. E_λ[weight]=(1,1,1) keeps the total energy exact (proven). Showcased
      by the new **Spectral Caustic** scene.
- [x] **Environment photon emission (8.0)** — the sun (a daylight-gradient sun or a Preetham sky) is
      now a photon source: photons leave a disc sized to the scene's bounding sphere, perpendicular to
      the sun, and rain in as a parallel beam, so daylight scenes get photon-mapped **sun caustics** and
      indirect light. The distant-light flux normalisation S = L·ΣW/lum(L_rep) is proven against the
      path tracer. Showcased by the new **Daylight Lens** scene.
- [x] **Practical Path Guiding — the SD-tree (13.0)** — a fifth integrator: a learned
      importance-sampling distribution that turns the unidirectional path tracer *adaptive*.
  - [x] **Directional quadtree (`DTree`)** over the sphere via an equal-area cylindrical map
        (constant Jacobian dω=4π·du·dv), with a building/sampling double-buffer, flux-threshold
        refinement, and exact `sample`/`pdf`/`record`
  - [x] **Spatial binary k-d tree (`Guide`)** over the scene AABB; leaves carry a `DTree` and
        subdivide by *visit* count (children inherit a clone of the parent's distribution)
  - [x] **Unbiased mixture sampling** in the integrator — `α·p_bsdf+(1−α)·p_guide` with MIS-consistent
        NEE/emission weights; a gentle α=0.7 (30 % guide) is the robust operating point
  - [x] **Radiance recording** — each path's downstream incident radiance splatted at every guidable
        vertex; **per-leaf maturity gating** (`trainedAt`) so under-trained regions fall back to BSDF
  - [x] **Iteration schedule** wired into the worker pool *and* single-thread fallback (refine at
        power-of-two sample boundaries 1,2,4,8,… so each iteration trains on twice the data)
  - [x] **Glowing Orb** showcase scene (lit only by a NEE-invisible emissive sphere — guiding's home
        turf) + the **Hidden Door** two-chamber indirect scene
  - [x] **Four correctness proofs** — the DTree density integrates to 1 over the sphere; sampler↔pdf
        consistency to machine ε; importance sampling cuts a peaked integral's variance ~100× at equal
        means; and the **Guided ≡ path tracer** oracle on the diffuse box (unbiasedness)
- [ ] **Learned per-leaf BSDF-sampling fraction** — adapt α per spatial leaf by tracked variance
      (Müller's production PPG) so guiding leans in only where it provably helps, never elsewhere
- [ ] **Filtered radiance recording** — box-filter splat each record across neighbouring DTree leaves
      to tame the piecewise-constant pdf's firefly tail and let α drop further
- [ ] **Guide the BDPT / volumetric vertices** too — extend the SD-tree to phase-function scattering
      inside media and to the light subpath
- [ ] Replica-exchange / population MLT — couple PSSMLT chains at different temperatures so a hot
      chain that finds new light hands its discovery to the cold (image) chain
- [ ] A "transport explorer" debug view that visualises which integrator each pixel favours, and
      an A/B equal-time split-screen of PT vs BDPT vs PSSMLT vs SPPM to make the variance gap visible
- [ ] Multiplexed MLT (Hachisuka et al.) — let the chain mutate *which* BDPT strategy it uses, so
      one estimator adapts per-path instead of fixing PT vs BDPT up front
- [ ] Stratified large-step pixel selection so PSSMLT's global jumps cover the film evenly
- [x] **Heterogeneous participating media (9.0)** — procedural 3D density fields (FBM
      cumulus clouds, rising smoke plumes, exponential ground-fog layers) sampled with
      **delta tracking** (Woodcock null-collision free-flight) for in-volume scatter events
      and **ratio tracking** for the shadow-ray transmittance, both provably unbiased for an
      arbitrary spatially varying extinction. Three showcase scenes + five new proofs.
- [x] **Spectral / chromatic majorants for media (16.0)** — per-channel σ_t (a `sigmaTSpectral` on
      `MediumDef`) read as a 3-point spectrum; the path commits a hero λ before tracking and delta/
      ratio-tracks against σ_t(λ), so blue is scattered out sooner than red. Works for both homogeneous
      (analytic) and heterogeneous (null-collision) media. Two scenes (**Rayleigh Haze**, **Amber
      Smoke**) + five proofs (exact per-λ transmittance; ratio tracking unbiased ∀λ; chromatic furnace
      ≡ 1; absorbing haze ≡ ∫w(λ)e^(−σ(λ)·2r)dλ with R>G>B; achromatic ≡ scalar oracle).
- [x] **Emissive volumes (9.1)** — a density-modulated emission term in the medium: at a real
      collision the path collects `(1−albedo)·Lₑ` of self-radiance, so a heterogeneous field glows
      brightest in its dense core (fire / embers / luminous nebula). New **Ember** scene + a proof
      that an absorbing+emitting volume obeys `(1−e^(−σ_t·chord))·Lₑ`.

## Roadmap — 2026-06-27 Lumen 22.0: the camera becomes physical — image formation (claude)

For twenty-one versions Lumen has been about getting the *scene-referred radiance* exactly right —
five integrators, spectral subsurface, a chromatic atmosphere, importance-sampled HDRIs — all of it in
service of the number a perfect sensor would read at each pixel. But a **photograph is not the radiance
field.** It is what a *camera and a piece of film* did to that field: light scatters inside the lens and
veils the highlights, the pupil cuts off-axis rays so the corners darken, the glass refracts each colour
to a slightly different magnification, the iris is a polygon so out-of-focus points are polygons, and the
emulsion records discrete grains. Lumen had exactly one of these (a circular thin-lens DoF). 22.0 adds the
rest — a complete **post-capture image-formation pipeline** — and, in the house style, proves every part.

The design splits by colour space, the way a real imaging chain does. **Glare** and **vignetting** are
*radiometric* — they redistribute and attenuate energy — so they run in **linear HDR, before tone
mapping**. **Chromatic aberration** and **film grain** are artefacts of the *recording medium*, so they
run on the **tone-mapped 8-bit image, after** the tone curve. And the whole thing is a strict superset of
the old behaviour: with every knob at zero it is a **bit-exact identity**, so the default render — and all
117 prior transport proofs — are untouched. None of it touches the integrator; the four film effects live
in a new pure `postprocess.ts` on the UI thread, and the one transport-adjacent change (aperture *shape*)
is gated so a circular iris is the historical concentric-disk sampler **bit-for-bit**.

The five pieces, each with an analytic invariant the verify suite pins down:

- **Polygonal-aperture bokeh.** A real iris is a regular polygon of blades, so an out-of-focus highlight
  images as that polygon — the hexagonal/octagonal *bokeh ball* a perfect circle can never make.
  `sampleAperture` draws a point **area-uniformly** over a regular n-gon: `u₁·n` splits into an integer
  wedge index (each equally likely) and a fractional part that — *independent* of the index for uniform
  `u₁` — becomes a barycentric coordinate inside that wedge (with the `(a,b)→(1−a,1−b)` fold giving a
  uniform triangle sample). Because the polygon is symmetric the **mean lens offset is zero**, so depth of
  field stays **exactly unbiased** — only the *shape* of the circle of confusion changes.
- **Veiling-glare bloom (energy-conserving).** A passive optic neither creates nor destroys light, so
  glare is a *linear, energy-preserving* spread: the displayed image is the convex blend
  `(1−s)·image + s·glare(image)`, where `glare` is a normalised multi-scale Gaussian PSF (a tight core +
  a broad veil — the Spencer et al. 1995 model), each Gaussian built from three O(N) box-blur passes. The
  normalisation (Σweights = 1) is what makes a centred highlight keep its **total energy** through the PSF.
- **Natural cos⁴θ vignetting.** Off-axis image points receive less irradiance by the textbook cos⁴θ law
  (inverse-square distance + foreshortened aperture + tilted sensor patch); with `tanθ = r` that is
  `1/(1+r²)²`. Tied to the camera's field of view, the optical centre is exactly unattenuated.
- **Lateral chromatic aberration.** A lens focuses each wavelength to a slightly different magnification,
  so red and blue are radially rescaled about the optical centre (green the reference channel), bilinearly
  resampled. The centre is a fixed point of every channel; magnitude 0 is a bit-exact identity.
- **Photographic film grain.** A monochromatic, **zero-mean** dither whose amplitude follows √(L(1−L)), so
  it peaks in the midtones and **vanishes at pure black and pure white**. Deterministic in the pixel
  coordinate (a hash, not the wall clock), so the catalog thumbnail and the verify suite are reproducible.

Plan / steps (all shipped this session):

1. [x] **`postprocess.ts` — the pipeline, in its own pure module.** `gaussianBlurRGB` (3× box, O(N) via
   running sums) → `glareRGB` (normalised multi-scale PSF) → `applyBloom`; `naturalVignetteFactor` +
   `applyVignette`; `chromaticAberration` (bilinear, green-fixed, centre-fixed); `grainEnvelope` +
   `applyGrain` (TPDF, midtone-peaked); and the `postProcessHdr`/`postProcessDisplay` orchestrators with
   `postActiveHdr`/`postActiveDisplay` guards so a zeroed pipeline allocates nothing and runs nothing.
2. [x] **`camera.ts` — polygonal bokeh.** `sampleAperture(blades, rot, u₁, u₂)` (area-uniform n-gon, disk
   fallback) + `CameraDef.blades`/`bladeRotation`; `generateRay` routes through it only for `blades ≥ 3`,
   so a circular iris is the historical path bit-for-bit.
3. [x] **`renderer.ts` — wire both composite paths.** `DisplaySettings.post`; the HDR stages run on the
   averaged/denoised buffer (into a fresh buffer, never mutating the accumulation) before `tonemapToBytes`,
   the display stages on the byte image after — in both the Monte-Carlo and the PSSMLT/SPPM frame paths.
4. [x] **UI — `controlConfig`/`App`/`Controls`.** An "Iris blades" render control (per-scene default) and a
   live **Camera & Film** panel (bloom + radius, vignette, chromatic aberration, film grain), threaded
   through `buildScene`/`buildDisplay`/`renderKey`/the display effect; an About card.
5. [x] **Two showcase scenes.** *Neon Bokeh* (a focused subject behind ~70 tiny neon motes at a wide depth
   spread + a 6-blade wide-open iris ⇒ hexagonal bokeh balls) and *Lumière Hall* (a dim corridor of fierce
   bulbs for energy-conserving glare + corner vignetting).
6. [x] **`selftest.ts` — eight proofs (118 total).** (a) the bokeh sampler is **area-uniform** (the
   inscribed-circle fraction matches `π·apothem²/area(n-gon)`), inside the unit disk, and **zero-mean**
   (unbiased DoF); (b) it **reduces to the disk sampler** for `blades < 3` and **fills the disk** as
   `blades→∞`; (c) glare is **energy-conserving** for a centred feature and an **identity at strength 0**;
   (d) an impulse spreads into a **monotone-falloff halo**; (e) the vignette is **exactly cos⁴θ**, unit at
   the centre, monotone, identity off; (f) chromatic aberration is an **identity at the centre and at
   magnitude 0**, leaves **green fixed**, and shifts red radially; (g) film grain is **zero-mean**, fixes
   **black & white**, identity off, variance rising with strength; (h) the **whole pipeline at zero is a
   bit-exact identity**. Verified in Node: **118/118** self-tests pass; the CI gate (scope + conformance +
   lint + build) is green, and smoke renders of both new scenes through the full pipeline are finite & lit.

New open ideas this raised (live backlog, above): cat's-eye / optical vignetting (a truncated entrance
pupil for swirly off-axis bokeh); lens flare & ghosts (the aperture-shaped inter-element reflection chain);
anamorphic bokeh + barrel/pincushion distortion; and a tilt-shift (Scheimpflug) focal plane.

## Roadmap — 2026-06-27 Lumen 21.0: image-based lighting — HDRI environment importance sampling (claude)

For twenty versions Lumen's *environment* — the radiance an escaping ray reads, and the scene's
ambient fill — was either a constant colour, a vertical **gradient**, or the analytic **Preetham
sky**. And the only part of it next-event estimation could ever **sample** was the **sun**: a single
small cone (`sampleEnvLight`/`envSunPdf`). Everything else in the environment — a bright softbox, the
warm flush of a sunset horizon, a band of city lights — was found **only by a BSDF ray that happened
to point at it**. For a glossy surface under a vivid, structured environment that is a losing game:
the bright features are a tiny fraction of the sphere, so most rays miss them and the image is a storm
of colour noise. This is the same failure the 14.0 light tree fixed for *many triangle emitters* and
20.0 fixed for *emissive spheres* — only now the "light" is the whole sky.

21.0 brings the production-standard answer: an **equirectangular HDRI environment**, **importance
sampled** in full. This is a from-scratch implementation of PBRT's `InfiniteAreaLight`
(`src/engine/envmap.ts`): a **piecewise-constant 2D distribution** built from every texel's
**luminance × sinθ** (the lat-long map's solid-angle Jacobian), sampled by a **marginal-then-conditional
inverse CDF** (`Distribution1D`/`Distribution2D`). A draw returns a direction toward the *bright* parts
of the panorama with an **exact solid-angle pdf** `p(ω) = p(u,v)/(2π² sinθ)`, which **MIS-pairs with
BSDF sampling** byte-for-byte the way every other Lumen light does — so the estimator stays **provably
unbiased**; only the variance collapses (the headline proof measures a **~22×** per-sample variance
drop on a sunset environment at an identical mean — and ∞× on the parts BSDF sampling can't find).

It is a **drop-in for the environment slot only**. A new `EnvDef` variant `{ kind: 'hdri' }` builds an
`EnvMap` in the `Scene` constructor; `envRadiance` reads it, the env slot of the NEE pool samples it by
importance instead of as a sun cone, and `envSunPdf` returns its density for the MIS weight. Every
non-HDRI env is **untouched bit-for-bit** (the env slot's presence is generalised from `envSun !== null`
to `hasEnvLight`, which is identical for the old kinds), so **all 104 prior proofs stay green**. The
path tracer, the path-guided tracer and Metropolis all inherit the win for free.

The panoramas are **generated procedurally** (no image assets to ship, deterministic across the worker
pool and the verify suite): **`studio`** (a dark stage lit by three soft rectangular sources — the
product-shot setup where most of the dome is black), **`sunset`** (a graded sky with a blinding low
sun carrying most of the energy), and **`twilight`** (a deep dome over a horizon strewn with ~520 warm
city lights + a moon — the many-tiny-emitters regime, breathtaking in chrome). A live **rotation** knob
spins the panorama (the importance distribution rides with it, proven a measure-preserving symmetry)
and an **intensity** knob scales radiance without touching the pdf.

Plan / steps (all shipped this session):

1. [x] **`envmap.ts` — the sampler, in its own pure module.** `Distribution1D` (PBRT inverse-CDF over
   buckets) + `Distribution2D` (per-row conditionals + a marginal), an `EnvMap` exposing
   `radiance(dir)` (bilinear, cyclic in u), `sample(u0,u1)` (importance direction + solid-angle pdf +
   radiance) and `pdf(dir)` (the MIS partner), with the equirectangular ↔ direction map and the
   `dω = 2π² sinθ du dv` Jacobian. Three deterministic procedural panorama generators.
2. [x] **`types.ts` + `scene.ts` — HDRI as a first-class env light.** New `EnvDef` `'hdri'` variant;
   build `EnvMap` in the `Scene` ctor; dispatch `envRadiance`; sample the env slot via `EnvMap.sample`;
   return `EnvMap.pdf/numLights` from `envSunPdf`; generalise the env-slot count to `hasEnvLight`.
   Non-HDRI envs reproduced **byte-for-byte**.
3. [x] **Three showcase scenes + UI.** *Studio HDRI*, *Sunset HDRI*, *Twilight HDRI* (each lit by the
   environment **alone** — no emitters). A scene `hdri` flag exposes an **Env rotation** + **Env
   intensity** panel, wired through `ControlState` / App `buildScene` / `renderKey` like the sky knobs.
4. [x] **`selftest.ts` — six proofs (110 total).** (a) the 2D distribution is a genuine density —
   `∫∫p du dv = 1` exactly and the directional `∫_S² p dω = 1` (Monte-Carlo); (b) the importance
   sampler ↔ `pdf(wi)` to **machine ε**, every direction unit & positive; (c) a **constant** env
   reduces to **uniform** `1/(4π)` over the sphere (the equatorial-Jacobian oracle, the IBL analogue of
   "coincident lights ⇒ 1/N"); (d) **MIS consistency** through the `Scene` — `envSunPdf ≡ EnvMap.pdf /
   numLights ≡` the NEE sampler's returned pdf (the no-double-count guarantee); (e) importance sampling
   is **unbiased** (means agree to <1%) with a **~22×** lower variance than uniform on a peaked env;
   (f) env **rotation** is a measure-preserving symmetry (same deviates ⇒ identical radiance + pdf, the
   azimuth advanced by exactly φ). Verified in Node: **110/110** self-tests pass; the CI gate (scope +
   conformance + lint + build) is green.

New open ideas this raised (live backlog, below): load a *real* `.hdr`/`.exr` panorama (Radiance RGBE
/ OpenEXR decode); a **two-strategy MIS** that also cosine-importance-samples the BSDF against the env;
fold the env into the **light tree** so a bright env region competes with triangle/sphere emitters in
one unified selection; and a **prefiltered** env mip-chain for the diffuse/rough-gloss fast path.

## Roadmap — 2026-06-26 Lumen 20.0: direct light on every shape — sphere-light NEE (claude)

For nineteen versions Lumen's next-event estimation could connect a shadow ray only to **triangle**
emitters. The reason was principled: a flat triangle has an exact solid-angle pdf `d²/(cosθ·A)`, so its
MIS weights are provably consistent — and an emissive **sphere** has no such triangle pdf, so it was
left to **BSDF sampling alone** (a scattered ray that happens to strike it). For a small, bright orb
that is found a fraction of a percent of the time, so a sphere-lit room rendered as a **storm of
fireflies** — the entire premise of the 13.0 *Glowing Orb* scene, whose room is lit by a single
emissive sphere "INVISIBLE to NEE."

20.0 closes that gap with the textbook estimator (PBRT §12, *Sampling Spheres*). The directions from a
shade point that strike a sphere of radius R a distance d away form a **cone** of half-angle θ_max with
`cos θ_max = √(1 − R²/d²)`; sampling a direction **uniformly inside that cone** gives a constant
solid-angle density `p(ω) = 1/Ω`, `Ω = 2π(1 − cos θ_max)`, so every shadow ray lands **on** the orb and
none is wasted on the dark around it. The same Ω drives the MIS weight when a BSDF ray instead lands on
the sphere (`sphereDirPdf`), so the two estimators stay consistent and the result is **provably
unbiased** — only the variance collapses (the headline proof measures a **>100,000×** per-sample
variance drop against the naive hemisphere sampler, at an identical mean).

It is a **drop-in for the selection step only**, mirroring the 14.0 light tree: `sampleLight` /
`lightPdf` / `envSunPdf` learn a `useSphere` flag, the emissive spheres join the uniform 1/N selection
pool (a residual slot beside the light-tree's triangle mass and the env sun's slot), and the integrator
is otherwise untouched — so the surface NEE, the **volumetric in-scattering** NEE (a medium can now
connect to a sphere), and the path tracer / guided / Metropolis estimators all inherit the win. The
feature is **gated** behind a "Sphere lights (cone NEE)" toggle (default off, on for the two new
scenes), and with it off every code path is the historical one **bit-for-bit**, so all 98 prior proofs
stay green. A reference point *inside* a sphere has no subtending cone, so the sampler declines there and
BSDF sampling carries it unbiasedly.

Plan / steps (all shipped this session):

1. **`spherelight.ts` — the math, in its own pure module.** `sphereConeCosMax`, `sphereSolidAngle`,
   `sampleSphereLight` (uniform-cone direction + **closed-form** near-hit distance
   `d·cosθ − √(R² − d²sin²θ)`, robust at the grazing cone edge), `sphereDirPdf` (the MIS pdf), and
   `sphereIrradianceFull` (the exact sphere form factor `π·L·sin²θ_max·cosθ_c`, the analytic oracle).
2. **`scene.ts` — sphere emitters as first-class lights.** Index emissive spheres; thread `useSphere`
   through `sampleLight` (uniform + light-tree residual), `lightPdf`, `envSunPdf`, with an
   `effLightCount` that keeps every selection denominator consistent. OFF ⇒ byte-for-byte.
3. **`integrator.ts` + settings plumbing.** Compute `useSphere`; pass to the four light queries. New
   `sphereLights` on `IntegratorSettings` / `ControlState`; wired through App / Controls / per-scene
   defaults exactly like `manyLights`.
4. **Two showcase scenes.** *Plasma Lamps* (a still life lit only by three vivid emissive bulbs of
   varied size/distance — sharp coloured reflections in a steel sphere) and *Firefly Swarm* (~50 tiny
   bright motes over a meadow, the sphere-light analogue of Star Field).
5. **`selftest.ts` — six proofs (104 total).** (a) the subtended-cone solid angle equals
   `2π(1−cosθ_max)` and reduces to the inverse-square `πR²/d²` as R/d→0; (b) the cone sampler ↔ its pdf
   (`∫_cone dω = Ω` by Monte-Carlo, every sampled ray actually hits the sphere, `pdf ≡ 1/Ω`); (c) the
   directional pdf **integrates to 1** over S²; (d) the headline — the cone-NEE estimator matches the
   **analytic form factor** to <1 SE while its variance is **>100,000×** below the naive uniform
   sampler; (e) **MIS consistency** — the sampler's pdf equals `scene.lightPdf` for the same direction
   to machine ε (the no-double-count guarantee); (f) it respects the **horizon** (a sub-floor sphere
   leaks nothing) and **declines inside** a sphere. Verified in Node: **104/104** self-tests pass; the
   CI gate (scope + conformance + lint + build) is green.

## Roadmap — 2026-06-25 Lumen 19.0: AgX tone mapping (claude)

Every estimator in Lumen has been about getting the *scene-referred* radiance right. But the last
step — squeezing that unbounded HDR buffer into a monitor's 0–1 — is a real image-formation choice,
and Lumen's operators (ACES, Reinhard, a Hejl filmic) are all **per-channel**. Per-channel tone curves
have a notorious failure: a bright, saturated colour drives one channel to clip while the others lag,
so the hue *skews* — an intense blue stage light turns magenta, a fire's core goes pure red. Modern
pipelines fixed this with **AgX** (Troy Sobotka's transform, now the Blender default), which couples
the channels so highlights **desaturate toward white** as they brighten, the way film stock and the
eye actually behave.

19.0 adds it. AgX rotates the linear colour through a desaturated "inset" matrix, compresses luminance
over a fixed log₂ window (−12.47 … +4.03 EV), applies a sigmoidal contrast curve (Benjamin Wrensch's
6th-order fit of Sobotka's curve), then rotates back through the "outset" matrix. It is purely a
**display transform** — it runs on the UI thread over the averaged buffer and never touches the
unbiased light transport — so it cannot perturb a single one of the 94 existing proofs; it is a new
selectable operator beside ACES/Filmic/Reinhard/Linear.

The one subtlety that mattered: the published AgX matrices are written as GLSL `mat3` literals, which
are **column-major**, so reading them row-major silently transposes them — and the transposed inset is
not row-stochastic, which tints every neutral. The fix (and the test that caught it) is the
neutral-preservation proof: with the correctly-transposed, row-stochastic matrices a grey in is a grey
out, and 18% scene grey lands on display byte 128 exactly.

Plan / steps (all shipped this session):

1. **`tonemap.ts` — AgX.** `agx(r,g,b)` (inset → per-channel log₂-normalise → `agxContrast` sigmoid →
   outset → de-gamma to linear), wired into `tonemapToBytes` as an RGB-coupled branch (the others stay
   per-channel) and a `'agx'` case kept exhaustive in `mapChannel`.
2. **`types.ts` / `Controls.tsx`** — `'agx'` added to the `ToneMapping` union and the tone-map selector.
3. **`selftest.ts` — four proofs (98 total).** (a) the contrast curve is monotone on [0,1] and bounded
   (maps the black point→~0, white→~1); (b) **neutral stays neutral** (grey in ⇒ grey out across 7
   levels — the matrix-transpose guard); (c) black→black and luminance is monotone in exposure, output
   finite and non-negative over a wide HDR range; (d) the headline — a blinding saturated colour
   **desaturates toward white** (its min/max channel ratio rises well above the input's).
4. **UI / About.** An "AgX tone mapping" card. Verified in Node: 98/98 self-tests pass, and an AgX
   byte-output sanity sweep is photographic (18% grey → 128, smooth highlight rolloff).
   `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-25 Lumen 18.0: physically based light colour — blackbody emitters (claude)

Lumen had grown rigorous about how light *propagates* — five integrators, spectral subsurface, a
chromatic atmosphere, a receiver-aware light tree — while every light *source* was still typed in by
hand as a raw RGB radiance. But real sources don't have an RGB colour; they have a **temperature**. A
tungsten lamp is ~2700 K and warm; daylight is ~6500 K and neutral; a clear north sky is ~10000 K and
blue. That warm→cool sweep — colour temperature — is the **Planckian locus**, fixed by physics.

18.0 computes it from scratch and hands scenes a temperature dial. `planck(λ,T)` is Planck's law for
spectral radiance; we integrate it against the **CIE 1931 colour-matching functions** (the analytic
multi-Gaussian fit of Wyman, Sloan & Shirley 2013 — no 1 nm table to ship) to get the tristimulus the
eye would see, then convert XYZ→linear sRGB with the standard matrix and normalise to a unit-brightness
hue. A scene calls `blackbody(3200)` where it used to invent an RGB triple. Crucially it needs **no
integrator or material change** — it is a colour helper, computed at scene-build time — yet it is as
physically grounded as the transport it feeds, and the verify suite pins it to the textbook laws.

Plan / steps (all shipped this session):

1. **`blackbody.ts` — the module.** `planck(λ,T)` (∝ λ⁻⁵/expm1(c₂/λT), the leading constant cancels);
   the CIE CMFs `cieXYZBar(λ)` as the Wyman–Sloan–Shirley Gaussians; a 5 nm Riemann integral
   `blackbodyXYZ(T)`; the XYZ→linear-sRGB matrix; and `blackbody(K)` (unit-peak hue, out-of-gamut
   negatives clamped) + `blackbodyEmission(K, intensity)`.
2. **`scenes.ts` — Colour Temperature.** A row of emissive panels from 2000 K to 12000 K, each its
   blackbody hue, washing a neutral matte sphere and the wall — the locus read straight off the light.
3. **`selftest.ts` — four proofs (94 total).** (a) Planck positivity + **Wien's displacement**
   (numerically located peak λ_max·T ≈ 2.898×10⁶ nm·K to <1%); (b) **Stefan–Boltzmann** (band integral
   ∝ T⁴ ⇒ ∫B(2T)/∫B(T) ≈ 16); (c) the **Planckian locus** runs warm→neutral→cool with a strictly
   monotone red/blue ratio, every hue bounded in [0,1]; (d) 6500 K lands on a near-**neutral white
   point** (the calibration anchor of the whole Planck→CMF→XYZ→sRGB pipeline).
4. **UI / About.** A "Physically based light colour (blackbody)" card; the scene in the picker.
   Verified in Node: 94/94 self-tests pass; a smoke render of *Colour Temperature* is finite and lit.
   `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-25 Lumen 17.0: a sharper light tree — SAH splitting + receiver-aware importance (claude)

14.0's light BVH turned uniform many-light NEE into a power/distance/orientation importance sampler,
but it left two refinements on the table that the original paper (Conty Estevez & Kulla 2018) builds
in, and that the journal explicitly deferred. 17.0 ships both, and proves them.

**1 — SAH-style splitting.** The 14.0 tree split every cluster at the **median** of the widest
centroid axis. That balances counts but ignores *power* and *spatial tightness*: a single bright lamp
sitting among a halo of dim ones gets lumped into a fat box with them, so a descent toward that lamp
carries a loose importance and wastes branch probability on its dim neighbours. 17.0 instead picks the
split that minimises the **surface-area heuristic** cost `Σ_child power(child)·surfaceArea(bounds)` —
the light-transport analogue of the geometry BVH's SAH — evaluated over every candidate split by a
prefix/suffix sweep in O(count). Bright tight clusters localise; a lone powerful light is isolated. The
tree's *topology* changes but none of its guarantees do (the selection pdf is renormalised at each
split regardless of how the items are partitioned), so every 14.0 proof still holds.

**2 — Receiver-aware importance.** The 14.0 importance asked only "how much could this cluster light
the *point* `p`?" — power, distance, and the emitters' own orientation. It never asked which way the
*surface at* `p` faces. So at a floor point, a cluster of lamps in the basement below counts as much as
one on the ceiling above, even though the floor's cosine term will zero the basement out — half the
shadow rays wasted. 17.0 folds the shade normal `n` into the importance: a floored cone bound on the
largest `cos(n, p→cluster)` achievable over the cluster's box, so a cluster behind the surface scores
the floor and one in front scores high. It is threaded through `sampleLight`/`lightPdf` (and so the
integrator passes `hit.n` at NEE and the stored vertex normal `prevNormal` at the emission-MIS pdf, so
the sampler and its pdf stay paired and the estimate stays unbiased). The floor keeps every light
strictly positive — the precondition for unbiasedness — so, exactly as before, the tree only reshapes
the variance of NEE and converges to the same image. A receiver normal is *optional* everywhere, so a
volume/subsurface scatter vertex (no surface) and every prior proof use the receiver-agnostic path
**verbatim**.

Plan / steps (all shipped this session):

1. **`lighttree.ts` — SAH split.** Replace the median cut in `build()` with the prefix/suffix
   surface-area-cost sweep (`surfaceArea` helper added); ties keep the median so coincident-light
   reduction-to-uniform is preserved.
2. **`lighttree.ts` — receiver term.** `importance(node, p, nRecv?)` gains a floored receiver-facing
   cone bound; `sample`/`prob` take an optional `nRecv` and pass it through. `nRecv` undefined ⇒ the
   14.0 importance bit-for-bit.
3. **`scene.ts` — plumb the normal.** `sampleLight`/`lightPdf`/`sampleLightTree` take an optional
   `refNormal` and forward it to the tree.
4. **`integrator.ts` — supply the normal.** Track `prevNormal` alongside `prevPoint` (the surface
   normal at the last vertex, undefined for volume/SSS scatters); pass `hit.n` to the surface NEE and
   `prevNormal` to the emission-MIS `lightPdf`.
5. **`scenes.ts` — Light Cage.** A faceted icosphere inside a full sphere of ~220 inward-facing lights,
   so ~half the cage is behind any facet's normal — the regime where the receiver term wins most.
6. **`selftest.ts` — four proofs (90 total).** (a) the receiver-aware selection pdf still sums to 1 for
   any point *and any normal*; (b) the receiver-aware sampler matches its pdf to MC precision; (c) the
   receiver term steers selection mass to the lit hemisphere (a front cluster gets ≫ a coincident,
   equally-oriented back cluster) while staying normalised and strictly positive; (d) the headline
   oracle — on a sphere of lights half behind the receiver, the receiver-aware and receiver-agnostic
   trees agree in the mean (unbiased) while the receiver-aware variance is clearly lower. The five
   existing 14.0 proofs now exercise the SAH tree and still pass.
7. **UI / About.** A "sharper light tree" card; *Light Cage* in the picker. Verified in Node: 90/90
   self-tests pass; a smoke render of *Light Cage* is finite and lit (central-crop peak ≈ 0.39).
   `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-25 Lumen 16.0: chromatic participating media — a wavelength-dependent atmosphere (claude)

15.0 gave *subsurface* transport a chromatic mean free path. The space *between* surfaces still had
a **scalar** one: a participating medium carried a single `sigmaT` and a coloured albedo, so a cloud
or a haze extinguished every wavelength equally and could only be tinted by what it *scattered*, never
by *how far each colour reached*. But the most familiar optical effect in the sky is exactly the
chromatic version: **Rayleigh scattering removes blue from a beam far faster than red** (σ_t ∝ ~1/λ⁴),
which is *why the sky is blue and the setting sun is red*. A scalar σ_t cannot express it.

16.0 adds **chromatic extinction** to media, reusing the very same hero-wavelength machinery 15.0
used for subsurface (and 8.0/11.0 for photons and metals): a medium may carry a per-channel
`sigmaTSpectral`, read as a 3-point spectrum (`spectralAt`) at the R/G/B representative wavelengths. A
path that is about to track through media commits one hero wavelength λ, multiplies its throughput by
that wavelength's RGB weight **once** (`E_λ[w]=(1,1,1)`, so it stays unbiased — colour is a *spread*
across λ, never a shift of the mean), and then delta-tracks (free-flight) and ratio-tracks (shadow
transmittance) against the **wavelength's** extinction `σ_t(λ)`. Because both estimators only ever
needed a scalar σ_t and a constant majorant, the change is a one-line substitution `σ_t → σ_t(λ)`
inside each tracker; the heterogeneous *density shape* (∈[0,1]) is untouched, so only the extinction
*scale* is chromatic. The scalar path is preserved **bit-for-bit** (a medium with no `sigmaTSpectral`,
or a path with no committed wavelength, uses `m.sigmaT` exactly as before), so all 81 prior proofs
stay green and only the path tracer (and PSSMLT, which reuses it) sees the new parameter — BDPT and
SPPM sample media-free light their own way and are unaffected.

Plan / steps (all shipped this session):

1. **`types.ts` — `MediumDef.sigmaTSpectral?: Vec3`.** Per-channel extinction; absent ⇒ scalar medium.
2. **`scene.ts` — wavelength-aware tracking.** A `mediumSigmaT(m, λ)` helper returns `spectralAt(σ_t,λ)`
   for a chromatic medium (or the scalar `σ_t` when achromatic / λ=0). `sampleMediumScatter`,
   `mediaTransmittance`, `deltaTrack` and `ratioTrack` take the path's λ and use that scalar; a
   `hasSpectralMedia` flag lets the integrator know to commit a wavelength.
3. **`integrator.ts` — commit the hero λ.** Before the media block, if the scene has spectral media and
   no wavelength is committed yet, draw one and take its RGB weight; thread λ into the three media calls
   (free-flight, in-scatter NEE transmittance, surface NEE transmittance).
4. **`scenes.ts` — two showcases.** **Rayleigh Haze** (a warm sun-disc reddening through a large
   scattering haze whose blue σ_t is ~6× its red — the sunset, and the blue single-scatter halo around
   it) and **Amber Smoke** (a heterogeneous fBm plume coloured purely by a chromatic extinction over a
   neutral-grey albedo, beside the achromatic Smoke Plume for contrast).
5. **`selftest.ts` — five proofs (86 total).** (a) homogeneous transmittance is *exactly* `e^(−σ_t(λ)L)`
   per wavelength (red transmits more than blue); (b) ratio tracking through a constant field averages
   to `e^(−σ_t(λ)L)` at each λ (unbiased null-collision estimator); (c) a chromatic pure-scatter furnace
   ≡ 1 for *any* spectral σ_t (energy conservation, the unbiasedness oracle for the wavelength-resolved
   delta-tracking walk); (d) a pure-absorbing haze reconstructs the spectral transmittance integral
   `(1/Δλ)∫ w(λ)·e^(−σ_t(λ)·2r) dλ` (matched to a fine quadrature) and exits **R>G>B**; (e) an
   achromatic chromatic-medium agrees in the mean with the scalar medium (reduction oracle).
6. **UI / About.** A "Chromatic media — why the sky is blue" card; the two scenes appear in the picker.
   Verified in Node by bundling the engine: 86/86 self-tests pass, and a smoke render of *Rayleigh Haze*
   reddens end-to-end (mean RGB ≈ (0.57, 0.24, 0.06)). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-25 Lumen 15.0: spectral subsurface scattering — a chromatic mean free path (claude)

Lumen 12.0 made a dielectric translucent: light refracts into the solid, random-walks among
microscopic scatterers, and glows back out — marble, jade, wax, skin. But that first model gave the
interior a **scalar mean free path**: one extinction `σ_t` for every colour, so all the chromatic
character of the translucency had to be carried by the per-collision single-scattering albedo. Real
translucent media do not work that way. The reason a hand held over a torch goes deep red at the
edges is **not** that red is absorbed less per bounce — it is that red light *travels further inside
the flesh before it is absorbed at all*. In skin, marble and milk the **extinction itself is
chromatic**: red has a low `σ_t` (a long mean free path, reaching the thin edges), blue a high one
(scattering back out near the surface). That single fact — a **chromatic mean free path** — is the
biggest reason these materials look the way they do, and 12.0 could not express it.

15.0 adds it, and (as is the house style) does it by **reusing machinery that was already there**:
the **hero-wavelength** spectral sampler that already disperses glass and gives real metals their
hue. A path that refracts into a *spectral* interior commits to one wavelength λ, multiplies its
throughput by that wavelength's RGB weight **once** (`wavelengthWeight`, with `E_λ[w]=(1,1,1)`, so
the estimator is unbiased — colour is only a *spread* across λ, never a change of mean), and from
then on random-walks **monochromatically** with the extinction `σ_t(λ)` and single-scattering albedo
`ϖ(λ)` resolved at that wavelength. Average over many paths' wavelengths and the chromatic
translucency reconstructs exactly, energy-conserving by construction. Nothing in the transport loop
changes except *which* scalar `σ_t`/`ϖ` the interior free-flight uses; the scalar 12.0 walk is kept
**bit-for-bit** for any non-spectral interior, so all 75 prior proofs stay green.

The media are not hand-tuned. A new **measured BSSRDF library** carries the canonical coefficients of
Jensen, Marschner, Levoy & Hanrahan (*A Practical Model for Subsurface Light Transport*, SIGGRAPH
2001, Table 2) — marble, skin1/2, whole & skim milk, cream, ketchup, chicken, potato, apple — and
converts their reduced scattering `σ_s′` and absorption `σ_a` into the per-wavelength extinction and
albedo the walk consumes (recovering `σ_s = σ_s′/(1−g)` so the extinction is consistent with the
phase function actually sampled). So *Living Skin* and *Apothecary* render real measured data, not a
guess.

Plan / steps (all shipped this session):

1. **`subsurface.ts` — the new module.** `spectralAt(rgb, λ)` reads an RGB triple as a 3-point
   spectrum at the R/G/B representative wavelengths (650/550/450 nm) — reproducing each channel at
   its wavelength, staying inside the `[min,max]` envelope (so positivity + a ≤1 bound are inherited),
   and going *flat* for an achromatic triple (the key to the reduction proof). `BSSRDF_MEASUREMENTS`
   holds the Jensen 2001 table; `subsurfacePreset(name, scale, g)` converts it to a spectral
   `Subsurface`, with `scale` mapping the paper's per-mm units into scene units.
2. **`material.ts` — spectral interior.** `Subsurface` gains optional `sigmaTSpectral`/`albedoSpectral`;
   a translucent dielectric carrying them is now `isSpectral` (so the integrator commits a hero λ at
   its boundary). Absent ⇒ the scalar 12.0 material, unchanged.
3. **`integrator.ts` — the wavelength-aware walk.** When the interior is spectral and a hero λ is
   committed, the free-flight is drawn against `σ_t(λ)` and the collision applies the scalar `ϖ(λ)`;
   otherwise the per-channel RGB walk runs exactly as before (one guarded branch, zero regression).
4. **`scenes.ts` — two showcases.** **Living Skin** (a measured-`skin2` figurine + a marble companion,
   raked from behind so the thin edges bleed red — the headline image) and **Apothecary** (a shelf of
   spheres of whole/skim milk, marble, ketchup, cream and apple, each its own measured look).
5. **`selftest.ts` — six proofs (81 total).** (a) `spectralAt` reproduces the control points, stays in
   envelope, and is flat for achromatic input; (b) every measured medium decodes to σ_t>0, ϖ∈[0,1],
   with red the deepest-penetrating for skin/marble, and `scale` linear in σ_t; (c) a chromatic
   pure-scatter furnace ≡ 1 for *any* spectral σ_t (energy conservation, the unbiasedness oracle for
   the wavelength-resolved walk); (d) a pure-absorbing slab reconstructs the **spectral Beer integral**
   `(1/Δλ)∫ w(λ)·e^(−σ_t(λ)·2r) dλ` (matched to a fine deterministic quadrature) and exits **R>G>B**
   (chromatic penetration, rendered); (e) a spectral interior with achromatic params agrees in the
   mean with the scalar 12.0 walk (the reduction oracle); (f) a measured `skin2` slab renders
   red-biased translucency end-to-end (library → conversion → spectral walk → Fresnel boundary →
   pixels).
6. **UI / About.** A "Spectral subsurface — a chromatic mean free path" card; the two scenes appear in
   the picker. Verified in Node by bundling the engine: 81/81 self-tests pass, and a smoke render of
   *Living Skin*/*Apothecary* is finite, lit and red-biased (mean RGB ≈ (4.89, 3.80, 2.88) on Living
   Skin). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-25 Lumen 14.0: importance sampling of many lights — the light BVH (claude)

Every one of Lumen's five integrators shares one quietly weak link: **which light to
next-event-estimate**. `scene.sampleLight` has, since day one, picked an emitter
**uniformly** — `rng.int(numLights)` — and folded a flat `1/numLights` selection
probability into the MIS pdf. That is fine for a Cornell box with one ceiling light.
It is catastrophic the moment a scene has *many* lights: a thousand little emitters,
and the path tracer spends 999/1000 of its shadow rays connecting to lights that are
occluded, face away, or are too far to matter, while the one light that actually
illuminates the shade point gets a one-in-a-thousand look. The image is all noise and
the fix is not "more samples" — it is **sampling the right light**.

14.0 closes that gap with the production-standard answer: **Importance Sampling of
Many Lights** via a **light BVH** (Conty Estevez & Kulla, *Importance Sampling of Many
Lights with Adaptive Tree Splitting*, 2018 — the technique now in Arnold and PBRT-v4).
A binary tree is built over the emissive triangles; each node caches its **total
power**, its **bounding box**, and a **bounding cone of emitter normals**. To pick a
light for a shade point `p`, the sampler walks the tree from the root, at each step
choosing the child in proportion to a cheap, conservative estimate of how much that
*cluster* could light `p` — `importance = power · orientation(p) / dist²(p, box)` —
accumulating the product of branch probabilities as the exact selection pdf. Near,
bright, well-oriented clusters win the lottery; far, dim, back-facing ones are almost
never chosen — so the shadow rays land where the light actually is.

The discipline of the project is preserved exactly. The light tree is a *drop-in
replacement for the light-selection step only*: `sampleLight`/`lightPdf` keep their
contract (return a direction + a solid-angle pdf that already folds in the selection
probability), so the integrator's NEE↔BSDF MIS is untouched and **every estimator
stays unbiased** — the tree only *reshapes* the variance, never the mean, so a
tree-sampled render converges to the *same image* as a uniform one. Three engineering
guarantees make that airtight: (1) the per-light selection probabilities form a proper
distribution that **sums to 1** at every `p` (it is a probability tree — normalised at
each split); (2) **every light keeps a strictly positive probability** (a floored
orientation term and a clamped distance mean no contributing light is ever excluded —
the precondition for unbiasedness); and (3) the **sampler and the pdf agree to Monte-
Carlo precision** (the same root→leaf branch probabilities drive both
`tree.sample` and `tree.prob`, exactly as the SD-tree's sampler↔pdf proof). Because
BDPT and SPPM do their own light sampling (they never call `scene.sampleLight`), they
are completely unaffected; PSSMLT inherits the win for free (it reuses the path
tracer's NEE verbatim). The uniform path is kept **byte-for-byte** intact and remains
the default, so all 70 existing proofs stay bit-for-bit green; the tree is opt-in per
render (a "Many lights (light BVH)" toggle) and is switched on for the new scenes.

Plan / steps (this session):

1. **`lighttree.ts` — the light BVH.** A new module: a top-down binary tree over the
   emissive triangles (median split on the largest centroid-extent axis), each node
   caching `bounds`, aggregate `power` (Σ luminance(emission)·area), and a **normal
   cone** (axis + cos half-angle) unioned from its children (PBRT `DirectionCone`
   math). `sample(p, rng) → {primId, prob}` does the stochastic root→leaf descent;
   `prob(p, primId)` recomputes the identical branch-probability product for the MIS
   pdf. The cluster importance is `power · orient(p) / max(dist²(p,box), minD²)`, the
   orientation a conservative cone bound floored at `ORIENT_FLOOR>0` so positivity
   (hence unbiasedness) is guaranteed.
2. **`scene.ts` — wire it in, gated.** Build the tree once in the constructor. Split
   `sampleLight`/`lightPdf` into the *verbatim* uniform path (default, `useTree=false`
   → zero regression) and a new tree path (`useTree=true`): the environment sun keeps
   its `1/numLights` slot in both modes, the triangle pool's `nTri/numLights` mass is
   distributed by the tree, so the tree **reduces to uniform** when importances are
   equal. The env pdf is unchanged, so `envSunPdf` needs no edit.
3. **`types.ts` / `integrator.ts` — the switch.** A `manyLights?: boolean` on
   `IntegratorSettings`; the path tracer reads it once and passes `useTree` to the
   three `sampleLight`/`lightPdf` call sites (so PSSMLT, which calls `radiance`, gets
   it too).
4. **`scenes.ts` — two showcase scenes.** **Star Field** — a few hundred tiny
   emissive triangles of assorted colour scattered over a dome above a diffuse floor,
   where uniform light selection is hopeless and the tree is dramatic; and **Lantern
   Hall** — a corridor of many warm lanterns where only the nearest few matter at any
   wall point.
5. **`selftest.ts` — five new proofs (75 total).** (a) the selection pdf **sums to 1**
   over all lights for random `p`; (b) **sampler↔pdf** — empirical selection
   frequencies match `tree.prob` to MC tolerance; (c) **positivity** — every light has
   `prob>0` for any `p` (unbiasedness precondition); (d) **reduction to uniform** —
   coincident equal-power lights are selected exactly `1/N` each (the tree generalises
   the uniform sampler); (e) the headline **same-image oracle + variance win** — on a
   many-lights scene the tree NEE and the uniform NEE agree in the mean (unbiased)
   while the tree's per-sample variance is strictly lower (the actual payoff).
6. **UI / About.** A "Many lights (light BVH)" toggle + an About card explaining the
   power/distance/orientation importance and why it is unbiased.

## Roadmap — 2026-06-23 Lumen 13.0: practical path guiding — the SD-tree (claude)

Lumen carried four integrators that all *fix* their sampling up front: the path tracer and BDPT
sample the BSDF and the lights; PSSMLT mutates a random stream; SPPM shoots photons. None of them
**learns**. The one thing missing was an estimator that adapts its sampling to the scene it is
actually rendering — and that is exactly **path guiding**.

The new fifth integrator implements **Practical Path Guiding** (Müller, Gross & Novák 2017). It
records, as paths are traced, the radiance each one carries into an **SD-tree**: a binary *spatial*
k-d tree over the scene, every leaf of which owns a *directional* quadtree over the sphere. The
directional tree is built on an **equal-area** sphere↔square map, so its area measure is proportional
to solid angle with a constant Jacobian — a flux-proportional quadtree is therefore a
radiance-proportional sampler with no cosine warp to undo. Both trees refine between iterations (each
renders twice the samples of the last): the **spatial** tree subdivides where many paths pass (driven
by a *visit* counter, not merely where light was luckily found — the fix that made the tree actually
grow, from 2 leaves to ~270), and the **directional** tree sharpens where a bright direction appears.
At each surface the next direction is drawn from the **mixture** `p(ω)=α·p_bsdf+(1−α)·p_guide` and
weighted by that exact density, with the NEE/emission MIS weights using the same mixture pdf so every
estimator stays consistent.

The headline property — the one the whole project is built around — is preserved: **guiding is
unbiased.** Because the guide is a real probability distribution over the sphere (its density
integrates to 1, proven in Verify) the mean is untouched for *any* learned distribution; only the
variance changes. So Guided converges to the very same image as the other four, which the **Guided ≡
path tracer** oracle confirms on the diffuse box.

Engineering that mattered to make it *help* rather than hurt: (1) **per-leaf maturity gating** — an
under-trained quadtree samples nearly uniformly, which is *worse* than cosine BSDF sampling, so a
region only guides once it has accumulated enough records (otherwise it falls back to BSDF while
still recording); (2) **visit-driven spatial subdivision** so the tree localises; (3) a **gentle
α=0.7** (only a 30 % guide nudge atop 70 % BSDF) — the learned quadtree is piecewise-constant and so
a noisy sampler, and a light touch captures the win while the BSDF majority bounds the variance, so
guiding is never meaningfully worse than plain PT. Its home turf is light NEE cannot sample: the new
**Glowing Orb** scene is lit only by an emissive *sphere* (Lumen's NEE samples only triangle lights,
so the orb is invisible to it) — blind BSDF sampling finds it ~0.5 % of the time and the path tracer
is all fireflies, while the guide learns the orb's direction per region (~9 % hit rate) and renders
it with measurably less error at equal samples.

Four new proofs (74 total): the DTree density integrates to 1 over the sphere; sampler↔pdf agree to
machine ε; importance sampling cuts a peaked directional integral's variance ~100× at matched mean;
and Guided ≡ PT on the box. Verified end to end in Node (esbuild bundle): 70/70 self-tests pass,
Guided agrees with the path tracer to <2 % on the diffuse box, and an equal-sample bench on Glowing
Orb shows the guided render reaching the reference with lower RMSE (≈1.13–1.25× depending on orb
size) and no bias. `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-23 Lumen 12.0: subsurface scattering (claude)

Lumen could render light bouncing *off* a surface (every BRDF), light *through*
clear glass (dielectrics), and light scattering in *unbounded* fog (the global
participating media). The one regime it could not render is the one most physical
objects actually live in: light that enters a solid, bounces around among
microscopic scatterers, and re-emerges somewhere else — **subsurface scattering**.
It is why marble glows, why a hand held to the sun goes red at the edges, why wax,
jade, milk and skin look *soft* in a way no surface shader can fake. A dielectric
in Lumen only did Beer–Lambert absorption inside (a straight-line attenuation); it
never *scattered* internally. 12.0 closes that gap, and does it by **reusing what
was already there** — the volume distance sampler, the Henyey–Greenstein phase
function, and the exact dielectric Fresnel/refraction interface — so the addition
is small, gated and provable, and every one of the 61 prior proofs stays green.

Why it slots in cleanly: random-walk subsurface scattering *is* volumetric path
tracing, but bounded by the object's surface instead of a fog sphere, and entered
only by refracting through a Fresnel boundary. The path already tracks which
dielectric it is "inside" (for Beer–Lambert); 12.0 lets that interior be a
*scattering* medium and runs the same homogeneous free-flight the global media use
— collision ⇒ β ×= albedo + phase-sample; no collision ⇒ reach the boundary with
weight 1 and let the surface BSDF refract it out or trap it by TIR. Nothing else
in the transport loop changes.

Plan / steps (all shipped this session):

1. **`material.ts` — a `Subsurface { sigmaT, albedo, g }` interior.** Added an
   optional `interior` field to the dielectric. Present ⇒ translucent solid;
   absent ⇒ ordinary glass. `resolveMaterial` already spreads the dielectric, so
   dispersion + subsurface compose; `isDelta`/`isSpectral` unchanged.
2. **`integrator.ts` — the interior random walk.** A new `sss` path-state variable,
   set/cleared on the dielectric transmission event (mirroring the existing
   Beer–Lambert `medium` toggle). While non-null, a homogeneous free-flight runs
   *before* surface shading: a real collision scatters via `sampleHG` (β ×= albedo,
   the absorbed fraction 1−albedo darkening with depth); no collision falls through
   to shade the boundary with unit weight. Phase-only, no interior NEE — flagged so
   the eventual exit-to-light is MIS-counted in full. The global-media block is
   gated `&& !sss` so the two estimators never both fire.
3. **`scenes.ts` — two showcase scenes.** **Subsurface Studio** (back-lit marble/
   jade/honey-wax/rose spheres) and **Jade Idol** (a watertight surface-of-
   revolution lathe in jade). A `translucent()` builder keeps `tint` white so the
   colour comes purely from the interior albedo.
4. **`selftest.ts` — five proofs** (a shared `subsurfaceFurnaceRGB` harness):
   pure-scatter furnace ≡ 1 ∀g (zero-variance energy conservation + unbiased phase
   walk); pure-absorb ≡ e^(−σ·2r) (Beer's law from the free-flight); the whole
   object (Fresnel + TIR + scatter) ≡ 1; per-channel albedo tints R>G>B, bounded ≤1;
   and reflectance strictly monotone in the interior albedo (0.3→0.6→0.9, ≤1).

Next (open): subsurface NEE through the boundary (importance-sample a light *and*
the refraction toward it) to denoise the glow; a separable BSSRDF / diffusion
dipole fast-path for highly scattering media that the random walk samples poorly at
low depth; spectral (per-channel σ_t) interiors via the hero-wavelength machinery,
so the *mean free path* — not just the albedo — varies with colour (true skin);
and volumetric SSS in the photon mapper for inner caustics.

## Roadmap — 2026-06-21 Lumen 11.0: real metals from measured complex IOR (claude)

10.0 made Lumen's *surfaces* as rigorous as its transport — but it left one
asymmetry standing. Every "metal" was still tinted by an RGB `albedo` fed into the
**Schlick** Fresnel approximation as F0. That is convenient and wrong: a real
conductor's colour is not a pigment, it is a **spectral reflectance** R(λ) fixed by
its complex refractive index `n̄(λ) = η(λ) − i·k(λ)`. That spectral shape is exactly
what makes gold warm, copper red, silver brilliant-neutral and aluminium faintly
blue — and Schlick-from-RGB can fake the colour head-on but gets the *angular*
desaturation wrong and can never reproduce the hue shift toward the horizon. 11.0
closes that last gap: metals are now driven by **measured η/k spectra** and the
**exact unpolarised conductor Fresnel**, reusing the hero-wavelength machinery that
already disperses glass — so the additions are small, gated and provable, and every
one of the 55 existing proofs stays bit-for-bit green.

Why this slots in cleanly: a path that strikes a *spectral* surface already commits
one **hero wavelength** and scales β by the white-point-normalised RGB weight
(`wavelengthWeight`, with `E_λ[weight]=(1,1,1)`). A spectral metal joins that club:
at the committed λ the conductor reflects a single *scalar* fraction `R(λ,θ)`, so the
lobe shades grey and the metal's colour reconstructs over wavelengths — exactly as a
prism's rainbow does. Nothing in the transport loop changes; only the Fresnel does.

Plan / steps (all shipped this session):

1. **`conductor.ts`** — measured complex refractive index η(λ),k(λ) for six metals
   (gold/silver/copper — Johnson & Christy 1972; aluminium — Rakić 1998; iron &
   chromium — handbook), sampled across 400–700 nm and linearly interpolated. The
   **exact unpolarised conductor Fresnel** `fresnelConductor(cosθ,η,k)` (PBRT's
   `FrComplex`, real-valued s+p average); the cosine-weighted hemispherical average
   `conductorAverageFresnel` (no closed form for a complex index, so integrated) for
   Kulla–Conty; and a band-integrated `conductorF0RGB(name)` (the RGB a head-on
   spectral path converges to) for the denoiser guide and the achromatic fallback.
2. **`material.ts` — a shared `FresnelSpec`.** Every microfacet lobe used to call
   `fresnelSchlick(cos, f0)` directly. They now route through `fresnelSpec(cos, fr)`
   where `fr` is *either* `{f0}` (Schlick) *or* `{eta,k,favg}` (a baked conductor),
   so a metal can be spectral, anisotropic and multiscatter-compensated at once and
   no lobe ever branches on which Fresnel it carries. `metalMsFLocal` takes the spec
   and uses the matching hemispherical average, so spectral metals are energy-
   compensated correctly. Non-spectral metals hit the identical Schlick path →
   bit-for-bit unchanged.
3. **The metal material gains `spectrum?: ConductorName`** (public, scene-facing) and
   an internal baked `cond?: {eta,k,favg}`. `isSpectral` is true for a spectrum
   metal, so the integrator commits a hero wavelength on first contact;
   `resolveMaterial` bakes (η,k) + the average at that λ. At λ=0 (the achromatic BDPT
   path) `cond` is left unset and the lobe falls back to Schlick(albedo), where
   `albedo = conductorF0RGB(name)` already carries the right colour — so BDPT and the
   denoiser stay sensible without spectral support.
4. **Scene — Metals of the World.** The six conductors as a front row of glossy
   spheres under the Preetham sky (warm sun + broad skylight reveal each hue), with a
   back row composing the new Fresnel with the *other* upgrades: brushed (anisotropic)
   gold, multiscatter-compensated rough copper, a smooth silver mirror.
5. **UI / About.** A "Real metals (complex IOR)" card explaining n̄=η−ik, the
   hero-wavelength reconstruction and the angular desaturation Schlick misses.
6. **Six proofs (61 total).** (a) conductor Fresnel R∈[0,1] for every metal/λ/angle
   and →1 at grazing; (b) the **k→0 limit reduces exactly to the dielectric Fresnel**
   (max error < 1e-9 — the complex formula pinned against the real one); (c) the
   measured spectra reproduce the **textbook colours** (Au/Cu warm with R>G>B, Ag/Al
   bright-neutral, Fe/Cr flat grey — a guard against η/k transcription slips that the
   energy tests would miss); (d) the **headline white-point oracle** — a smooth gold
   sphere rendered with the hero-wavelength path tracer in a unit furnace reconstructs
   `conductorF0RGB('gold')` to <0.02 per channel (η/k → hero λ → wavelengthWeight →
   image, end to end); (e) **MIS consistency** — after `resolveMaterial` bakes (η,k),
   the rough conductor's sampler↔pdf agree (<1e-5) and weight == f·cosθ/pdf (<1e-4),
   for the plain GGX *and* the multiscatter lobe; (f) **spectral multiscatter energy**
   — a rough gold lobe with compensation reflects more than single-scatter yet never
   exceeds its hemispherical-average reflectance F̄ (restored, not invented). Verified
   in Node by bundling the engine: 61/61 self-tests + a Metals smoke render (all
   finite, lit, chromatic). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-20 Lumen 10.0: a physically based material system (claude)

For nine versions Lumen poured enormous rigour into *light transport* — four
integrators that provably agree, spectral and daylight photons, null-collision
volumetrics — while the **surfaces** stayed deliberately small: Lambert, a
single-scatter GGX metal, dielectric glass, a thin film. That asymmetry showed:
a rough gold sphere went *grey* (single-scatter GGX drops the energy that should
bounce between microfacets), every metal highlight was an isotropic blob, matte
clay looked like plastic, and there was no glazed/ceramic/car-paint look at all.
10.0 closes the gap with a proper material system, built so each new lobe is as
provably correct as the transport that carries it.

**1 — Energy-conserving rough metal (Kulla–Conty multiscatter).** A single-scatter
microfacet lobe reflects only `E(μ,α)` of the incident energy (the rest would
have taken a second, third… bounce between microfacets and is simply dropped), so
conductors darken and desaturate as they roughen. We Monte-Carlo–integrate the
GGX *directional albedo* `E(μ,α)` (and its hemisphere average `Eavg(α)`) into a
32×32 table **once at start-up** — reusing the fact that the VNDF throughput for a
white lobe is exactly `G2/G1`, so the table is the very quantity the furnace test
measures — then add a compensation lobe
`f_ms = F_ms·(1−E(μₒ))(1−E(μᵢ)) / (π(1−Eavg))` that integrates to exactly the
missing `(1−E(μₒ))`. A coloured multiscatter Fresnel
`F_ms = Favg²·Eavg/(1−Favg(1−Eavg))` keeps saturated metals saturated. The result
is energy-exact for white (furnace ≈ 1) and a `multiscatter` flag on the metal
material turns it on. **Verify** proves a white rough conductor reflects ≈1 with
compensation and noticeably less without.

**2 — Anisotropic GGX (brushed/milled metal).** Generalised the distribution,
Smith masking and VNDF sampler to two roughness axes `(αₓ,α_y)` (Disney's
`aspect = √(1−0.9·aniso)`) expressed in a tangent frame the material can rotate
(`anisoAngle`). The isotropic case reduces to the old formulae *exactly*
(verified algebraically and numerically), so existing metals are untouched. The
half-vector reflection keeps `wo·h = wi·h`, so the BRDF is exactly reciprocal —
proven, alongside an energy bound and a measurable pdf "streak" between the two
tangent axes.

**3 — Oren–Nayar rough diffuse.** The reciprocal qualitative Oren–Nayar model
(`sigma`) for chalk, clay, plaster and lunar regolith — surfaces whose microscopic
roughness makes them flatten and back-scatter toward the light. Reduces to Lambert
at σ=0; proven reciprocal and proven to exceed Lambert in the grazing
retro-reflection regime where its `B` term lives.

**4 — Clear-coat layered materials.** Glazed ceramic, lacquer and car paint: a
clear GGX *dielectric coat* over a Lambert/Oren–Nayar base. The coat reflects a
Fresnel fraction as a gloss lobe and transmits the rest to the base, attenuated by
`(1−F(μₒ))(1−F(μᵢ))` so the stack conserves energy and stays reciprocal. The coat
and base lobes are sampled stochastically by a Fresnel-driven probability with a
*combined* pdf, so the material is MIS-consistent — it matches BDPT pixel-for-pixel.

**Plumbing & proofs.** All four are added without a single new `Material` *kind*
— they ride as optional fields on `diffuse`/`metal`, so the integrators' switches
and BDPT/SPPM are untouched; the shared local-frame helpers
(`ggxReflectFLocal`/`…PdfLocal`, anisotropic variants, `metalMsFLocal`,
`diffuseLayeredFLocal`) guarantee `sample`/`eval`/`pdf` can never drift apart.
Three showcase scenes — **Brushed Metal**, **Rough Conductors** (a single-scatter
vs multiscatter split), **Ceramics & Clay** — and **six** new proofs (GGX albedo
table monotonicity, multiscatter energy restoration, anisotropic reciprocity +
streak, Oren–Nayar reciprocity + grazing, clear-coat reciprocity + gloss + energy)
plus a **BDPT≡PT oracle** over a box of all four materials. Verified in Node by
bundling the engine and running all **55** self-tests (55/55) + a render smoke
test of the three new scenes (no NaNs, all lit); `pnpm lint`/`tsc`/`build` green
via the CI gate.

## Roadmap — 2026-06-20 Lumen 9.0: heterogeneous participating media — clouds, smoke & fog via delta/ratio tracking (claude)

Lumen 4.0 made the *space between surfaces* physical, but only as **homogeneous**
volumes: a medium was a sphere of *constant* extinction, so every "cloud" was a
uniformly-foggy ball. Real clouds, smoke and ground fog are **heterogeneous** —
their density varies continuously through space — and the unbiased way to trace
light through a varying extinction field is the **null-collision** family of
estimators (Woodcock 1965; Novák et al. 2014). 9.0 adds exactly that: a
procedural 3D density field per medium, **delta tracking** for the free-flight
distance sampler, and **ratio tracking** for the shadow-ray transmittance. The
homogeneous path is untouched (a medium with no `density` field stays analytic),
and because both estimators are unbiased the existing energy-conservation and
transmittance oracles extend to the heterogeneous case as the headline proofs.

Why null-collision tracking is the right tool: you cannot invert the CDF of a
free flight `e^{−∫σ_t ds}` when `σ_t` varies arbitrarily. Delta tracking instead
adds a fictitious "null" collider so the *total* extinction is a constant
majorant `σ̄ ≥ max σ_t`; you sample analytic exponential flights against `σ̄`, and
at each tentative collision flip a coin — a **real** scatter with probability
`σ_t(x)/σ̄`, else a **null** event (continue, unperturbed). The real-collision
distribution is then *exactly* the heterogeneous free-flight law, with no bias
and no integral to evaluate. Ratio tracking is its transmittance cousin: walk
the same majorant flights and multiply by `(1 − σ_t(x)/σ̄)` at each tentative
collision; its expectation is `e^{−∫σ_t ds}` for *any* field — an unbiased
shadow-ray estimator that needed no closed form.

Plan / steps (all to ship this session):

1. **`noise.ts`** — a dependency-free 3D value-noise generator (hashed integer
   lattice, quintic-smoothstep trilinear interpolation) plus fractional Brownian
   motion (`fbm3`, octave sum) and a domain-warp helper for billowy structure.
   Deterministic and allocation-free in the hot loop. (Self-test: bounded,
   continuous, deterministic, ≈zero-mean.)
2. **`MediumDef.density`** (types.ts) — an optional, structured-clone-friendly
   `DensityDef` union: `{kind:'fbm', …}` (cumulus / smoke, with octaves,
   frequency, lacunarity, gain, coverage threshold, a soft spherical edge
   falloff, a vertical density bias and a domain-warp amount) and
   `{kind:'layer', …}` (an exponential vertical fog layer with noise lumpiness).
   Absent ⇒ homogeneous (the 4.0 behaviour, bit-for-bit).
3. **`volume.ts`** — a `DensityField` (`{ majorant; density(p) ∈ [0,1] }`) and
   `makeDensityField(medium)` that compiles a `DensityDef` into an evaluator
   closure bounded by the medium sphere. The field returns a *normalised* density
   in [0,1]; the medium's `sigmaT` is the majorant extinction.
4. **Scene** — precompute `fields[]` parallel to `media[]`; rewrite
   `sampleMediumScatter` to **delta-track** heterogeneous media (analytic
   exponential for homogeneous) and `mediaTransmittance(…, rng)` to **ratio-track**
   them (analytic for homogeneous). Disjoint-media assumption preserved (nearest
   real collision wins).
5. **Integrator** — thread `rng` into the two `mediaTransmittance` calls (the only
   change; the collision branch already multiplies β by the albedo, which is the
   correct delta-tracking real-collision weight, and the camera path still needs
   no transmittance multiply because null collisions leave β unchanged).
6. **Scenes (`scenes.ts`)** — three showcases: **Cumulus** (a sunlit FBM cloud
   under the Preetham sky — forward-scattering silver lining + soft self-shadowing),
   **Smoke Plume** (a rising, dark, vertically-biased FBM column lit from the side),
   **Drifting Fog** (a low exponential ground-fog layer in a colonnade, so the
   skylight breaks into god-rays grazing the fog top). Registered `fog: true`.
7. **UI** — the existing fog-density knob already scales `sigmaT` (= the majorant),
   so it works unchanged; add a **Cloud coverage** control that remaps the FBM
   threshold for heterogeneous scenes, and an About card explaining delta/ratio
   tracking.
8. **Proofs (5 new, 48 total) (`selftest.ts`)** — (a) the noise field is bounded,
   continuous, deterministic and ≈zero-mean; (b) **delta tracking with a constant
   (=1) field reproduces `e^{−σ_t L}`** — the heterogeneous free-flight sampler
   collapses to Beer's law (unbiasedness oracle, mirrors test 24); (c) **ratio
   tracking is an unbiased transmittance estimator** — `E[T̂] = e^{−σ_t L}` for a
   constant field; (d) **ratio tracking matches a genuinely varying analytic
   optical depth** — a `layer` field's transmittance vs a fine deterministic
   quadrature of `∫σ_t ds`; (e) **a heterogeneous pure-scattering volume conserves
   energy** — an FBM medium with albedo 1 in a uniform unit field is still
   invisible (radiance through = 1), the strongest end-to-end oracle for the whole
   delta-tracking integrator.

## Roadmap — 2026-06-19 Lumen 8.0: a spectral, daylight-complete photon mapper (claude)

Lumen 7.0 gave the renderer a fourth integrator — stochastic progressive photon
mapping (SPPM) — built for the one transport the camera-side integrators can't
touch: the **caustic** (a light→specular→diffuse path). But that first photon
mapper was deliberately narrow: it traced photons **achromatically** (so a
caustic through *dispersive* glass came out white, throwing away the rainbow the
path tracer already shows for direct views of a prism), and it emitted photons
**only from the emissive triangles** (so a *daylight* scene — lit by the sun, a
light at infinity — got no photon-mapped caustics at all, because the sun was
never a photon source). 8.0 closes both gaps. The photon mapper is now **colour-
complete** and **daylight-complete**, and it reuses the existing engine
verbatim — the wavelength machinery from the path tracer and the sun model from
next-event estimation — so the additions are small, surgical, and provable.

The plan, all shipped this session:

1. **Spectral photons (`sppm.ts`).** A photon walk now tracks a committed hero
   wavelength exactly as the path tracer does: the first time a photon strikes a
   *spectral* surface (`isSpectral` — dispersive glass or a thin film), it draws a
   uniform wavelength in [380,720] nm and multiplies its flux by that wavelength's
   white-point-normalised RGB weight (`wavelengthWeight`). From then on the
   dielectric's IOR is resolved at that wavelength (`resolveMaterial(.,.,λ)`), so
   blue photons refract more sharply than red and the caustic on the floor fans
   into a spectrum. Because `E_λ[weight] = (1,1,1)`, the *total* deposited energy
   is unchanged — dispersion only spreads it across colour and space — so the
   image stays unbiased. The camera pass commits a wavelength symmetrically, so a
   prism viewed *directly* under SPPM disperses just as it does under PT.

2. **Environment / sun photon emission (`sppm.ts`).** The scene's sun — a
   daylight-gradient sun or a Preetham sky sun, already exposed by `scene.envSun`
   for NEE — joins the photon-source pool. A sun photon is launched by (a) sampling
   a direction toward the sun uniformly in its cone (the exact sampler NEE uses),
   (b) reading the radiance there, and (c) emitting from a uniformly sampled point
   on a disc of radius R (the scene's bounding-sphere radius) one radius out along
   that direction, travelling into the scene as a parallel beam. The per-photon
   flux is derived from the disc-area pdf 1/(πR²) and the cone pdf 1/Ω, and the
   selection weight is the sun's luminous power lum(L_rep)·πR²·Ω, so the πR²·Ω
   geometry **cancels** and the photon flux is `S = L·ΣW/lum(L_rep)` — exactly
   parallel to the triangle case `Le·π·ΣW/lum(Le)`, and unbiased for any choice of
   R. The sun shares the same per-pass photon budget and `N_emit` normaliser as the
   triangle lights, so no other code changes.

3. **Two showcase scenes (`scenes.ts`).** **Spectral Caustic** — a dense,
   dispersive glass sphere and a glass prism over a white catch-floor in a dark
   room, lit by one small panel: under Photon Map the focused caustic is a
   *rainbow*. **Daylight Lens** — a glass sphere and a gold torus on a tiled floor
   under the Preetham sky: the sun, refracted through the glass, focuses a caustic
   on the floor that *only* environment photons resolve (a distant-light
   light→specular→diffuse path NEE can't connect through the lens).

4. **Four new proofs (43 total) (`selftest.ts`).** (a) **Spectral photons conserve
   energy** — a dispersive caustic box rendered with spectral photons ON vs OFF
   agrees on total image energy to ~0.2% (the white-point/normalisation oracle for
   the hero-wavelength photon walk). (b) **The spectral caustic is coloured** — its
   chromatic spread (range of (R−B)/luminance) is large while the achromatic twin
   is exactly grey. (c) **Env-sun photons ≡ the path tracer** — a sun-lit diffuse
   courtyard under SPPM (sun photons) matches PT (sun NEE) in mean brightness to
   ~2.5%, pinning the distant-light flux normalisation. (d) **Env photons resolve a
   daylight caustic** — the sun focuses a spot through a glass sphere measurably
   brighter (≈8.7×) than the directly-lit floor. Verified in Node by bundling the
   engine with Vite: 43/43 self-tests, plus a smoke render of both new scenes
   (all-finite, energetic, with hundreds of chromatic caustic pixels). `pnpm
   lint`/`tsc`/`build` green via the CI gate.

The flux algebra that makes the sun unbiased *for free* is the nicest part: the
distant-light geometry (disc area πR², cone solid angle Ω) appears in both the
photon flux and the selection weight, so it cancels to leave a formula that is the
literal twin of the area-light one — a single code path for "radiance · π · ΣW /
luminance" emits both a lamp and a star correctly.

## Roadmap — 2026-06-16 Lumen 7.0: stochastic progressive photon mapping (SPPM) (claude)

Lumen had three integrators that all *grow paths ending on a light* (PT, BDPT,
PSSMLT). They share one blind spot: the **caustic** — light focused through a
lens/glass onto a diffuse surface, the camera seeing a light→specular→diffuse
(SDS) path. Next-event estimation is useless there (a shadow ray to the lamp
won't refract through the glass, so the light has measure zero), and a diffuse
bounce that threads the lens by luck is astronomically rare — so caustics are
the textbook slow case for all three. 7.0 adds a *fourth* integrator whose whole
job is exactly that transport, by running the light transport **backwards**.

The plan, all shipped this session:

1. **Photons from the lights (`sppm.ts`).** Emit photons from the emissive
   triangles, chosen in proportion to their power so every photon carries equal
   flux `Le·π·Σpower/lum(Le)`; trace them through the scene (reusing
   `Scene.intersect` + the `Material` BSDFs + Beer–Lambert medium tracking
   verbatim), and at every non-specular surface **deposit** them into the nearby
   measurement points. Specular surfaces just refract/reflect — so a photon that
   goes light→glass→floor lands a caustic by *construction*.
2. **Per-pixel measurement points + the progressive radius.** Each pass re-traces
   *jittered* camera rays (Hachisuka & Jensen's *stochastic* PPM — this
   anti-aliases and captures glossy/DoF visible points), follows specular bounces,
   and stores the first non-specular hit as that pixel's measurement point. The
   gathered flux `τ`, photon count `N` and squared radius `R²` persist across
   passes and update on the Hachisuka schedule `N←N+αM`, `R²←R²·(N+αM)/(N+M)`,
   `τ←(τ+Σf·ΔΦ)·R²_new/R²` — which provably drives the density-estimation bias to
   zero, so the estimate **converges** to the true rendering-equation solution.
   Directly-seen emission (incl. through specular glass) is added on the camera
   path; the radiance is `emission/passes + τ/(N_emitted·π·R²)`.
3. **Exact gather via a spatial hash (`HashGrid`).** Each measurement point is
   inserted (CSR-packed in typed arrays, zero per-pass allocation in the hot loop)
   into every grid cell its gather sphere overlaps, so a photon need only probe its
   own cell to find *every* point whose radius could reach it. Hash collisions only
   add a few distance tests — never a miss.
4. **Wiring.** SPPM is a *full-frame estimator* like PSSMLT, so the worker and
   renderer were generalised behind a small `FrameEstimator` interface: each worker
   runs an independent full-frame SPPM and the UI averages the workers' estimates
   weighted by passes. A fourth **Integrator** option ("Photon Map"), the progress
   readout reads "Passes", an About card, the footer.
5. **A showcase scene — Caustic Pool.** A wind-rippled water surface built as a
   sine heightfield with *analytic* smooth normals (a single refractive sheet),
   over a tiled floor lit by an overhead panel: light refracting through the
   undulating surface focuses into the shifting bright filaments of a swimming
   pool — the canonical SDS caustic, which now resolves cleanly under SPPM.
6. **Proofs (3 new, 39 total).** The headline: **SPPM converges to the same image
   as the path tracer** on the diffuse Cornell box (global brightness + top/bottom
   spatial ratio) — a stringent, independent check of the photon-power
   normalisation and the radius/flux update, since SPPM shares no transport-loop
   code with PT. Plus: SPPM resolves a finite, focused caustic (the floor under a
   glass lens is brighter than the unfocused floor); and the photon-gather grid
   returns *exactly* the in-radius points vs brute force over 2000 random probes.
   Verified in Node: 39/39 self-tests, and a Caustic-Pool SPPM smoke render
   (7210 tris, all finite, bright caustic filaments). `pnpm lint`/`tsc`/`build`
   green via the CI gate.

## Roadmap — 2026-06-16 Lumen 6.0: Metropolis light transport (PSSMLT) (claude)

Lumen 5.0 added a *second* way to grow paths (BDPT). 6.0 adds a fundamentally
different *kind* of estimator. PT and BDPT are both **independent-sample** Monte
Carlo: every sample is drawn from scratch, so when the light that matters is hard
to find (a thin caustic, a room lit only by bounce), almost every sample misses
and the image is noisy. **Markov-chain Monte Carlo** flips this: once the chain
finds an important light path it *stays near it*, exploring the neighbourhood by
mutation, so the hard transport — once discovered — gets sampled densely.

The plan, all shipped this session:

1. **The key reframing.** A path tracer is a deterministic function `F: [0,1)^d →
   radiance`: feed it `d` uniform random numbers and it returns a colour. PSSMLT
   (Kelemen et al. 2002) runs a Metropolis–Hastings chain *over that input
   vector*, with the target density = `I = luminance(F(U))`. So we never touch the
   transport code — we only change *where the random numbers come from*.
2. **`PssmltSampler extends Rng`.** Because the whole engine pulls randomness
   through `Rng.next()`, a sampler subclass that overrides `next()` to return
   coordinates of a mutatable primary-sample-space vector makes every existing
   BSDF/light/phase/spectral routine work *unchanged* under Metropolis. Kelemen's
   lazy mutation (per-coordinate "modify times", large/small steps, wrapped
   Gaussian perturbations, accept/reject backup-restore) keeps the dimension count
   dynamic and the proposal symmetric.
3. **`MltState`.** Owns the splat buffer + the chains. A **bootstrap** of uniform
   samples estimates the image brightness `b = E[I]` (which re-establishes absolute
   scale the chain can't know) and seeds the chains in proportion to contribution
   (no startup bias). Each mutation does **expected-value splatting** (`L/I`
   weighted by the accept probability at both the proposed and current pixels) and
   accepts with `min(1, I′/I)`. `image()` reads back `splat · b·nPixels/mutations`.
4. **Parallel chains.** Each worker runs its own independent chains over the
   *whole* image (not a band) and ships its normalised estimate every pass; the UI
   thread shows the mutation-weighted average of the workers' estimates (each is
   independently unbiased, so the average is too). A single-thread fallback drives
   one `MltState` for the sandboxed thumbnail.
5. **UI.** A third **Integrator** option ("Metropolis"); the sample target now
   reads as mutations-per-pixel; an About card; the footer.
6. **Proofs (3 new, 36 total).** The Metropolis sampler is a valid uniform sampler
   (mean ½, var 1/12) and deterministic; PSSMLT energy-conserves on a white
   furnace; and — the headline — PSSMLT converges to the **same image** as the
   path tracer on the Cornell box, checked on both global brightness *and* the
   top/bottom spatial ratio. Verified in Node: 36/36 self-tests, and a 14-scene
   PSSMLT smoke render (no NaNs; image-mean == b on every scene, incl. spectral,
   volumetric and thin-film). `pnpm lint`/`tsc`/`build` green via the CI gate.

## Roadmap — 2026-06-15 Lumen 5.0: bidirectional path tracing (claude)

Lumen 4.0 made the *space between* surfaces physical. 5.0 attacks the last and
hardest gap in the *transport algorithm itself*. So far Lumen has been a pure
**unidirectional** path tracer: it only ever grows paths from the camera and
finds light by next-event estimation. That estimator is provably correct but
becomes badly inefficient whenever the light that matters is *hard to reach from
the surfaces you can see* — light bounced off a wall (indirect-only rooms),
emitters tucked inside fixtures, glossy interreflection. **Bidirectional path
tracing (BDPT)** — the Veach–Guibas algorithm — fixes this by also growing a
path *from a light* and then **connecting** every camera-path vertex to every
light-path vertex, weighting all the resulting sampling techniques together with
**multiple importance sampling (balance heuristic)** so the best technique for
each light-transport regime dominates automatically.

The headline is that BDPT has a *built-in correctness oracle*: it is an unbiased
estimator of the **same** rendering equation as the existing path tracer, so the
two must converge to the **same image**. The verification suite exploits this
directly — it renders a box scene with both integrators at high sample counts
and asserts their means agree to within Monte-Carlo error. That is a far
stronger proof than any single invariant.

**Design decision (why it fits the architecture).** The render is a pool of
workers, each owning a *band* of the image and computing every pixel
independently. Full BDPT's `t = 1` "light-tracing" strategy splats a light-path
vertex onto an *arbitrary* pixel, which would need a shared full-frame buffer and
a new worker protocol. Instead Lumen implements **BDPT without light tracing**
(camera-subpath length `t ≥ 2`): every connection contributes to the *current*
pixel, so it drops into the existing band-worker model with **zero protocol
changes**. Marking the camera (lens) vertex as a delta endpoint removes the
`t = 1` technique from the MIS partition as well, keeping every remaining
technique's weights a valid partition of unity — so the estimator stays unbiased
and still matches the path tracer (the only paths lost are those reachable
*solely* by light tracing, e.g. a caustic seen directly, which neither this nor
plain NEE captures well anyway). It also sidesteps the error-prone
camera-importance `Wₑ` math entirely: the camera vertex's own densities provably
never enter the MIS sum for `t ≥ 2`, so the primary ray simply carries weight 1
exactly as the path tracer's does.

Plan / steps:

- [x] `bdpt.ts` — a self-contained bidirectional integrator behind the same
      `(scene, ray, settings, rng, stats, gbuf)` contract as `radiance`:
  - [x] a `Vertex` record (position, geometric + shading normals, throughput β,
        forward/reverse **area-measure** pdfs, delta flag, resolved material),
  - [x] `randomWalk` shared by both subpaths — converts each bounce's directional
        pdf to an area density at the next vertex and back-fills the previous
        vertex's reverse density (the bookkeeping the MIS recurrence needs),
  - [x] a camera subpath (eye vertex marked delta, primary β = 1) and a light
        subpath (emitter point + cosine-emission direction, β = Lₑ·cos/(p·p·p)),
  - [x] the geometry term `G` (both cosines, inverse-square, visibility) and the
        solid-angle→area density conversion,
  - [x] `connect(s,t)` for every strategy: `s=0` (camera path hits an emitter),
        `s=1` (connect to a freshly sampled light point ≡ NEE), and the general
        `s≥2` vertex-to-vertex connection, each through delta vertices correctly
        (skipped, never connected),
  - [x] `misWeight(s,t)` — a faithful port of the pbrt balance-heuristic
        recurrence with the four connection-time reverse-density overrides,
        restored after each connection.
- [x] Triangle-only light sampling for BDPT (`bdptSampleLight`) consistent with
      the light-subpath emitter selection, so `s=0/1/≥2` share one MIS partition;
      the environment is gathered on camera escape (weight 1, unbiased).
- [x] `integrate(...)` dispatcher in `integrator.ts`; `IntegratorSettings.integrator`
      (`'pt' | 'bdpt'`); worker + single-thread fallback both route through it.
- [x] UI — an **Integrator** segmented control (Path Tracer | Bidirectional) in
      the Sampling panel, threaded through `ControlState`, the render key, and
      `setSettings`; an About card explaining BDPT and the oracle.
- [x] New scene — **Cove** (an uplight bouncing off the ceiling; the room is lit
      almost entirely by indirect light — the textbook case where BDPT crushes
      the path tracer's variance), registered in `SCENES`.
- [x] Verification — four new proofs: BDPT white-furnace energy conservation;
      **BDPT mean == path-tracer mean** on a diffuse box (the oracle);
      MIS technique weights sum to 1 over a fixed path; solid-angle→area density
      conversion round-trip.

## Roadmap — 2026-06-15 Lumen 4.0: participating media, thin-film iridescence & QMC (claude)

Lumen 3.0 made the *geometry* and the *sky* physical. 4.0 makes the **space between
surfaces** physical and adds a **wave-optics** material — the two largest gaps left in a
"physically based" renderer that so far only transported light along vacuum segments and
modelled reflection as pure ray optics. Three headline additions, each wired through the
engine, the worker protocol (`SceneDef` is structured-clone-serialised, so every new field
is plain data), the verification suite, the scene registry, and the UI:

1. **Participating media** (`phase.ts`, `MediumDef`, integrator + scene) — bounded
   homogeneous volumes (fog, smoke, clouds, milky jade). The integrator samples a free-flight
   distance from the medium's transmittance; if a collision falls before the next surface the
   path *scatters* inside the volume: it next-event-estimates the lights through the
   **Henyey–Greenstein** phase function (with phase↔light MIS and media-attenuated shadow
   rays, so light shafts and volumetric shadows — "god rays" — emerge), then importance-samples
   a new direction from the same phase function. A scalar extinction with a coloured
   single-scattering albedo keeps the distance estimator unbiased with no spectral MIS, and the
   analytic boundary weights cancel so surfaces seen *through* a volume need no explicit
   transmittance multiply on the camera path. Shadow rays from ordinary surfaces are attenuated
   by the media too, so fog darkens the room, not just the volume.

2. **Thin-film interference** (`thinfilm.ts`, a new `Material` kind) — the iridescent colour of
   soap bubbles, oil on water, anodised titanium and beetle shells, which is *wave optics*, not a
   pigment: two reflections (off the top and bottom of a nm-thin film) interfere, and the path
   difference `δ = 4π n₁ d cosθ₁ / λ` makes the reflectance a function of wavelength. We evaluate
   the exact two-interface **Airy reflectance** per polarisation at the path's committed hero
   wavelength, so the existing spectral machinery turns per-λ reflectance into a full iridescent
   colour for free — a delta-specular coating that fans white light into interference colours the
   way the prism fans it into a rainbow.

3. **Low-discrepancy primary sampling** (`qmc.ts`) — the camera sub-pixel jitter and the lens
   (depth-of-field) disk now come from a **scrambled Halton** sequence with a per-pixel
   **Cranley–Patterson rotation** instead of white-noise `rng.next()`. Low-discrepancy points
   cover the pixel footprint far more evenly, so anti-aliasing and bokeh converge visibly faster
   for the same sample count, while every deeper bounce keeps its decorrelated pseudo-random
   stream (so global illumination is unbiased).

Plan / steps:

- [x] `phase.ts` — Henyey–Greenstein phase value + importance sampler (PBRT `wo`-convention),
      with normalisation, sampler↔pdf and mean-cosine proofs.
- [x] `MediumDef` on `SceneDef`; `Scene` builds the medium list and exposes
      `sampleMediumScatter` (nearest free-flight collision across bounded spheres) and
      `mediaTransmittance` (optical depth along a shadow segment).
- [x] Integrator: medium-scatter branch (albedo throughput, phase NEE + MIS, phase sampling),
      plus media-attenuated surface NEE. Surfaces seen through a volume keep weight 1 (analytic
      cancellation).
- [x] `thinfilm.ts` — two-interface Airy reflectance (s+p averaged); a `thinfilm` `Material`
      resolved to the hero wavelength; delta-specular BSDF; `isDelta`/`resolveMaterial` updated.
- [x] `qmc.ts` — radical-inverse Halton/Sobol + scramble + Cranley–Patterson; camera + worker
      wired to draw the primary 4 dimensions (pixel x/y, lens x/y) from it.
- [x] New scenes — **Cathedral** (god rays through haze), **Iridescence** (a thin-film thickness
      sweep), **Nebula** (a coloured scattering orb beside an iridescent sphere).
- [x] UI — a fog-density control for volumetric scenes; About cards for media, thin-film and QMC.
- [x] Verification — HG normalisation / sampler↔pdf / mean-cosine; homogeneous transmittance =
      e^(−σ_t·L); pure-scattering volume conserves energy (radiance = 1 in a unit field);
      absorbing volume = e^(−σ_t·chord); thin-film R∈[0,1], d→0 collapses to the bare-interface
      Fresnel, and R(blue)≠R(red) (iridescence); Halton L2-discrepancy below random.

## Roadmap — 2026-06-14 Lumen 3.0: meshes, sky & sun NEE (claude)

This pass turns Lumen from a sphere-and-flat-triangle tracer into a real geometry
+ daylight renderer. Each step is wired through the engine, the worker protocol, the
scene registry, the verification suite, and the UI so it is observable and proven:

1. **Smooth shading normals** — the triangle primitive carries optional per-vertex
   normals; `intersectTriangle` returns barycentrics; `Scene.intersect` blends them
   into a shading normal oriented to the geometric hemisphere (the geometric normal
   still drives ray-offsets and front-face). Curved surfaces from flat triangles.
2. **Mesh library** (`mesh.ts`) — indexed generators with exact/area-weighted
   normals (icosphere via recursive subdivision, UV-sphere, torus, surface-of-
   revolution) plus an affine transform (translate/scale/rotate; normals by the
   inverse-transpose) and a triangle-soup emitter into `PrimDef`s.
3. **OBJ importer** (`obj.ts`) — parses `v/vn/f` (triangulates polygon fans),
   recovers area-weighted normals when absent, and fits the mesh to a unit box so
   any pasted model drops straight into a scene.
4. **Preetham sky** (`sky.ts`) — the analytic all-weather daylight model (Perez
   distribution + zenith chromaticity from turbidity & sun elevation), xyY→linear
   RGB, plus a sun disc. A new `sky` environment kind.
5. **Environment light + sun NEE** — any environment with a sun (the daylight
   gradient or the Preetham sky) becomes a *sampled* light: NEE importance-samples
   the sun cone and MIS-weights it against BSDF sampling, and escaped rays are
   MIS-weighted back. Daylight scenes converge dramatically faster; full-sphere
   cone sampling reduces exactly to the white furnace (a new energy proof).
6. **Showcase scenes** — Sky Studio (meshes under the Preetham sky), Revolution
   (lathed goblets + torus), and a paste-your-own Custom OBJ stage.
7. **Verification** — new proofs: smooth-normal interpolation, icosphere normals +
   Euler characteristic, OBJ cube round-trip, torus normal sanity, sky radiance
   positivity/ordering, env-sun sampler↔pdf + cone solid angle, and an
   env-importance-sampled white furnace.
8. **UI / About** — interactive sun (azimuth/elevation/turbidity) for sky scenes,
   an OBJ paste box, and About cards for the new physics.

## Roadmap — 2026-06-14 substantial-improvement pass (claude)

The plan, broken into shippable steps. Each is wired through the engine, the
verification suite, the scene registry, and the UI so it is observable and proven:

1. `texture.ts` — serialisable procedural `Texture` (checker / grid / marble) evaluated
   in world space; diffuse + metal carry an optional `tex`. Resolved per-vertex so the
   BSDF math is untouched. Self-tests for pattern parity and range.
2. `spectrum.ts` — `cauchyIor(base, B, λ)` dispersion + `wavelengthToRGB` with a
   white-point normalisation so a flat spectrum reconstructs to neutral white. Self-tests
   for the white point and that blue refracts more than red.
3. Rough dielectric in `material.ts` — GGX-VNDF microfacet reflect/refract, stochastic
   Fresnel, height-correlated Smith throughput (frosted glass). Energy-bound self-test.
4. Beer–Lambert in `integrator.ts` — track the interior medium, attenuate β by
   exp(−σ·t) across glass; spectral hero-wavelength sampling lazily on the first
   dispersive interaction. Attenuation self-test.
5. `scenes.ts` — Prism (dispersion), Glass Menagerie (roughness + absorption sweeps),
   Textured Studio (checker floor + marble sphere).
6. Per-pixel variance: the renderer keeps Σx², derives a relative-error map, exposes a
   live **noise heatmap** display mode and a convergence read-out, and stops dispatching
   to bands that have converged below an adjustable threshold (adaptive early-out).
7. UI + About + verification copy updated to cover the new physics.

## Session log

- 2026-06-26 (claude/claude-opus-4-8): **Lumen 20.0 — direct light on every shape: sphere-light NEE.**
  Closed the longest-standing gap in Lumen's light sampling: until now NEE could connect only to
  **triangle** emitters, so an emissive **sphere** was invisible to it and rendered as a firefly storm
  (the *Glowing Orb* premise). New `src/engine/spherelight.ts` samples the **cone a sphere subtends**
  (PBRT *Sampling Spheres*): `cosθ_max=√(1−R²/d²)`, uniform within, pdf `1/Ω`, `Ω=2π(1−cosθ_max)`, with
  a closed-form near-hit distance robust at the grazing cone edge. Wired into `scene.ts` behind a
  `useSphere` flag threaded through `sampleLight`/`lightPdf`/`envSunPdf` (spheres join the uniform 1/N
  pool as a residual slot beside the light-tree triangles and the env sun; an `effLightCount` keeps
  every denominator consistent) — OFF is **byte-for-byte**, so all 98 prior proofs stay green. The
  same Ω drives the BSDF-hit MIS weight, and the medium in-scattering NEE inherits it for free. New
  `sphereLights` setting + "Sphere lights (cone NEE)" toggle, on by default for two new scenes (**Plasma
  Lamps**, **Firefly Swarm**). **Six new proofs (104 total):** the subtended-cone Ω and its
  inverse-square limit; the cone sampler ↔ its pdf (`∫_cone dω=Ω`, all rays hit, `pdf≡1/Ω`); the
  directional pdf integrates to 1 over S²; the headline **analytic form-factor oracle** (cone-NEE mean
  = `ρ·L·sin²θ_max·cosθ_c` to 0.4 SE) with a measured **>100,000× variance drop** vs naive hemisphere
  sampling; **MIS consistency** (sampler pdf = `scene.lightPdf` to machine ε); and the horizon/inside
  guards. Verified in Node (104/104 self-tests pass); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-25 (claude/claude-opus-4-8): **Lumen 14.0 — importance sampling of many lights (the light
  BVH).** Replaced uniform NEE light selection (`scene.sampleLight`'s `rng.int(numLights)`) with a
  production-grade **light BVH** (Conty Estevez & Kulla 2018). New `src/engine/lighttree.ts`: a binary
  tree over the emissive triangles caching per-node power, bounds and a **normal cone** (PBRT
  `DirectionCone` union), a stochastic root→leaf `sample(p)` weighted by `power·orient(p)/dist²(p,box)`
  and a matching `prob(p, primId)` for the MIS pdf. Wired into `scene.ts` behind a `useTree` flag:
  the uniform path is kept **byte-for-byte** (default → 0 regression), the tree path keeps the env
  sun's `1/numLights` slot and distributes the triangle pool by importance, so it **reduces to
  uniform** when importances are equal. A `manyLights` flag on `IntegratorSettings` routes the path
  tracer's three NEE call sites (so 'pt'/'guided'/'pssmlt' get it; 'bdpt'/'sppm' sample lights their
  own way and are untouched). Two scenes — **Star Field** (a canopy of ~240 jewel-coloured emitters)
  and **Lantern Hall** (a colonnade of warm lanterns) — both default the new **Many lights (light
  BVH)** UI toggle on; About card added. Five new proofs (75 total): Σpdf=1 (machine ε), positivity
  (⇒ unbiased), sampler↔pdf, exact reduction-to-uniform on coincident lights, and the headline
  same-mean + ~700× variance cut on a many-lights scene. Verified end to end in a Node (rolldown)
  bundle: **75/75** self-tests pass, and a 16-spp A/B render shows the tree cutting whole-image noise
  ~2–2.5× at equal samples on both new scenes with matching means. `node scripts/verify-project.mjs`
  green (scope + conformance + lint + tsc + build).

- 2026-06-23 (claude/claude-opus-4-8): **Lumen 13.0 — practical path guiding (the SD-tree).** Added a
  fifth light-transport integrator that *learns* its sampling distribution online. New
  `src/engine/guiding.ts`: a directional quadtree (`DTree`) over an equal-area sphere↔square map
  (building/sampling double-buffer, flux-threshold refinement, exact sample/pdf/record) and a spatial
  binary k-d tree (`Guide`) whose leaves each own a `DTree` and subdivide by visit count. Threaded an
  optional `guide` through `integrate`/`radiance`: at each guidable (opaque, non-delta) vertex the
  next direction is drawn from the mixture `α·p_bsdf+(1−α)·p_guide` and the path's downstream incident
  radiance is recorded back into the tree; NEE/emission MIS weights use the same mixture pdf, so it
  stays unbiased and MIS-consistent. Iteration refinement is wired into the worker pool *and* the
  single-thread fallback at power-of-two sample boundaries; `Scene` now exposes its `bounds` (BVH
  root). UI: a new **Guided** integrator option + an About card; two scenes — **Glowing Orb** (lit
  only by a NEE-invisible emissive sphere, guiding's clear win) and **Hidden Door** (two-chamber
  indirect). Three engineering fixes turned a net-negative naive PPG into a real win: per-leaf
  *maturity gating* (an under-trained tree samples ~uniformly, which hurts → fall back to BSDF),
  *visit-driven* spatial subdivision (the tree grew from 2 → ~270 leaves), and a gentle **α=0.7**
  (the piecewise-constant guide is noisy, so a 30 % nudge wins where light is hard to find and is
  neutral elsewhere). Four new proofs (74 total): DTree density ∫=1 over the sphere, sampler↔pdf to
  machine ε, ~100× variance cut on a peaked directional integral, and **Guided ≡ PT** on the diffuse
  box. Verified in Node (esbuild bundle): 70/70 self-tests pass, Guided agrees with PT to <2 % on the
  box, and an equal-sample Glowing-Orb bench shows ≈1.13–1.25× lower RMSE with no bias.
  `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-23 (claude/claude-opus-4-8): **Lumen 12.0 — subsurface scattering (light that lives inside
  a surface).** Closed the last gap between Lumen's *transport* and its *materials*: a dielectric can now
  carry an `interior` scattering medium (`Subsurface { sigmaT, albedo, g }`), turning glass into a
  *translucent solid* — marble, jade, wax, skin. The integrator random-walks **inside** the object,
  bounded by the real surface geometry: homogeneous free-flight (distance ∼ e^(−σ_t·t)), a collision
  scatters via the Henyey–Greenstein phase function (β ×= the single-scattering albedo, whose per-channel
  shape *is* the translucency's hue), and reaching the boundary refracts the path out or
  total-internally-reflects it back in through the existing smooth/rough dielectric BSDF. Phase-only
  (no interior NEE) — the surrounding scene's NEE takes over once the path exits, so the estimator stays
  unbiased. Two showcase scenes — **Subsurface Studio** (a back-lit row of marble/jade/honey-wax/rose
  spheres glowing from within) and **Jade Idol** (a hand-turned translucent lathe figurine) — plus
  **five** new proofs: a pure-scattering index-matched furnace returns *exactly* 1 for any phase g
  (zero variance — every path yields 1); a pure-absorbing interior reproduces Beer's law e^(−σ·2r) from
  the free-flight sampler; the **whole** translucent object (real Fresnel boundary + TIR + multiple
  scattering) conserves energy to ≈1; and a per-channel albedo tints the exitance R>G>B (the marble/jade
  mechanism), all bounded ≤1, and the reflectance rises strictly with the interior albedo. Verified in
  Node by bundling the suite with Vite: **66/66** self-tests +
  a render smoke-test of both scenes (finite, fully lit, no leaks through the 1.7k-triangle lathe);
  `pnpm lint`/`tsc`/`build` green via the CI gate. Reuses the volume/phase machinery and changes nothing
  in the transport loop except the new interior walk, so all 61 prior proofs stay green.
- 2026-06-21 (claude/claude-opus-4-8): **Lumen 11.0 — real metals from measured complex IOR.** Replaced
  the Schlick-from-RGB metal Fresnel with measured η(λ)/k(λ) spectra (gold/silver/copper/aluminium/iron/
  chromium) + the exact unpolarised conductor Fresnel, evaluated at the path's committed hero wavelength
  so a metal's hue emerges spectrally (the same machinery that disperses glass). New `conductor.ts`; a
  shared `FresnelSpec` threads complex-IOR through the single-scatter, anisotropic and Kulla–Conty
  multiscatter lobes alike; gated behind an optional `spectrum` field so all 55 prior proofs stay
  bit-for-bit green. New **Metals of the World** scene + an About card + **six** proofs (R∈[0,1] &
  grazing→1; k→0 reduces *exactly* to the dielectric Fresnel; textbook colours; a furnace render
  reconstructing the measured RGB; sampler↔pdf↔weight MIS consistency; spectral multiscatter energy
  bounded by F̄). Verified in Node: **61/61** self-tests + a Metals smoke render (finite, lit,
  chromatic); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 10.0 — a physically based material system.** Made the
  *surfaces* as rigorous as the transport. (1) **Energy-conserving rough metal**: a Kulla–Conty
  multiscatter compensation lobe driven by a start-up-built GGX directional-albedo table `E(μ,α)`/
  `Eavg(α)` (integrated via the white-lobe VNDF throughput `G2/G1`), with a coloured multiscatter
  Fresnel so rough conductors recover their dropped energy and stop going grey. (2) **Anisotropic
  GGX** (brushed metal): anisotropic D / Smith Λ / VNDF with two roughness axes in a rotatable
  tangent frame; the isotropic case reduces exactly to the old lobe so existing metals are untouched.
  (3) **Oren–Nayar** rough diffuse (`sigma`) for chalk/clay/plaster. (4) **Clear-coat** layered
  materials (`coat`): a GGX dielectric gloss over a Lambert/Oren–Nayar base, both lobes Fresnel-
  sampled with a combined pdf so the stack is energy-conserving *and* MIS-consistent. All four ride
  as optional fields on the existing `diffuse`/`metal` kinds (no new union members → the integrators,
  BDPT and SPPM are untouched), and shared local-frame helpers keep `sample`/`eval`/`pdf` in lockstep.
  Three new scenes — **Brushed Metal**, **Rough Conductors** (single-scatter vs multiscatter split),
  **Ceramics & Clay** — and **six** new proofs plus a **BDPT≡PT oracle** over a box of all four
  materials (PT and BDPT agree to 0.4%). Verified in Node (55/55 self-tests + a 3-scene render smoke
  test, no NaNs, all lit); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 9.1 — emissive volumes (glowing fire / embers /
  nebulae).** Built straight on the 9.0 heterogeneous-media engine: a medium may now carry an
  `emission` radiance, and at every *real* collision the path collects `(σ_a/σ_t)·Lₑ =
  (1−albedo)·Lₑ` of self-emitted light, weighted by the throughput *before* the scattering albedo
  is applied. Because delta tracking makes real collisions density-proportional, the glow pools in
  the dense core of an fBm field and fades through the wisps — a soft, physically integrated
  fireball, no billboards. One surgical add in the integrator's medium-scatter branch; the
  homogeneous and non-emissive paths are untouched. New **Ember** scene (a warm self-luminous
  fBm fireball over a dim floor in a dark room) and **one new proof (49 total):** an
  absorbing+emitting volume against black obeys the emission–absorption law `(1−e^(−σ_t·chord))·Lₑ`
  exactly (measured 1.5983 vs 1.5962). Verified in Node (49/49 self-tests + an Ember smoke render:
  finite, glowing core max 3.2, self-shadowing); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-20 (claude/claude-opus-4-8): **Lumen 9.0 — heterogeneous participating media (clouds,
  smoke & layered fog) via delta & ratio tracking.** Turned the 4.0 *homogeneous* volumes (a sphere
  of constant fog) into real **heterogeneous** media whose extinction varies continuously through
  space. (1) **`noise.ts`** — a dependency-free 3D value-noise + fBm + domain-warp toolkit (hashed
  integer lattice, quintic-smoothstep interpolation), pure and allocation-free so the field
  evaluates identically on every worker. (2) **`MediumDef.density`** — an optional, structured-clone
  `DensityDef` union: `fbm` (cumulus/smoke — octaves, frequency, coverage threshold, soft spherical
  edge falloff, vertical bias, domain warp) and `layer` (an exponential vertical fog slab). Absent ⇒
  the 4.0 homogeneous behaviour, bit-for-bit. (3) **`volume.ts`** — compiles a `DensityDef` into a
  `DensityField` (`majorant` + `density(p)∈[0,1]`) bounded by the medium sphere. (4) **Scene** —
  `sampleMediumScatter` now **delta-tracks** heterogeneous media (Woodcock: analytic flights against
  the constant majorant σ̄=sigmaT, accept a *real* scatter with probability σ(x)/σ̄=density(x), else a
  *null* collision and continue) and `mediaTransmittance(…, rng)` **ratio-tracks** them
  (T̂=∏(1−σ(xᵢ)/σ̄), an unbiased estimator of e^(−∫σ ds) needing no closed form); the homogeneous path
  stays analytic. (5) **Integrator** — the only change is threading `rng` into the two
  `mediaTransmittance` calls (the collision branch already multiplies β by the albedo, the correct
  delta-tracking real-collision weight, and the camera path still needs no transmittance multiply
  because null collisions leave β unchanged). (6) **Three scenes** — **Cumulus** (a sunlit fBm cloud
  under the Preetham sky with a forward-scattering silver lining), **Smoke Plume** (a rising,
  vertically-biased, sooty column lit hard from the side — deep self-shadowed darks), **Drifting
  Fog** (an exponential ground-fog layer in a colonnade so the skylight breaks into god-rays grazing
  the fog top). (7) **UI** — the fog-density knob already scales the majorant; added a **Cloud
  coverage** control (offsets the fBm threshold to puff the cloud up or break it into scattered
  billows) and an About card on delta/ratio tracking. (8) **Five new proofs (48 total):** the noise
  field is bounded/continuous/deterministic/mean-½; delta tracking with a constant field reproduces
  e^(−σL) (reach 0.2474 vs 0.2466); ratio tracking on a varying exponential layer matches a fine
  quadrature of ∫σ ds (T̂=0.1657 vs e^(−τ)=0.1653, τ=1.80); delta tracking matches the same varying
  optical depth (reach 0.1663 vs 0.1653); and a heterogeneous pure-scattering fBm volume in a unit
  field conserves energy *exactly* (radiance through cloud = 1.0000) — the end-to-end oracle for the
  whole delta-tracking integrator. Verified in Node by bundling the engine with esbuild: 48/48
  self-tests, plus a smoke render of all three new scenes (all-finite, energetic, self-shadowing).
  `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-19 (claude/claude-opus-4-8): **Lumen 8.0 — a spectral, daylight-complete photon mapper.**
  Closed the two deliberate gaps in the 7.0 photon mapper. **(1) Spectral photons:** a photon now
  commits a random hero wavelength the first time it strikes a dispersive surface (reusing the path
  tracer's `isSpectral`/`wavelengthWeight`/`resolveMaterial(.,.,λ)` machinery verbatim), so it refracts
  per-colour and the caustic it deposits is a *rainbow* instead of white — and because the per-λ RGB
  weights average to (1,1,1), total energy is exactly preserved. The camera pass commits a wavelength
  symmetrically so a prism viewed directly disperses too. **(2) Environment/sun photons:** the scene's
  sun (a gradient sun or a Preetham sky, already an NEE light) is now also a photon source — photons
  leave a disc sized to the scene's bounding sphere, perpendicular to the sun, and rain in as a
  parallel beam, so daylight scenes finally get photon-mapped sun caustics and indirect light. The
  distant-light flux works out to `S = L·ΣW/lum(L_rep)`, the literal twin of the area-light formula
  (the disc-area πR² and cone solid-angle Ω cancel against the selection weight), so it's unbiased and
  needs no other code changes. **(3) Two scenes:** **Spectral Caustic** (a dispersive sphere + prism
  over a white floor → a rainbow caustic) and **Daylight Lens** (a glass sphere + gold torus under the
  sky → a sun caustic on a tiled floor). **(4) Four new proofs (43 total):** spectral photons conserve
  energy vs the achromatic twin (rel 0.22%); the spectral caustic carries real chromatic spread (0.69)
  while the achromatic one is exactly grey (0.00); env-sun photons match the path tracer on a sun-lit
  courtyard (rel 2.53%, pinning the distant-light flux normalisation); and the sun focuses a real
  caustic through glass (≈8.7× the lit floor). Verified in Node by bundling the engine with Vite:
  43/43 self-tests, plus a smoke render of both new scenes (all-finite, energetic, hundreds of
  chromatic caustic pixels). `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-16 (claude/claude-opus-4-8): **Lumen 7.0 — stochastic progressive photon mapping (SPPM).**
  Added a *fourth* light-transport integrator, the one built for **caustics** — light focused through
  glass onto a diffuse surface (a light→specular→diffuse path), which all three existing integrators
  sample terribly because next-event estimation can't connect through the refractive interface. SPPM
  runs the transport *backwards*: (1) `sppm.ts` emits photons from the area lights (power-sampled, so
  every photon carries equal flux), traces them through the specular geometry reusing the existing
  `Scene`/BSDF/medium code verbatim, and deposits them at non-specular surfaces; (2) each pass
  re-traces *jittered* camera rays (the "stochastic" in SPPM — anti-aliases + handles glossy/DoF
  visible points), follows specular bounces, and stores the first diffuse hit as a per-pixel
  measurement point; (3) the photons are gathered through an exact CSR **spatial hash** (`HashGrid`)
  and each point's gather radius is shrunk on the Hachisuka schedule `R²←R²·(N+αM)/(N+M)`, which
  drives the density-estimation bias to zero so the estimate **converges**. (4) SPPM is a full-frame
  estimator like PSSMLT, so the worker + renderer were generalised behind a small `FrameEstimator`
  interface (each worker runs an independent full-frame SPPM; the UI averages them by passes). (5) A
  fourth **Integrator** option ("Photon Map"), a "Passes" progress readout, an About card, the
  footer. (6) A new **Caustic Pool** scene — a sine-ripple water surface (a single refractive sheet
  with *analytic* smooth normals) over a tiled floor — that throws the shifting bright filaments of a
  swimming pool. (7) **Three new proofs (39 total):** the headline is **SPPM ≡ the path tracer** on
  the diffuse Cornell box (global brightness *and* top/bottom spatial ratio agree to ~2.6% — a strict
  check since SPPM shares no transport-loop code with PT, so this pins the photon-power
  normalisation and the radius/flux update); plus SPPM resolves a finite, focused caustic under a
  glass lens; and the photon-gather grid returns *exactly* the in-radius points vs brute force over
  2000 random probes. Verified in Node by bundling the engine with Vite: 39/39 self-tests, plus a
  Caustic-Pool SPPM smoke render (7210 tris, all-finite, bright caustic filaments). `pnpm
  lint`/`tsc`/`build` green via the CI gate.
- 2026-06-16 (claude/claude-opus-4-8): **Lumen 6.0 — Metropolis light transport (PSSMLT).** Added a
  *third* light-transport integrator, and a fundamentally different one: where the path tracer and
  BDPT average independent samples, PSSMLT runs a **Markov chain** through path space so it lingers
  wherever light is and refines the hardest-to-find transport (caustics, indirect-only rooms) far
  faster. The whole thing reuses the path tracer **verbatim** — a path tracer is a function from a
  vector of uniform randoms to a colour, so the new `PssmltSampler` simply *is* the RNG (`extends
  Rng`, overriding `next()` to return coordinates of a mutatable primary-sample-space vector with
  Kelemen lazy mutation: per-coordinate modify-times, large/small steps, wrapped-Gaussian
  perturbations, accept/reject backup-restore). `MltState` owns the chains and the splat buffer: a
  **bootstrap** estimates the absolute image brightness `b = E[I]` and seeds chains in proportion to
  contribution; each mutation does **expected-value splatting** (`L/I` weighted by the
  Metropolis–Hastings accept probability `min(1,I′/I)`) at both endpoints; `image()` renormalises by
  `b·nPixels/mutations`. It runs across the **worker pool** (each worker = independent chains over
  the whole image; the UI shows their mutation-weighted average, each estimate independently
  unbiased) with a single-thread fallback for the sandboxed thumbnail. UI: a "Metropolis" integrator
  option, a mutations-per-pixel read-out, an About card, the footer. **Three new correctness proofs
  (36 total):** the sampler is a valid uniform sampler (mean ½, var 1/12) + deterministic; PSSMLT
  energy-conserves on a white furnace (rel 0.04%); and PSSMLT converges to the **same image** as the
  path tracer on the Cornell box (global brightness rel 0.7% *and* top/bottom spatial ratio rel
  0.4%). Verified in Node (36/36 self-tests + a 14-scene PSSMLT smoke render: no NaNs, image-mean ==
  b on every scene incl. spectral/volumetric/thin-film); `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-15 (claude/claude-opus-4-8): **Lumen 5.0 — bidirectional path tracing.** Added a second,
  selectable light-transport integrator alongside the unidirectional path tracer: a full
  **Veach–Guibas BDPT** (`bdpt.ts`). It grows a camera subpath and a light subpath, then forms every
  connection strategy — `s=0` (camera path hits an emitter), `s=1` (≡ next-event estimation) and the
  general `s≥2` vertex-to-vertex connection — and weights them all with a faithful port of pbrt's
  **balance-heuristic MIS recurrence** (per-vertex area-measure forward/reverse densities, the four
  connection-time reverse-density overrides, delta vertices transported but never connected). It is
  "BDPT without light tracing" (camera-subpath length `t≥2`): every connection lands in the current
  pixel, so it dropped into the band-worker render loop with **zero protocol changes**, and marking
  the lens vertex as a delta endpoint removes the `t=1` technique from the MIS partition (still a
  valid partition of unity, still unbiased, still matching the path tracer — and it sidesteps the
  camera-importance `Wₑ` math, which provably never enters the weight for `t≥2`). While wiring it up
  I also fixed a latent inconsistency in the unidirectional integrator: BSDF-hit **emission is now
  one-sided** (winding-front only), matching what the NEE light sampler already required, so the two
  estimators agree term for term. New **Cove** scene — an emitter hidden in an uplight cove so the
  room is lit almost entirely by bounced light, the textbook regime where BDPT crushes the path
  tracer's variance (measured ≈3× lower per-sample variance at equal settings). UI: an **Integrator**
  segmented control (Path Tracer | Bidirectional) + an About card. **Four new correctness proofs
  (33 total):** BDPT white-furnace energy (ρ recovered to 0.8000); the **oracle** — BDPT's mean image
  equals the path tracer's on a diffuse box (1.0% at 280 spp, shrinking as 1/√n); **MIS weights
  partition to 1** on a fixed path (residual = 0, exactly); and the solid-angle→area density
  conversion. Verified end to end in Node by bundling the engine with rolldown — all 33 self-tests
  pass and BDPT↔PT agree to <0.5% at 3000 spp on both the diffuse box and the full Cornell box (with
  mirror + glass), no NaNs; `pnpm lint`/`tsc`/`build` green via the CI gate.
- 2026-06-14 (claude): Built Lumen end to end — full CPU path tracer (BVH, microfacet BSDFs,
  NEE+MIS, RR), worker pool with single-thread fallback, denoiser, tone mapping, 4 scenes, orbit
  camera/DoF, verification suite, and the React studio UI. Lints + builds clean via the CI gate.
- 2026-06-14 (claude): Substantial physics pass. Added (1) procedural world-space textures
  (`texture.ts`: checker / grid / value-noise marble), (2) rough microfacet dielectrics for frosted
  glass (GGX-VNDF reflect/refract), (3) Beer–Lambert volumetric absorption for physically coloured
  glass (medium tracking in the integrator), (4) spectral dispersion (`spectrum.ts`: Cauchy IOR +
  white-point-normalised wavelength→RGB, hero-wavelength sampling) producing prism rainbows, and
  (5) adaptive variance-guided sampling with a live per-pixel noise (relative-error) heatmap and a
  convergence read-out. Three new scenes (Prism, Glass Menagerie, Textured Studio) and six new
  correctness proofs (16 total) — all pass. Verified numerically in Node by bundling the engine with
  rolldown and running the self-tests + a 7-scene render smoke test (no NaNs); `pnpm lint`/`build`
  green via the CI gate.
- 2026-06-14 (claude/claude-opus-4-8): **Lumen 3.0 — meshes, sky & sun NEE.** Turned the
  sphere-and-flat-triangle tracer into a real geometry + daylight renderer. Added (1) **smooth
  triangle meshes**: the triangle primitive now carries per-vertex normals, `intersectTriangle`
  returns barycentrics, and `Scene.intersect` blends them into a shading normal oriented to the
  geometric hemisphere (geometric normal still drives offsets/front-face). (2) A **mesh library**
  (`mesh.ts`) — icosphere (recursive subdivision), uv-sphere, torus and surface-of-revolution with
  exact/area-weighted normals, an affine transform with inverse-transpose normal handling, and a
  smooth-tri emitter. (3) An **OBJ importer** (`obj.ts`) — v/vn/f with polygon-fan triangulation,
  area-weighted normal recovery, and auto-fit to a unit box. (4) The **Preetham analytic sky**
  (`sky.ts`) — Perez distribution + zenith chromaticity from turbidity & sun elevation, xyY→linear
  RGB, plus a solar disc; a new `sky` env. (5) **Environment / sun next-event estimation** — any
  env with a sun (the daylight gradient or the sky) is now a *sampled* light: NEE importance-samples
  the sun cone and MIS-weights it against BSDF sampling, with escaped rays MIS-weighted back, so
  daylight scenes converge in a handful of spp. (6) Three scenes — **Sky Studio**, **Revolution**
  (lathed goblets), **Custom OBJ** (paste your own). (7) **Fixed a latent BVH robustness bug**:
  axis-aligned planar faces (floor/wall quads, coplanar facets) had zero-thickness AABBs that the
  slab test rejected, so such a face only rendered when its BVH leaf happened to also hold a
  non-coplanar primitive — now degenerate-thin bounds are padded. (8) Seven new correctness proofs
  (23 total): smooth-normal interpolation, icosphere radial normals + Euler χ=2, OBJ cube
  round-trip, torus normals, Preetham positivity/ordering, env-sun sampler↔pdf + cone solid angle,
  and an env-importance-sampled white furnace (ρ recovered exactly). (9) UI: interactive sun
  (azimuth/elevation/turbidity) for sky scenes, an OBJ paste box, and new About cards. Verified
  numerically in Node by bundling the engine with Vite and running all 23 self-tests (23/23) + a
  10-scene render smoke test (no NaNs, all lit); `pnpm lint`/`build` green via the CI gate.
- 2026-06-15 (claude/claude-opus-4-8): **Lumen 4.0 — participating media, thin-film iridescence
  & quasi-Monte-Carlo sampling.** Made the *space between surfaces* and a *wave-optics* material
  physical. (1) **Participating media** (`phase.ts`, `MediumDef`, scene + integrator): bounded
  homogeneous volumes (fog/smoke/cloud). The integrator samples a free-flight distance from the
  medium's transmittance; a collision before the next surface makes the path scatter *inside* the
  volume — in-scattering NEE through the **Henyey–Greenstein** phase function (phase↔light MIS, with
  shadow rays attenuated by `mediaTransmittance` so volumetric shadows/god-rays form), then a
  phase-importance-sampled new direction. A scalar extinction with a coloured single-scattering
  albedo keeps the distance estimator unbiased (no spectral MIS) and the analytic boundary weights
  cancel, so surfaces *seen through* a volume need no transmittance multiply on the camera path.
  Surface NEE is media-attenuated too. (2) **Thin-film interference** (`thinfilm.ts`, a `thinfilm`
  `Material`): the iridescence of soap bubbles / oil / anodised metal as exact two-interface **Airy
  reflectance** (s+p averaged) at the path's committed hero wavelength — a delta-specular coating
  whose reflectance is wavelength-dependent, so the existing dispersion machinery turns it into a
  full iridescent colour (`isSpectral` now drives the wavelength commit for both dispersive glass
  and films). (3) **Low-discrepancy primary sampling** (`qmc.ts`): the camera sub-pixel jitter and
  the depth-of-field lens are now drawn from a **scrambled Halton** sequence with a per-pixel
  Cranley–Patterson rotation (deeper bounces keep their RNG stream), so AA and bokeh converge
  faster. Three new scenes — **Cathedral** (banded god-rays through forward-scattering haze),
  **Iridescence** (a thin-film thickness sweep — soap-bubble to beetle-shell colour), **Nebula** (a
  coloured single-scattering orb beside an iridescent sphere). UI: a live fog-density control for
  volumetric scenes + three new About cards. **Six new correctness proofs (29 total):** HG phase
  normalisation/sampler↔pdf/mean-cosine (E[cosθ]=−g), homogeneous transmittance = e^(−σ_t·L), a
  pure-scattering volume conserving energy (radiance = 1 in a unit field), an absorbing volume =
  e^(−σ_t·chord), thin-film R∈[0,1] with the d→0 limit collapsing to the bare-interface Fresnel
  (err 5.6e-17) and R(λ) iridescent, and Halton L2 star-discrepancy 4× below random. Verified in
  Node (29/29 self-tests + a 13-scene render smoke test: no NaNs, all lit); `pnpm lint`/`tsc`/`build`
  green via the CI gate.
